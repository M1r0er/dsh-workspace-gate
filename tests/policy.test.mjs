import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAssignments,
  attribute,
  emptyStore,
  estimateChars,
  isAncestor,
  normalizeDir,
  normalizeStore,
  pickDir,
  resolveHidden,
  sectionOwner,
  tokensOf,
  withAssignments,
  withHidden,
} from '../lib/policy.mjs';

test('normalizeDir 统一分隔符、去尾斜杠、转小写', () => {
  assert.equal(normalizeDir('D:\\Projects\\Api\\'), 'd:/projects/api');
  assert.equal(normalizeDir('d:/projects//api//'), 'd:/projects/api');
  assert.equal(normalizeDir('  C:\\  '), 'c:');
  assert.equal(normalizeDir(''), '');
  assert.equal(normalizeDir(null), '');
});

test('isAncestor 认自己、认真子目录、不认同前缀的兄弟目录', () => {
  assert.equal(isAncestor('D:\\Projects', 'D:\\Projects'), true);
  assert.equal(isAncestor('D:\\Projects', 'D:\\Projects\\api\\src'), true);
  assert.equal(isAncestor('D:\\Projects', 'D:\\ProjectsApi'), false);
  assert.equal(isAncestor('D:\\Other', 'D:\\Projects\\api'), false);
});

test('pickDir 取命中最深的祖先', () => {
  const keys = ['D:\\', 'D:\\Projects', 'D:\\Projects\\api', 'C:\\Work'];
  assert.equal(pickDir('D:\\Projects\\api\\src\\index.ts', keys), 'd:/projects/api');
  assert.equal(pickDir('D:\\Projects\\web', keys), 'd:/projects');
  assert.equal(pickDir('D:\\Music', keys), 'd:');
  assert.equal(pickDir('E:\\Somewhere', keys), '');
  assert.equal(pickDir('', keys), '');
});

test('tokensOf 去 scoped 前缀与 dsh- 前缀', () => {
  assert.deepEqual(tokensOf('@deepseek-ai/dsh-tool-bash'), ['tool', 'bash']);
  assert.deepEqual(tokensOf('r18_novel_info'), ['r18', 'novel', 'info']);
  assert.deepEqual(tokensOf('prompt-toggle:main'), ['prompt', 'toggle', 'main']);
  assert.deepEqual(tokensOf('include:dsh-free-search'), ['free', 'search']);
  assert.deepEqual(tokensOf(''), []);
});

test('sectionOwner 取冒号前的命名空间', () => {
  assert.equal(sectionOwner('r18-novel:protocol'), 'r18-novel');
  assert.equal(sectionOwner('prompt-toggle:main'), 'prompt-toggle');
  assert.equal(sectionOwner('deployment:persona-prefix'), 'deployment');
  assert.equal(sectionOwner('noseparator'), '');
});

test('attribute：段按命名空间归属，工具按前导 token 归属，认不出的进未归属', () => {
  const plan = attribute({
    tools: ['r18_novel_info', 'r18_novel_next', 'prompt_toggle_status', 'read', 'write'],
    sections: ['r18-novel:protocol', 'prompt-toggle:main'],
    plugins: [{ id: 'r18-novel' }, { id: 'prompt-toggle' }, { id: 'ui-chat' }],
  });

  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('r18-novel').tools, ['r18_novel_info', 'r18_novel_next']);
  assert.deepEqual(byId.get('r18-novel').sections, ['r18-novel:protocol']);
  assert.deepEqual(byId.get('prompt-toggle').tools, ['prompt_toggle_status']);
  assert.deepEqual(byId.get('prompt-toggle').sections, ['prompt-toggle:main']);

  // 没有任何工具或段落在可见面上的插件不出现
  assert.equal(byId.has('ui-chat'), false);

  assert.deepEqual(plan.unassigned.tools, ['read', 'write']);
});

test('attribute：别名参与匹配（patchId 与包名不一致时）', () => {
  const plan = attribute({
    tools: ['free_search_test', 'platform_search'],
    sections: ['free-search:engines'],
    plugins: [{ id: 'web-search-free', aliases: ['dsh-free-search'] }],
  });
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual([...byId.keys()], ['web-search-free']);
  assert.deepEqual(byId.get('web-search-free').tools, ['free_search_test']);
  // 段的命名空间 free-search 与别名 dsh-free-search 归一到同一 slug，也能归属
  assert.deepEqual(byId.get('web-search-free').sections, ['free-search:engines']);
  assert.deepEqual(plan.unassigned.tools, ['platform_search']);
});

