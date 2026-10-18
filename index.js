/**
 * dsh-workspace-gate —— Host 侧。
 *
 * 一句话：插件照常加载，但在每个 agent 建立的那一刻，按这个 agent 的工作区
 * 把它不该看见的工具 schema 和系统提示词段从"模型可见面"上摘掉。
 *
 * 两条动作路径，都是 DSH 自己的机制，没有一处绕过去改 profile：
 *   - 工具：`agent.ctx.tools.restrict({ deny })`（最弱机制，只减不加）；
 *   - 提示词段：在 agent 作用域注册一个**同名空文本段**，遮蔽全局那一段。
 *
 * 两个坑（都已实测确认，写在这里免得后人再踩）：
 *   1. 绝大多数工具**不在全局视图里**——它们由 agent preset 在自己的作用域注册，
 *      所以 `tools.schemas(undefined)` 只能看到 19 个，而 agent 实际看得见 59 个。
 *      要拿全量清单，得按 preset 逐个 `agentPresets.acquireScope(id)` 再查。
 *   2. `systemPrompt.assemble()` 是 **async** 的，不 await 只会拿到一个空对象。
 *
 * 人类操作的界面在 client.js（插件页的「按工作区」tab）；
 * 它和这里通过本插件自注册的 HTTP 路由通信，因为第三方插件的 Host 服务
 * 无法凭空长出一个 remote namespace。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import {
  applyAssignments,
  attribute,
  emptyStore,
  normalizeDir,
  normalizeStore,
  pickDir,
  resolveHidden,
  withAssignments,
  withHidden,
} from './lib/policy.mjs';

export const name = 'workspace-gate';
export const inject = ['tools'];

const TOOL_NAME = 'workspace_gate';
const ROUTE = '/workspace-gate';
/** 这两个名字永远不许被隐藏：run_code 是传输层，workspace_gate 是本插件自己的入口。 */
const RESERVED = new Set(['run_code', TOOL_NAME]);
/** 这些"组"是插件自己，不该出现在可勾选列表里。 */
const RESERVED_GROUPS = new Set(['workspace-gate', 'dsh-workspace-gate']);
const INVENTORY_TTL_MS = 15_000;

function dataDir() {
  const root = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh');
  return join(root, 'data');
}

function storeFile() {
  return join(dataDir(), 'workspace-gate.json');
}

/** 静态扫描的硬上限：单个入口文件超过这个大小就不读，避免被大包拖慢。 */
const SCAN_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 只认"工具定义位"的字面量：`name: 'tool_name'`。
 * 宽松地匹配任意引号字符串会把 `'read'`、`'write'` 这种别处的用法也算进来
 * （实测 dsh-context 源码里就出现过这几个词），所以必须收紧。
 */
const NAME_DEF = /name\s*:\s*['"]([a-z][a-z0-9_.-]{1,48})['"]/g;

/**
 * 宿主进程里 `DSH_PROFILE_DIR` 不一定设着，所以按"枚举 profile 目录 + 若干兜底"
 * 找包的安装位置。
 */
function packageRoots() {
  const roots = [];
  const home = homedir();
  const base = join(home, '.dsh', 'profiles');
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(base, entry.name));
    }
  } catch {
    /* 没有 profiles 目录也不要紧 */
  }
  roots.push(join(home, '.dsh'));
  try {
    roots.push(process.cwd());
  } catch {
    /* ignore */
  }
  return roots;
}

/** 包名 → 安装目录；找不到返回空串。 */
function resolvePackageDir(packageName) {
  const segments = String(packageName ?? '').split('/').filter(Boolean);
  if (!segments.length) return '';
  for (const root of packageRoots()) {
    const dir = join(root, 'node_modules', ...segments);
    try {
      if (statSync(join(dir, 'package.json')).isFile()) return dir;
    } catch {
      /* 下一个 */
    }
  }
  return '';
}

/**
 * 包目录 → 候选源文件。`deep` 时把 lib / lib/tools 里的模块也纳入
 * （有的插件把工具拆在兄弟文件里定义，只看入口会漏）。
 */
