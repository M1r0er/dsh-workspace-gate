import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 门控绑定的时序测试。
 *
 * 议题 #1：`apply()` 末尾的 `void refreshPlugins(true)` 是 fire-and-forget，
 * 而 `agent/created` 几乎同时在 `apply()` 返回后触发。此时 `pluginList` 还是
 * 初始空数组，`buildPlan()` 拿不到任何插件行，`resolveHidden()` 按 id 查不到组
 * 就静默跳过，最后 `deny = []` —— 用户配了隐藏却什么也没隐藏。
 *
 * 这里用一个延迟 resolve 的 `listPlugins()` 复现那个窗口：如果 `bind()` 不自己
 * 等清单，`restrict()` 一次都不会被调用。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLUGINS = [{ patchId: 'soul-md', moduleName: 'dsh-soul-md' }];

function makeCtx({ delayMs, failTimes = 0 }) {
  const handlers = new Map();
  const restricted = [];
  let listCalls = 0;
  let failuresLeft = failTimes;

  const ctx = {
    get(service) {
      if (service === 'pluginManager') {
        return {
          async listPlugins() {
            listCalls += 1;
            await sleep(delayMs);
            if (failuresLeft > 0) {
              failuresLeft -= 1;
              throw new Error('模拟清单读取失败');
            }
            return PLUGINS;
          },
          async listBundles() {
            return [];
          },
        };
      }
      if (service === 'tools') {
        return { schemas: () => [{ name: 'soul_md_status' }] };
      }
      if (service === 'agentPresets') {
        return { list: async () => [], acquireScope: async () => ({}) };
      }
      return undefined;
    },
    logger: { warn: () => {} },
    tools: { register: () => () => {} },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    // 这个测试不关心 Web 路由；webServer 缺席时真实代码也不会进回调。
    inject() {},
  };

  return {
    ctx,
    restricted,
    get listCalls() {
      return listCalls;
    },
    async emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload);
    },
  };
}

function makeAgent(id, cwd, restricted) {
  return {
    id,
    session: { header: { cwd } },
    ctx: {
      tools: {
        restrict({ deny }) {
          for (const name of deny) restricted.push(name);
          return () => {};
        },
      },
      get(name) {
        if (name === 'systemPrompt') return { section: () => () => {} };
        return undefined;
      },
      effect(fn) {
        return fn();
      },
    },
  };
}

test('bind 等插件清单：agent/created 到来时门控必须真的生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'workspace-gate.json'),
    JSON.stringify({ version: 1, overrides: { 'D:\\Projects': ['plugin:soul-md'] }, assignments: {} }),
    'utf8',
  );

  const { apply } = await import('../index.js');

  const harness = makeCtx({ delayMs: 40 });
  apply(harness.ctx);

  // apply() 返回的那一刻，refreshPlugins 还在飞 —— 这正是真实启动时的窗口。
  const agent = makeAgent('a1', 'D:\\Projects\\api', harness.restricted);
  await harness.emit('agent/created', { agent });

  assert.deepEqual(harness.restricted, ['soul_md_status'], '配了 plugin:soul-md 就应该隐藏它的工具');
});

test('并发建立多个 agent 时，插件清单只拉一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'workspace-gate.json'),
    JSON.stringify({ version: 1, overrides: { 'D:\\Projects': ['plugin:soul-md'] }, assignments: {} }),
    'utf8',
  );

  const { apply } = await import('../index.js');

  const harness = makeCtx({ delayMs: 30 });
  apply(harness.ctx);

  // 同一刻三个 agent 一起建立：不能各拉一遍清单。
  // apply() 自己那次 fire-and-forget 可能还在飞，bind 会直接共用它；也可能已落地。
  // 所以这里断言的是"没有变成 3 次独立读取"，而不是精确的 1 次。
  const before = harness.listCalls;
  await Promise.all(
    ['a1', 'a2', 'a3'].map((id) => harness.emit('agent/created', { agent: makeAgent(id, 'D:\\Projects\\x', []) })),
  );

  const delta = harness.listCalls - before;
  assert.ok(delta <= 1, `并发的 3 个 bind 最多只应产生 1 次清单读取，实际 ${delta} 次`);
});

test('清单读取失败后必须能自愈，不能被 TTL 关成 15 秒失效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'workspace-gate.json'),
    JSON.stringify({ version: 1, overrides: { 'D:\\Projects': ['plugin:soul-md'] }, assignments: {} }),
    'utf8',
  );

  const { apply } = await import('../index.js');

  const harness = makeCtx({ delayMs: 5, failTimes: 1 });
  apply(harness.ctx);

  // 第一次读失败 → 空清单；下一次必须立刻重试并成功，而不是继续拿空清单。
  const first = [];
  await harness.emit('agent/created', { agent: makeAgent('a1', 'D:\\Projects\\api', first) });
  assert.deepEqual(first, [], '读取失败时确实应用不了门控');

  const second = [];
  await harness.emit('agent/created', { agent: makeAgent('a2', 'D:\\Projects\\api', second) });
  assert.deepEqual(second, ['soul_md_status'], '失败后应当立即重试并成功，而不是等 15 秒 TTL');
});

test('配了隐藏却一条都没命中时，必须告警而不是静默', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'workspace-gate.json'),
    JSON.stringify({ version: 1, overrides: { 'D:\\Projects': ['plugin:gone-plugin'] }, assignments: {} }),
    'utf8',
  );

  const { apply } = await import('../index.js');

  const warnings = [];
  const harness = makeCtx({ delayMs: 5 });
  harness.ctx.logger.warn = (message) => warnings.push(String(message));
  apply(harness.ctx);

  await harness.emit('agent/created', { agent: makeAgent('a1', 'D:\\Projects\\api', []) });

  assert.equal(warnings.length, 1, '静默失效必须留下一条告警');
  assert.match(warnings[0], /没有一条命中可见面/);
});
