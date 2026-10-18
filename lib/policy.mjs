/**
 * dsh-workspace-gate —— 纯逻辑层。
 *
 * 这里不碰 cordis、不碰 fs、不碰时钟，只做四件事：
 *   1) 目录归一化 + 最长祖先前缀匹配（"给 D:\Projects 配一次，D:\Projects\api 继承"）；
 *   2) 把工具名 / 提示词段名归到插件（归属推断，失败就归"未归属"）；
 *   3) 把用户勾选的 spec 展开成"要隐藏的工具名 + 段名"；
 *   4) 存储对象的规整与写入。
 *
 * 之所以把这层单独拆出来：它可以在 node 里直接单测，不需要启动 DSH。
 */

export const STORE_VERSION = 1;

export const SPEC_PLUGIN = 'plugin:';
export const SPEC_TOOL = 'tool:';
export const SPEC_SECTION = 'section:';

/** 允许写进 spec 的前缀，UI 和工具都用它做校验。 */
export const SPEC_PREFIXES = [SPEC_PLUGIN, SPEC_TOOL, SPEC_SECTION];

/**
 * 目录归一化：反斜杠转正斜杠、折叠重复分隔符、去掉尾部分隔符、统一小写。
 * 统一小写是刻意的——Windows 路径大小写不敏感，而本插件的主要用户就在 Windows；
 * 在 POSIX 上把 `Foo` 和 `foo` 当同一个目录，代价远小于"配了不生效"。
 */
export function normalizeDir(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  let p = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.toLowerCase();
}

/** ancestor 是不是 target 本身或它的祖先目录。 */
export function isAncestor(ancestor, target) {
  const a = normalizeDir(ancestor);
  const b = normalizeDir(target);
  if (!a || !b) return false;
  if (a === b) return true;
  return b.startsWith(a === '/' ? a : a + '/');
}

/**
 * 在一堆已配置的目录键里，找出 cwd 命中得最深的那个（最长祖先前缀）。
 * 返回归一化后的键；没有命中返回 ''。
 */
export function pickDir(cwd, keys) {
  const target = normalizeDir(cwd);
  if (!target) return '';
  let best = '';
  for (const key of keys ?? []) {
    const n = normalizeDir(key);
    if (!n) continue;
    if (!isAncestor(n, target)) continue;
    if (n.length > best.length) best = n;
  }
  return best;
}

/**
 * 名字 → token 序列。依次剥掉 scoped 包名前缀（`@scope/`）、组合包的 `include:`
 * 行前缀、`dsh-` 包前缀，再按非字母数字切开。
 *   `@deepseek-ai/dsh-tool-bash` → ['tool','bash']
 *   `include:dsh-free-search`    → ['free','search']
 *   `r18_novel_info`             → ['r18','novel','info']
 */