test('attribute：段命名空间不是插件时进未归属，不伪造插件组', () => {
  const plan = attribute({
    tools: ['read'],
    sections: ['harness:identity', 'deployment:persona-prefix', 'tool:read', 'r18-novel:protocol'],
    plugins: [{ id: 'r18-novel' }],
  });
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual([...byId.keys()], ['r18-novel']);
  assert.deepEqual(byId.get('r18-novel').sections, ['r18-novel:protocol']);
  assert.deepEqual(plan.unassigned.sections, ['deployment:persona-prefix', 'harness:identity', 'tool:read']);
  assert.deepEqual(plan.unassigned.tools, ['read']);
});

test('attribute：只有段、没有工具的插件也会出现', () => {
  const plan = attribute({
    tools: [],
    sections: ['prompt-toggle:main'],
    plugins: [{ id: 'prompt-toggle' }],
  });
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0].sections, ['prompt-toggle:main']);
});

test('attribute：共享 token 更长的插件胜出', () => {
  const plan = attribute({
    tools: ['free_search_web', 'free_search_news'],
    sections: [],
    plugins: [{ id: 'dsh-free-search' }, { id: 'dsh-free-search-plus' }],
  });
  // 两个插件首 token 都是 free/search；-plus 多一个 token 但不匹配，仍归给前者
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('dsh-free-search').tools, ['free_search_news', 'free_search_web']);
});

test('resolveHidden：plugin: 展开成它的全部名字', () => {
  const plan = {
    groups: [{ id: 'r18-novel', tools: ['r18_novel_info'], sections: ['r18-novel:protocol'] }],
    unassigned: { tools: [] },
  };
  const hidden = resolveHidden(['plugin:r18-novel'], plan);
  assert.deepEqual(hidden.tools, ['r18_novel_info']);
  assert.deepEqual(hidden.sections, ['r18-novel:protocol']);
});

test('resolveHidden：单个名字精确生效，未知名字被忽略', () => {
  const plan = { groups: [], unassigned: { tools: [] } };
  const hidden = resolveHidden(
    ['tool:read', 'section:prompt-toggle:main', 'plugin:gone', 'tool:', 'nonsense'],
    plan,
  );
  assert.deepEqual(hidden.tools, ['read']);
  assert.deepEqual(hidden.sections, ['prompt-toggle:main']);
});

test('resolveHidden：结果去重且排序稳定', () => {
  const plan = { groups: [], unassigned: { tools: [] } };
  const hidden = resolveHidden(['tool:write', 'tool:read', 'tool:write'], plan);
  assert.deepEqual(hidden.tools, ['read', 'write']);
});

test('normalizeStore：坏文件退化为空存储，绝不抛', () => {
  assert.deepEqual(normalizeStore(null), emptyStore());
  assert.deepEqual(normalizeStore('nope'), emptyStore());
  assert.deepEqual(normalizeStore({ version: 1 }), emptyStore());
  assert.deepEqual(normalizeStore({ overrides: [] }), emptyStore());
});

test('normalizeStore：逐条清洗、去重、排序、归一化键', () => {
  const store = normalizeStore({
    version: 99,
    overrides: {
      'D:\\Projects\\Api': ['tool:b', 'tool:a', 'tool:a', '   '],
      '': ['tool:x'],
      'C:\\Work': [],
      'C:\\Bad': 'not-an-array',
    },
  });
  assert.equal(store.version, 1);
  assert.deepEqual(store.overrides, { 'd:/projects/api': ['tool:a', 'tool:b'] });
});

test('withHidden：写入、覆盖、清空', () => {
  const first = withHidden(emptyStore(), 'D:\\Projects', ['tool:a']);
  assert.deepEqual(first.overrides, { 'd:/projects': ['tool:a'] });

  const second = withHidden(first, 'd:/projects', ['tool:b', 'tool:a']);
  assert.deepEqual(second.overrides, { 'd:/projects': ['tool:a', 'tool:b'] });

  const third = withHidden(second, 'D:\\Projects', []);
  assert.deepEqual(third.overrides, {});

  // 不修改入参
  assert.deepEqual(second.overrides, { 'd:/projects': ['tool:a', 'tool:b'] });
});