function packageSources(dir, deep) {
  const files = [];
  const push = (file) => {
    if (!files.includes(file)) files.push(file);
  };
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    let main = typeof pkg.main === 'string' ? pkg.main : '';
    const exp = pkg.exports;
    if (!main && typeof exp === 'string') main = exp;
    if (!main && exp && typeof exp === 'object') {
      const dot = exp['.'] ?? exp;
      if (typeof dot === 'string') main = dot;
      else if (dot && typeof dot === 'object') main = dot.import ?? dot.default ?? dot.require ?? '';
    }
    if (main) push(join(dir, main));
  } catch {
    /* 元数据坏了就只试默认位置 */
  }
  push(join(dir, 'lib', 'index.js'));
  push(join(dir, 'index.js'));
  push(join(dir, 'dist', 'index.js'));

  if (deep) {
    // 递归收 js（有的包把工具定义在 dist/agent/*.js、lib/lib/*.js 这种深层目录里），
    // 深度与文件数都设上限，避免被大包拖死
    collectJsFiles(dir, 0, files, 40);
  }
  return files;
}

/** 递归收集 .js/.mjs/.cjs，跳过 node_modules，深度与数量双限。 */
function collectJsFiles(dir, depth, out, max) {
  if (depth > 3 || out.length >= max) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= max) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') collectJsFiles(full, depth + 1, out, max);
    } else if (/\.(m?js|cjs)$/.test(entry.name)) {
      if (!out.includes(full)) out.push(full);
    }
  }
}

function loadStore() {
  try {
    return normalizeStore(JSON.parse(readFileSync(storeFile(), 'utf8')));
  } catch {
    return emptyStore();
  }
}

function saveStore(next) {
  const file = storeFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 工具返回值必须是无损 JSON：宿主对象（含 prototype/Map）直接回传会被校验拒掉。 */
function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { error: '返回值无法序列化为 JSON' };
  }
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 插件行的展示名：`meta.title` 是 {en,zh} 字典，优先中文；不像人话就退回 patchId。 */
function pluginTitle(entry, fallbackId) {
  const title = entry?.meta?.title;
  let text = '';
  if (typeof title === 'string') text = title;
  else if (title && typeof title === 'object') text = title.zh || title.en || '';
  if (!text) return '';
  const moduleName = String(entry?.moduleName ?? '');
  // 有些行的 meta.title 直接就是包名，显示出来比 id 还难看，退回 id
  if (text === moduleName || text.startsWith('@') || text.includes('/')) return '';
  if (fallbackId && text === fallbackId) return '';
  return text;
}

/**
 * 找出这个 agent 的 cwd。`Agent` 的公开接口只有 `{ id }`，所以按从直觉到兜底
 * 挨个试；全都不中时用 workspaceRegistry 的 sessionIds 反查。
 * 查不到就返回空串 —— 调用方据此不干预（fail-open）。
 */
function agentCwd(ctx, agent) {
  const attempts = [
    () => agent?.session?.header?.cwd,
    () => agent?.session?.cwd,
    () => agent?.ctx?.session?.header?.cwd,
    () => agent?.ctx?.get?.('session')?.header?.cwd,
    () => {
      const wd = agent?.ctx?.get?.('workingDirectory') ?? ctx.get('workingDirectory');
      const session = agent?.session ?? agent?.ctx?.get?.('session');
      return session ? wd?.get?.(session) : undefined;
    },
  ];
  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (typeof value === 'string' && value) return value;
    } catch {
      /* 下一个 */
    }
  }
  try {
    const registry = ctx.get('workspaceRegistry');
    const id = agent?.id;
    for (const ws of registry?.list?.() ?? []) {
      if (Array.isArray(ws?.sessionIds) && id && ws.sessionIds.includes(id)) {
        if (typeof ws.path === 'string' && ws.path) return ws.path;
      }
    }
  } catch {
    /* 放弃 */
  }
  return '';
}