export function tokensOf(name) {
  const s = String(name ?? '')
    .trim()
    .replace(/^@[^/]+\//, '')
    .replace(/^include[:\-]/i, '')
    .replace(/^dsh[:\-]/i, '');
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * 提示词段的归属：段名约定是 `<命名空间>:<名字>`（`prompt-toggle:main`、
 * `r18-novel:protocol`）。取冒号前的那段当插件 id，这是全系统里唯一
 * 稳定可靠的归属信号，所以优先用它。
 */
export function sectionOwner(name) {
  const s = String(name ?? '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * 把当前模型可见面（工具名 + 段名）和已知插件清单，归成若干组。
 *
 * **只有插件清单里的条目能成为组**——这一点很要紧：提示词段的命名空间
 * （`app`、`harness`、`deployment`、`tool`…）看起来像"插件"，其实是内置段落族，
 * 一旦把它们当插件列出来，界面就会被一堆假插件淹没。
 *
 * 归属规则（从强到弱）：
 *   1. 段名 → 冒号前的命名空间，**必须命中一个已知插件 id** 才归属；
 *   2. 工具名 → 与插件 id 做"前导 token 全等"匹配，取共享前缀最长的那个
 *      （`r18-novel` vs `r18_novel_info` 共享 2 个 token，胜出）；
 *   3. 都不中 → 未归属（工具、段各自一桶）。
 *
 * 不做模糊打分、不做编辑距离：归属错了会隐藏错东西，宁可坦率地承认
 * "我不知道这个属于谁"，让它留在未归属里由用户手动点名。
 */
export function attribute({ tools = [], sections = [], plugins = [] } = {}) {
  const groups = new Map();
  const ensure = (id) => {
    const key = String(id ?? '').toLowerCase();
    if (!key) return null;
    let g = groups.get(key);
    if (!g) {
      g = { id: String(id), tools: [], sections: [], aliases: [] };
      groups.set(key, g);
    }
    return g;
  };

  for (const p of plugins) {
    const id = p?.id ?? p?.name ?? p?.packageName;
    if (!id) continue;
    const group = ensure(id);
    if (group && Array.isArray(p?.aliases)) {
      for (const alias of p.aliases) if (alias) group.aliases.push(String(alias));
    }
  }

  const unassigned = { tools: [], sections: [] };

  /** 段命名空间与插件 id/别名都归一到同一形态再比：`free-search` 与 `dsh-free-search` 应当相等。 */
  const slugOf = (name) => tokensOf(name).join('-');

  for (const name of sections) {
    const owner = sectionOwner(name);
    let group;
    if (owner) {
      const slug = slugOf(owner);
      for (const candidate of groups.values()) {
        if (slugOf(candidate.id) === slug || candidate.aliases.some((alias) => slugOf(alias) === slug)) {
          group = candidate;
          break;
        }
      }
    }
    if (group) group.sections.push(name);
    else unassigned.sections.push(name);
  }

  for (const name of tools) {
    const t = tokensOf(name);
    let best = null;
    let bestScore = 0;
    for (const g of groups.values()) {
      // 用 id 与所有别名一起比：有的插件 patchId 和包名对不上
      // （`dsh-free-search` 的行 id 是 `web-search-free`，只有包名能匹配工具前缀）
      for (const candidate of [g.id, ...g.aliases]) {
        const gid = tokensOf(candidate);
        if (!gid.length) continue;
        let score = 0;
        while (score < gid.length && score < t.length && gid[score] === t[score]) score += 1;
        if (score === gid.length && score > bestScore) {
          best = g;
          bestScore = score;
        }
      }
    }
    if (best) best.tools.push(name);
    else unassigned.tools.push(name);
  }

  const list = [...groups.values()]
    .filter((g) => g.tools.length || g.sections.length)
    .map((g) => ({ id: g.id, tools: [...g.tools].sort(), sections: [...g.sections].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  unassigned.tools.sort();
  unassigned.sections.sort();

  return { groups: list, unassigned };
}

/**
 * 把用户勾选的 spec 列表展开成具体的"要隐藏什么"。
 *   `plugin:r18-novel`        → 该插件名下所有工具 + 所有段
 *   `tool:r18_novel_info`     → 单个工具
 *   `section:r18-novel:protocol` → 单个段
 * 未知 / 已消失的名字被静默忽略（插件卸了不该让配置变成错误）。
 */
export function resolveHidden(specs, plan) {
  const tools = new Set();
  const sections = new Set();
  const byId = new Map();
  for (const g of plan?.groups ?? []) byId.set(String(g.id).toLowerCase(), g);

  for (const raw of specs ?? []) {
    const spec = String(raw ?? '').trim();
    if (!spec) continue;
    if (spec.startsWith(SPEC_PLUGIN)) {
      const g = byId.get(spec.slice(SPEC_PLUGIN.length).toLowerCase());
      if (!g) continue;
      for (const t of g.tools) tools.add(t);
      for (const s of g.sections) sections.add(s);
    } else if (spec.startsWith(SPEC_TOOL)) {
      const n = spec.slice(SPEC_TOOL.length).trim();
      if (n) tools.add(n);
    } else if (spec.startsWith(SPEC_SECTION)) {
      const n = spec.slice(SPEC_SECTION.length).trim();
      if (n) sections.add(n);
    }
  }

  return { tools: [...tools].sort(), sections: [...sections].sort() };
}

/** 空存储。 */
export function emptyStore() {
  return { version: STORE_VERSION, overrides: {}, assignments: {} };
}

/**
 * 把磁盘上读到的东西规整成可信的形状：任何一处不合规就丢掉那一处，
 * 绝不让一个坏文件把整个门控炸掉（读不到 = 全放行）。
 */
export function normalizeStore(raw) {
  const out = emptyStore();
  if (!raw || typeof raw !== 'object') return out;

  const overrides = raw.overrides;
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      const dir = normalizeDir(key);
      if (!dir || !Array.isArray(value)) continue;
      const specs = [...new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean))].sort();
      if (specs.length) out.overrides[dir] = specs;
    }
  }

  const assignments = raw.assignments;
  if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
    for (const [spec, group] of Object.entries(assignments)) {
      const key = String(spec ?? '').trim();
      const value = String(group ?? '').trim();
      if (!value) continue;
      if (!/^(tool|section):./.test(key)) continue;
      out.assignments[key] = value;
    }
  }

  return out;
}

/** 返回一份新的 store：dir 的隐藏清单被替换成 specs（空数组 = 删掉该条）。 */
export function withHidden(store, dir, specs) {
  const base = normalizeStore(store);
  const key = normalizeDir(dir);
  const next = {
    version: STORE_VERSION,
    overrides: { ...base.overrides },
    assignments: { ...base.assignments },
  };
  if (!key) return next;
  const list = [...new Set((specs ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))].sort();
  if (list.length) next.overrides[key] = list;
  else delete next.overrides[key];
  return next;
}

/**
 * 返回一份新的 store：合并若干"手工归属"。
 * `{ spec: 'tool:read', group: 'tool-fs' }`；`group` 为空串 = 撤销手工归属、回到自动推断。
 */
export function withAssignments(store, entries) {
  const base = normalizeStore(store);
  const next = {
    version: STORE_VERSION,
    overrides: { ...base.overrides },
    assignments: { ...base.assignments },
  };
  for (const entry of entries ?? []) {
    const spec = String(entry?.spec ?? '').trim();
    const group = String(entry?.group ?? '').trim();
    if (!/^(tool|section):./.test(spec)) continue;
    if (group) next.assignments[spec] = group;
    else delete next.assignments[spec];
  }
  return next;
}

/**
 * 在自动归属之上再套一层"用户手工归属"：先把名字从它当前所在的组/未归属里摘掉，
 * 再放进指定的组（组不存在就新建一个）。**手工永远赢过自动。**
 */
export function applyAssignments(plan, assignments) {
  const map = assignments && typeof assignments === 'object' ? assignments : {};
  const specs = Object.keys(map);
  if (specs.length === 0) return plan;

  const groups = new Map();
  const unassigned = { tools: [], sections: [] };
  for (const group of plan?.groups ?? []) {
    const copy = { id: group.id, tools: [...group.tools], sections: [...group.sections] };
    groups.set(copy.id.toLowerCase(), copy);
  }
  for (const name of plan?.unassigned?.tools ?? []) unassigned.tools.push(name);
  for (const name of plan?.unassigned?.sections ?? []) unassigned.sections.push(name);

  /** 把名字从它当前所在的位置摘掉；找到返回 true。 */
  const take = (kind, name) => {
    for (const group of groups.values()) {
      const list = kind === 'tool' ? group.tools : group.sections;
      const index = list.indexOf(name);
      if (index >= 0) {
        list.splice(index, 1);
        return true;
      }
    }
    const pool = kind === 'tool' ? unassigned.tools : unassigned.sections;
    const index = pool.indexOf(name);
    if (index >= 0) {
      pool.splice(index, 1);
      return true;
    }
    return false;
  };

  for (const spec of specs) {
    const group = String(map[spec] ?? '').trim();
    if (!group) continue;
    const separator = spec.indexOf(':');
    const kind = spec.slice(0, separator);
    const name = spec.slice(separator + 1);
    if (kind !== 'tool' && kind !== 'section') continue;
    if (!name) continue;
    // 名字已经不存在（插件卸了）就别往组里塞幽灵
    if (!take(kind, name)) continue;
    const key = group.toLowerCase();
    let target = groups.get(key);
    if (!target) {
      target = { id: group, tools: [], sections: [] };
      groups.set(key, target);
    }
    (kind === 'tool' ? target.tools : target.sections).push(name);
  }

  const list = [...groups.values()]
    .filter((group) => group.tools.length || group.sections.length)
    .map((group) => ({
      id: group.id,
      tools: [...group.tools].sort(),
      sections: [...group.sections].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  unassigned.tools.sort();
  unassigned.sections.sort();
  return { groups: list, unassigned };
}

/**
 * 估算一条 spec 省掉的字符数——用来在 UI 上告诉用户"你这一勾大概值多少 token"。
 * 只数真正被隐藏掉的东西，不猜。
 */
export function estimateChars(hidden, plan) {
  let chars = 0;
  const sectionText = plan?.sectionText ?? new Map();
  for (const name of hidden?.sections ?? []) chars += Number(sectionText.get?.(name) ?? 0);
  const toolChars = plan?.toolChars ?? new Map();
  for (const name of hidden?.tools ?? []) chars += Number(toolChars.get?.(name) ?? 0);
  return chars;
}