test('withHidden：空目录键不写入任何东西', () => {
  const store = withHidden(emptyStore(), '', ['tool:a']);
  assert.deepEqual(store.overrides, {});
});

test('estimateChars 只数真正隐藏掉的东西', () => {
  const plan = {
    toolChars: new Map([['read', 400], ['write', 300]]),
    sectionText: new Map([['prompt-toggle:main', 4000]]),
  };
  const chars = estimateChars({ tools: ['read'], sections: ['prompt-toggle:main'] }, plan);
  assert.equal(chars, 4400);
  assert.equal(estimateChars({ tools: ['ghost'], sections: [] }, plan), 0);
});

test('normalizeStore：assignments 只收合法 spec，withHidden 不会把它弄丢', () => {
  const store = normalizeStore({
    overrides: { 'D:\\A': ['tool:x'] },
    assignments: {
      'tool:read': 'tool-fs',
      'section:foo:bar': 'foo',
      'bogus:thing': 'y',
      'tool:empty': '   ',
      'tool:write': 42,
    },
  });
  assert.deepEqual(store.assignments, {
    'tool:read': 'tool-fs',
    'section:foo:bar': 'foo',
    'tool:write': '42',
  });

  const next = withHidden(store, 'D:\\B', ['tool:y']);
  assert.deepEqual(next.assignments, store.assignments);
});

test('withAssignments：设置与撤销，且不动 overrides', () => {
  const base = withHidden(emptyStore(), 'D:\\A', ['tool:x']);
  const withOne = withAssignments(base, [{ spec: 'tool:read', group: 'tool-fs' }]);
  assert.deepEqual(withOne.assignments, { 'tool:read': 'tool-fs' });
  assert.deepEqual(withOne.overrides, { 'd:/a': ['tool:x'] });

  const cleared = withAssignments(withOne, [{ spec: 'tool:read', group: '' }]);
  assert.deepEqual(cleared.assignments, {});

  // 非法 spec 被忽略
  const bad = withAssignments(withOne, [{ spec: 'nonsense', group: 'x' }]);
  assert.deepEqual(bad.assignments, { 'tool:read': 'tool-fs' });
});

test('applyAssignments：把未归属的工具手工收进新分组', () => {
  const plan = {
    groups: [{ id: 'web-search-free', tools: ['free_search_test'], sections: [] }],
    unassigned: { tools: ['read', 'write'], sections: ['tool:read'] },
  };
  const moved = applyAssignments(plan, {
    'tool:read': 'tool-fs',
    'tool:write': 'tool-fs',
    'section:tool:read': 'tool-fs',
  });
  const byId = new Map(moved.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('web-search-free').tools, ['free_search_test']);
  assert.deepEqual(byId.get('tool-fs').tools, ['read', 'write']);
  assert.deepEqual(byId.get('tool-fs').sections, ['tool:read']);
  assert.deepEqual(moved.unassigned, { tools: [], sections: [] });
});

test('applyAssignments：也能把已在某组的名字挪到另一组', () => {
  const plan = {
    groups: [{ id: 'a', tools: ['x'], sections: [] }, { id: 'b', tools: [], sections: [] }],
    unassigned: { tools: [], sections: [] },
  };
  const moved = applyAssignments(plan, { 'tool:x': 'b' });
  const byId = new Map(moved.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('b').tools, ['x']);
  // a 被搬空后不再出现
  assert.equal(byId.has('a'), false);
  assert.deepEqual([...byId.keys()], ['b']);
});

test('applyAssignments：名字已不存在时不产生幽灵条目', () => {
  const plan = { groups: [], unassigned: { tools: [], sections: [] } };
  const moved = applyAssignments(plan, { 'tool:ghost': 'x' });
  assert.deepEqual(moved.groups, []);
  assert.deepEqual(moved.unassigned, { tools: [], sections: [] });
});

test('applyAssignments：没有 assignments 时原样返回', () => {
  const plan = { groups: [], unassigned: { tools: ['a'], sections: [] } };
  assert.equal(applyAssignments(plan, {}), plan);
  assert.equal(applyAssignments(plan, undefined), plan);
});