export function apply(ctx) {
  let store = loadStore();
  let pluginList = [];
  let bundleList = [];
  let pluginFetchedAt = 0;
  let inventoryCache = null;
  let inventoryAt = 0;
  let attributionCache = null;
  const disposers = new Map();
  const bound = new Map();

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[workspace-gate] ${message}`);
    } catch {
      /* 日志也不能把门控弄挂 */
    }
  };

  const get = (service) => {
    try {
      return ctx.get(service);
    } catch {
      return undefined;
    }
  };

  /** 全局工具视图（不含 preset）——只用来兜底。 */
  const globalToolSchemas = () => {
    try {
      const list = get('tools')?.schemas?.(undefined) ?? [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  const schemasFor = (scope) => {
    try {
      const list = get('tools')?.schemas?.(scope) ?? [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  /** assemble 是 async —— 不 await 只会拿到空对象，这是踩过的坑。 */
  const sectionsFor = async (scope) => {
    const prompt = get('systemPrompt');
    if (!prompt?.assemble) return [];
    try {
      const assembly = await prompt.assemble(scope === undefined ? {} : { scope });
      const list = assembly?.sections;
      if (!Array.isArray(list)) return [];
      return list
        .filter((s) => s && typeof s.name === 'string' && String(s.text ?? '').trim())
        .map((s) => ({ name: s.name, chars: String(s.text).length }));
    } catch (error) {
      warn(`读取提示词段失败：${error?.message ?? error}`);
      return [];
    }
  };

  const refreshPlugins = async (force = false) => {
    if (!force && Date.now() - pluginFetchedAt < INVENTORY_TTL_MS) return pluginList;
    attributionCache = null;
    try {
      const manager = get('pluginManager');
      const list = manager?.listPlugins ? await manager.listPlugins() : [];
      pluginList = Array.isArray(list) ? list : [];
      // bundle 清单用来判来源：availability=profile 就是用户装的，installation 是随 dsh 来的
      const bundles = manager?.listBundles ? await manager.listBundles() : [];
      bundleList = Array.isArray(bundles) ? bundles : [];
    } catch (error) {
      warn(`读取插件清单失败：${error?.message ?? error}`);
      pluginList = [];
      bundleList = [];
    }
    pluginFetchedAt = Date.now();
    return pluginList;
  };

  /** 一条插件行属于哪个 bundle（按 moduleName，其次 entryId）。 */
  const bundleFor = (entry) => {
    const mod = String(entry?.moduleName ?? '');
    const entryId = String(entry?.entryId ?? '');
    for (const bundle of bundleList) {
      for (const row of bundle?.rows ?? []) {
        if ((mod && row?.moduleName === mod) || (entryId && row?.entryId === entryId)) return bundle;
      }
    }
    return undefined;
  };

  /**
   * 来源判定（实测口径）：
   *   availability === 'profile'     → 用户自装（带 source：pkg@range 或 link:本地路径）
   *   official === true              → 随 dsh 发行的可选/实验包（官方页那栏「实验性」）
   *   availability === 'installation'→ 随 dsh 安装的内置包
   * 注意 `official` 不能直接当"是否官方"用：dsh-base / dsh-web-app 反而是 false。
   */
  const originOf = (entry) => {
    const bundle = bundleFor(entry);
    if (!bundle) return 'unknown';
    if (bundle.availability === 'profile') return 'user';
    if (bundle.official === true) return 'experimental';
    if (bundle.availability === 'installation') return 'official';
    return 'unknown';
  };

  /** 插件行 → {id, title, aliases, origin}；id 优先 patchId，`include:` 前缀去掉。 */
  const pluginRefs = () =>
    pluginList
      .filter((entry) => {
        const mod = String(entry?.moduleName ?? '');
        if (!mod || mod === 'cordis:include') return false; // 组合包的 include 行，不是插件
        return true;
      })
      .map((entry) => {
        const raw = String(entry?.patchId ?? entry?.entryId ?? '');
        const id = raw.replace(/^include[:\-]/i, '');
        const moduleName = String(entry?.moduleName ?? '');
        return {
          id,
          title: pluginTitle(entry, id),
          // patchId 与包名经常对不上（dsh-free-search 的行 id 是 web-search-free），
          // 包名一并当匹配别名，工具才不会全掉进"未归属"
          aliases: moduleName ? [moduleName] : [],
          origin: originOf(entry),
        };
      })
      .filter((entry) => entry.id && !entry.id.startsWith('cordis:'));

  /**
   * 静态扫包归属：运行时不给"工具属于谁"，那就去包源码里找字符串字面量。
   * 只在**唯一命中**时采纳——多个包都含这个名字就宁可留在未归属，也不乱指。
   * 结果按进程缓存（200 个包扫一遍约几百毫秒），`/refresh` 时失效。
   */
  const scanAttribution = (names) => {
    const map = new Map();
    if (!names.length) return map;
    if (attributionCache) return attributionCache;
    const wanted = new Set(names);
    const hits = new Map();
    for (const ref of pluginRefs()) {
      const pkg = ref.aliases[0];
      if (!pkg) continue;
      const dir = resolvePackageDir(pkg);
      if (!dir) continue;
      // 第三方包多扫几个文件（工具常被拆在 lib/*.js 里）；官方包只看入口，控制耗时
      const deep = ref.origin === 'user';
      const literals = new Set();
      let budget = 4 * 1024 * 1024;
      let count = 0;
      for (const file of packageSources(dir, deep)) {
        if (count >= 24 || budget <= 0) break;
        try {
          const info = statSync(file);
          if (!info.isFile() || info.size > SCAN_MAX_BYTES) continue;
          const source = readFileSync(file, 'utf8');
          budget -= source.length;
          count += 1;
          for (const match of source.matchAll(NAME_DEF)) literals.add(match[1]);
        } catch {
          /* 换下一个候选入口 */
        }
      }
      if (literals.size === 0) continue;
      for (const name of wanted) {
        if (!literals.has(name)) continue;
        let set = hits.get(name);
        if (!set) hits.set(name, (set = new Set()));
        set.add(ref.id);
      }
    }
    for (const [name, set] of hits) if (set.size === 1) map.set(name, [...set][0]);
    attributionCache = map;
    return map;
  };

  /**
   * 全量可见面清单 = 各 preset 作用域 ∪ 全局。
   * 这是本插件最重要的一段：只查全局会漏掉 40 个工具。
   */
  const inventory = async (force = false) => {
    if (!force && inventoryCache && Date.now() - inventoryAt < INVENTORY_TTL_MS) return inventoryCache;

    const tools = new Map();
    const sections = new Map();
    const scopes = [];

    try {
      const registry = get('agentPresets');
      const presets = (await registry?.list?.()) ?? [];
      for (const preset of presets) {
        try {
          const lease = await registry.acquireScope(preset.id);
          scopes.push(lease?.key);
          for (const schema of schemasFor(lease?.key)) {
            if (!schema?.name) continue;
            const chars = (() => {
              try {
                return JSON.stringify(schema).length;
              } catch {
                return 0;
              }
            })();
            tools.set(schema.name, chars);
          }
          for (const section of await sectionsFor(lease?.key)) sections.set(section.name, section.chars);
          try {
            await lease?.[Symbol.asyncDispose]?.();
          } catch {
            /* 释放失败不影响读数 */
          }
        } catch (error) {
          warn(`读取 preset「${preset?.id}」可见面失败：${error?.message ?? error}`);
        }
      }
    } catch (error) {
      warn(`枚举 preset 失败：${error?.message ?? error}`);
    }

    for (const schema of globalToolSchemas()) {
      if (!schema?.name || tools.has(schema.name)) continue;
      try {
        tools.set(schema.name, JSON.stringify(schema).length);
      } catch {
        tools.set(schema.name, 0);
      }
    }
    for (const section of await sectionsFor(undefined)) {
      if (!sections.has(section.name)) sections.set(section.name, section.chars);
    }

    inventoryCache = { tools, sections, scopes };
    inventoryAt = Date.now();
    return inventoryCache;
  };

  const buildPlan = async (force = false) => {
    const inv = await inventory(force);
    const refs = pluginRefs();
    const plan = attribute({
      tools: [...inv.tools.keys()],
      sections: [...inv.sections.keys()],
      plugins: refs,
    });
    const meta = new Map(refs.map((entry) => [entry.id.toLowerCase(), entry]));

    // 静态扫包兜底：把"名字里不含包名"的工具认回来（free-search 那 8 个、read/write 那批）
    const adopted = scanAttribution(plan.unassigned.tools);
    if (adopted.size > 0) {
      const byKey = new Map(plan.groups.map((group) => [group.id.toLowerCase(), group]));
      const remaining = [];
      for (const name of plan.unassigned.tools) {
        const owner = adopted.get(name);
        if (!owner) {
          remaining.push(name);
          continue;
        }
        let group = byKey.get(owner.toLowerCase());
        if (!group) {
          group = { id: owner, tools: [], sections: [] };
          plan.groups.push(group);
          byKey.set(owner.toLowerCase(), group);
        }
        group.tools.push(name);
      }
      plan.unassigned.tools = remaining.sort();
      plan.groups.sort((a, b) => a.id.localeCompare(b.id));
    }

    // 手工归属最后套：用户说了算，赢过前缀匹配与静态扫描
    const resolved = applyAssignments(plan, store.assignments);

    return {
      ...resolved,
      groups: resolved.groups.map((group) => {
        const info = meta.get(group.id.toLowerCase());
        return {
          ...group,
          title: info?.title ?? '',
          // 没有对应插件行的组 = 用户手工建的分组
          origin: info?.origin ?? 'manual',
          chars: groupChars(group, inv),
        };
      }),
      toolChars: inv.tools,
      sectionText: inv.sections,
      presetScopeCount: inv.scopes.length,
    };
  };

  function groupChars(group, inv) {
    let chars = 0;
    for (const name of group.tools) chars += inv.tools.get(name) ?? 0;
    for (const name of group.sections) chars += inv.sections.get(name) ?? 0;
    return chars;
  }

  /**
   * 给一个 agent 应用它工作区的门控。
   * 这里任何异常都必须被吞掉：`agent/created` 是串行且被 await 的，
   * 抛出去就等于这个会话开不起来。
   */
  const bind = async (agent, carrier) => {
    try {
      if (!agent?.id) return;
      const cwd = agentCwd(ctx, agent);
      const key = pickDir(cwd, Object.keys(store.overrides));
      if (!key) return;

      const plan = await buildPlan();
      const hidden = resolveHidden(store.overrides[key] ?? [], plan);
      const visible = new Set([
        ...plan.groups.flatMap((g) => g.tools),
        ...plan.unassigned.tools,
      ]);
      const deny = hidden.tools.filter((n) => visible.has(n) && !RESERVED.has(n));
      const sections = hidden.sections.filter((n) => plan.sectionText.has(n));

      if (!deny.length && !sections.length) {
        bound.set(agent.id, { cwd, key, deny: [], sections: [], skipped: [], at: Date.now() });
        return;
      }

      const scope = agent.ctx ?? carrier;
      if (!scope?.effect) {
        warn(`agent ${agent.id} 没有可用的作用域上下文，跳过门控`);
        return;
      }

      const applied = [];
      const skipped = [];
      const cleanup = [];

      // 一条一条地 restrict：restrict 只接受"全局面"的名字，
      // 逐个调用可以让不可限制的名字单独失败，而不是一条坏名字废掉整批。
      for (const name of deny) {
        try {
          cleanup.push(scope.tools.restrict({ deny: [name] }));
          applied.push(name);
        } catch (error) {
          skipped.push({ name, reason: String(error?.message ?? error) });
        }
      }

      const prompt = (() => {
        try {
          return scope.get?.('systemPrompt') ?? scope.systemPrompt;
        } catch {
          return undefined;
        }
      })();
      for (const sectionName of sections) {
        try {
          cleanup.push(prompt.section({ name: sectionName, order: 0, text: '' }));
        } catch (error) {
          skipped.push({ name: sectionName, reason: String(error?.message ?? error) });
        }
      }

      const off = scope.effect(() => () => {
        for (const fn of cleanup) {
          try {
            fn?.();
          } catch {
            /* 忽略 */
          }
        }
      });

      disposers.set(agent.id, off);
      bound.set(agent.id, { cwd, key, deny: applied, sections, skipped, at: Date.now() });
      if (skipped.length) warn(`${skipped.length} 个名字无法门控（不在全局面）`);
    } catch (error) {
      warn(`绑定 agent 失败：${error?.message ?? error}`);
    }
  };

  ctx.on('agent/created', async (payload) => {
    const agent = payload?.agent ?? payload;
    await bind(agent, payload);
  });

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload;
    const id = agent?.id;
    if (!id) return;
    try {
      disposers.get(id)?.();
    } catch {
      /* 忽略 */
    }
    disposers.delete(id);
    bound.delete(id);
  });

  // 本插件卸载时，把还挂在活着的 agent 上的作用域注册一并收掉
  // （插件卸载不会自动释放 agent.ctx 里的注册，practices.md 明确提醒过）。
  ctx.effect(() => () => {
    for (const [id, off] of disposers) {
      try {
        off?.();
      } catch {
        /* 忽略 */
      }
      disposers.delete(id);
    }
  });

  const state = async (force = false) => {
    await refreshPlugins(force);
    const plan = await buildPlan(force);
    const dirs = new Map();

    try {
      const registry = get('workspaceRegistry');
      for (const ws of registry?.list?.() ?? []) {
        const key = normalizeDir(ws?.path);
        if (!key) continue;
        dirs.set(key, {
          key,
          path: ws.path,
          title: String(ws.title ?? ''),
          source: 'workspace',
          sessions: Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0,
        });
      }
    } catch {
      /* 没有 workspaceRegistry 也能用：配置目录本身是键 */
    }

    for (const [key, specs] of Object.entries(store.overrides)) {
      const entry = dirs.get(key) ?? { key, path: key, title: '', source: 'manual', sessions: 0 };
      entry.hidden = specs;
      dirs.set(key, entry);
    }

    return {
      storePath: storeFile(),
      storeExists: existsSync(storeFile()),
      groups: plan.groups
        // 自己那一条不出现在列表里：它的工具是保留项，勾了也不生效，只会让人困惑
        .filter((g) => !RESERVED_GROUPS.has(String(g.id).toLowerCase()))
        .map((g) => ({
          id: g.id,
          title: g.title,
          origin: g.origin,
          tools: g.tools,
          sections: g.sections,
          chars: g.chars,
        })),
      unassigned: {
        tools: plan.unassigned.tools,
        sections: plan.unassigned.sections,
      },
      dirs: [...dirs.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))),
      overrides: store.overrides,
      assignments: store.assignments,
      reserved: [...RESERVED],
      presetScopeCount: plan.presetScopeCount,
      recent: [...bound.entries()]
        .slice(-20)
        .map(([id, info]) => ({ sessionId: id, ...info })),
      pluginCount: pluginList.length,
    };
  };

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.local');
      const tail = url.pathname.replace(/\/+$/, '').split('/').pop();

      if (tail === 'state') return json(res, 200, await state(false));
      if (tail === 'refresh') return json(res, 200, await state(true));

      if (tail === 'apply') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const dir = String(body?.dir ?? '').trim();
        if (!dir) return json(res, 400, { error: 'dir 不能为空' });
        store = withHidden(store, dir, Array.isArray(body?.hidden) ? body.hidden : []);
        saveStore(store);
        return json(res, 200, { ok: true, ...(await state(false)) });
      }

      if (tail === 'assign') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const entries = Array.isArray(body?.entries) ? body.entries : [];
        store = withAssignments(store, entries);
        saveStore(store);
        return json(res, 200, { ok: true, ...(await state(false)) });
      }

      return json(res, 404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) });
    }
  };

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => {
          void handle(req, res);
        },
      }),
    );
  });

  ctx.effect(() =>
    ctx.tools.register({
      name: TOOL_NAME,
      description: [
        '查看 / 调整「按工作区插件门控」：哪些插件的工具与系统提示词段在这个工作区被隐藏。',
        'action=status 看最近命中的会话与隐藏结果；',
        'action=list 列出可门控的插件与其工具/段落名；',
        'action=set 需要显式给 dir（例如 "D:\\\\Projects"），隐藏或恢复若干名字。',
        '改动只对新会话生效，已开的会话不回溯。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'list', 'set', 'diagnose'],
            description: '要做什么。',
          },
          dir: {
            type: 'string',
            description: 'action=set 时必填：要改配置的目录（绝对路径，子目录会继承）。',
          },
          hide: {
            type: 'array',
            items: { type: 'string' },
            description: 'spec 列表：plugin:<id> / tool:<name> / section:<name>。',
          },
          show: {
            type: 'array',
            items: { type: 'string' },
            description: '要从隐藏清单里移除的 spec。',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      deferLoading: false,
      async execute(args, exec) {
        const action = String(args?.action ?? 'status');

        if (action === 'diagnose') {
          const agent = exec?.agent;
          const inv = await inventory(true);
          const agentTools = agent ? schemasFor(agent).map((s) => s?.name).filter(Boolean) : [];
          const agentSections = agent ? (await sectionsFor(agent)).map((s) => s.name) : [];
          let presets = [];
          try {
            presets = (await get('agentPresets')?.list?.()) ?? [];
          } catch (error) {
            warn(`读取 preset 清单失败：${error?.message ?? error}`);
          }
          const first = pluginList[0];
          return safeJson({
            agentId: agent?.id ?? null,
            cwd: agent ? agentCwd(ctx, agent) : null,
            globalToolCount: globalToolSchemas().length,
            inventoryToolCount: inv.tools.size,
            inventorySectionCount: inv.sections.size,
            agentToolCount: agentTools.length,
            agentTools,
            agentSections,
            presets: presets.map((p) => ({ id: p?.id, isDefault: p?.isDefault })),
            pluginCount: pluginList.length,
            pluginKeys: first && typeof first === 'object' ? Object.keys(first) : [],
            pluginSample: pluginRefs().slice(0, 8),
            storePath: storeFile(),
            overrides: store.overrides,
            bound: [...bound.entries()].map(([id, info]) => ({ sessionId: id, ...info })),
          });
        }

        if (action === 'list') {
          const snapshot = await state(false);
          return safeJson({
            workspaceDirs: snapshot.dirs.map((d) => ({ path: d.path, hidden: d.hidden ?? [] })),
            plugins: snapshot.groups.map((g) => ({
              id: g.id,
              title: g.title,
              tools: g.tools,
              sections: g.sections,
              approxTokens: Math.round(g.chars / 4),
            })),
            unassignedTools: snapshot.unassigned.tools,
            unassignedSections: snapshot.unassigned.sections,
            storePath: snapshot.storePath,
          });
        }

        if (action === 'set') {
          const dir = String(args?.dir ?? '').trim();
          if (!dir) return safeJson({ ok: false, error: 'action=set 需要 dir' });
          const key = normalizeDir(dir);
          const current = new Set(store.overrides[key] ?? []);
          for (const s of args?.hide ?? []) current.add(String(s).trim());
          for (const s of args?.show ?? []) current.delete(String(s).trim());
          store = withHidden(store, key, [...current]);
          saveStore(store);
          return safeJson({ ok: true, dir: key, hidden: store.overrides[key] ?? [] });
        }

        const snapshot = await state(false);
        return safeJson({
          storePath: snapshot.storePath,
          storeExists: snapshot.storeExists,
          configuredDirs: Object.keys(snapshot.overrides),
          presetScopeCount: snapshot.presetScopeCount,
          recentSessions: snapshot.recent,
          note: snapshot.recent.length
            ? 'recentSessions 里 cwd 命中的会话已按工作区应用门控。'
            : '还没有会话命中任何已配置的工作区（或本会话的工作区未配置）。',
        });
      },
    }),
  );

  void refreshPlugins(true);
}
