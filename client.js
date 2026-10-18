/**
 * dsh-workspace-gate —— Client 半（浏览器侧）。
 *
 * 视觉规格照官方插件管理页（图一那种）：单列、行式列表，每行 = 图标块 + 标题(+标签)
 * + 一行灰描述 + 行尾估算与开关；悬停整行轻微变底色。不用卡片、不用药丸堆。
 *
 * 颜色**只用** `--dsw-alias-*` 主题 token（practices.md 的硬规矩），字面颜色一概不写，
 * 这样明暗主题自动跟随。
 *
 * 数据：Host 半用 webServer 自注册了 `/workspace-gate/state|apply|refresh`，
 * 这里同源 fetch。模块级 inject 只能写 ['slots']，可选服务一律 ctx.inject 晚绑定。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-gate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'workspace-gate';
    const API = '/workspace-gate';

    const zh = {
      tab: '按工作区',
      lead: '插件照常加载；勾掉的插件，它的工具与提示词段不再进入这个目录的请求。',
      rescan: '重新扫描',
      workspaces: '工作区',
      addDir: '添加目录',
      add: '加入',
      addPlaceholder: 'D:\\Projects',
      store: '存储',
      groups: '插件组',
      filter: '筛选…',
      groupOn: '已关',
      groupOff: '可见',
      full: (n) => `共 ${n} 组`,
      saved: (n) => `已关 ${n} 组`,
      approxTokens: (n) => `≈ ${n}`,
      tokensUnit: 'tokens / 轮',
      tools: (n) => `${n} 工具`,
      sections: (n) => `${n} 段`,
      expand: '展开',
      collapse: '收起',
      unassigned: '未归属',
      unassignedDesc: '认不出属于哪个插件，保持可见；展开后可逐个点名。',
      reserved: '保留',
      origin_official: '官方',
      origin_experimental: '官方可选包',
      origin_user: '第三方',
      origin_unknown: '未识别来源',
      origin_manual: '自定义分组',
      autoGroup: '自动归属',
      newGroup: '+ 新建分组…',
      groupName: '分组名',
      assignHint: '手工指定这一项归到哪个分组；「自动归属」= 交回自动推断',
      partial: '部分',
      save: '保存',
      saving: '保存中…',
      clear: '清空',
      dirty: '有未保存改动',
      ok: '已保存，对新会话生效',
      failed: '保存失败：',
      loadFailed: '读不到门控状态：',
      loading: '正在读取…',
      emptyGroups: '当前 profile 里没有能归到插件的工具或提示词段。',
      noneYet: '还没有工作区，点右上角「添加目录」。',
      followGlobal: '跟随全局',
      hasOwn: '有单独配置',
      switchLabel: (name) => `切换 ${name} 的可见性`,
      descTools: '工具',
      descSections: '段',
    };

    const en = {
      tab: 'By workspace',
      lead: 'Plugins still load; whatever you switch off keeps its tools and prompt sections out of this directory’s requests.',
      rescan: 'Rescan',
      workspaces: 'Workspaces',
      addDir: 'Add directory',
      add: 'Add',
      addPlaceholder: 'D:\\Projects',
      store: 'Store',
      groups: 'Plugin groups',
      filter: 'Filter…',
      groupOn: 'off',
      groupOff: 'visible',
      full: (n) => `${n} groups`,
      saved: (n) => `${n} off`,
      approxTokens: (n) => `≈ ${n}`,
      tokensUnit: 'tokens / turn',
      tools: (n) => `${n} tools`,
      sections: (n) => `${n} sections`,
      expand: 'Expand',
      collapse: 'Collapse',
      unassigned: 'Unassigned',
      unassignedDesc: 'Owner unknown, so they stay visible. Expand to name them one by one.',
      reserved: 'reserved',
      origin_official: 'official',
      origin_experimental: 'official optional',
      origin_user: 'third-party',
      origin_unknown: 'unknown origin',
      origin_manual: 'custom groups',
      autoGroup: 'auto',
      newGroup: '+ new group…',
      groupName: 'Group name',
      assignHint: 'Pick which group this item belongs to; “auto” hands it back to inference',
      partial: 'partly',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Clear',
      dirty: 'Unsaved changes',
      ok: 'Saved. Applies to new sessions.',
      failed: 'Save failed: ',
      loadFailed: 'Cannot read gate state: ',
      loading: 'Reading…',
      emptyGroups: 'No tool or prompt section in this profile maps to a plugin.',
      noneYet: 'No workspace yet — use “Add directory”.',
      followGlobal: 'follows global',
      hasOwn: 'own override',
      switchLabel: (name) => `Toggle ${name} visibility`,
      descTools: 'tools',
      descSections: 'sections',
    };

    function safeGet(ctx, service) {
      try {
        return ctx.get(service);
      } catch (error) {
        return undefined;
      }
    }

    // 颜色全部走主题 token；几何值用数字
    const T = {
      bgBase: 'var(--dsw-alias-bg-base)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      label: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    const S = {
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      title: { fontSize: 14, fontWeight: 600, color: T.label, lineHeight: '20px' },
      desc: {
        fontSize: 12,
        color: T.muted,
        lineHeight: '18px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      ghost: {
        border: 'none',
        background: 'transparent',
        color: T.muted,
        borderRadius: 7,
        padding: '4px 8px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      primary: {
        border: `1px solid ${T.brand}`,
        background: T.brand,
        color: T.bgBase,
        borderRadius: 8,
        padding: '6px 16px',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      input: {
        boxSizing: 'border-box',
        color: T.label,
        background: T.bg1,
        border: `1px solid ${T.border1}`,
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 12,
        outline: 'none',
      },
      tag: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 6px',
        height: 18,
        borderRadius: 5,
        fontSize: 11,
        lineHeight: '18px',
        color: T.muted,
        background: T.bg2,
        whiteSpace: 'nowrap',
      },
    };

    function monogram(label) {
      const s = String(label || '').trim();
      if (!s) return '·';
      if (/[\u3400-\u9fff]/.test(s[0])) return s.slice(0, 2);
      const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return s.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '·';
    }

    function Switch({ checked, disabled, onToggle, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          'aria-label': label,
          title: label,
          disabled: disabled === true,
          onClick: (event) => {
            event.stopPropagation();
            onToggle(checked !== true);
          },
          style: {
            flex: '0 0 auto',
            position: 'relative',
            width: 36,
            height: 21,
            padding: 0,
            borderRadius: 999,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.45 : 1,
            background: checked ? T.brand : T.bg2,
            border: `1px solid ${checked ? T.brand : T.border2}`,
            transition: 'background 140ms ease, border-color 140ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 17 : 2,
            width: 15,
            height: 15,
            borderRadius: '50%',
            background: checked ? T.bgBase : T.muted,
            transition: 'left 140ms ease',
          },
        }),
      );
    }

    function formatTokens(chars) {
      const tokens = Math.round((Number(chars) || 0) / 4);
      return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
    }

    function buildPanel(ctx, t) {
      function useGateState() {
        const [snapshot, setSnapshot] = React.useState(null);
        const [error, setError] = React.useState(null);
        React.useEffect(() => {
          let alive = true;
          fetch(`${API}/state`)
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data) => {
              if (alive) setSnapshot(data);
            })
            .catch((cause) => {
              if (alive) setError(String(cause && cause.message ? cause.message : cause));
            });
          return () => {
            alive = false;
          };
        }, []);
        return { snapshot, setSnapshot, error };
      }

      return function Panel() {
        const { snapshot, setSnapshot, error } = useGateState();
        const [dir, setDir] = React.useState('');
        const [hidden, setHidden] = React.useState([]);
        const [expanded, setExpanded] = React.useState({});
        const [openUnassigned, setOpenUnassigned] = React.useState(false);
        // 三类目录：第三方默认展开（工作区级开关主要就为它），官方与官方可选包默认收起
        const [closedBuckets, setClosedBuckets] = React.useState({
          official: true,
          experimental: true,
          unknown: true,
        });
        const [creating, setCreating] = React.useState(null);
        const [filter, setFilter] = React.useState('');
        const [adding, setAdding] = React.useState(false);
        const [manual, setManual] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState('');

        React.useEffect(() => {
          if (!snapshot || dir) return;
          const configured = Object.keys(snapshot.overrides || {});
          const first = configured.length ? configured[0] : (snapshot.dirs || [])[0] && snapshot.dirs[0].key;
          if (first) setDir(first);
        }, [snapshot, dir]);

        React.useEffect(() => {
          if (!snapshot || !dir) return;
          const specs = (snapshot.overrides || {})[dir];
          setHidden(Array.isArray(specs) ? [...specs] : []);
          setMessage('');
        }, [snapshot, dir]);

        const hiddenSet = React.useMemo(() => new Set(hidden), [hidden]);
        const assignmentMap = React.useMemo(() => (snapshot && snapshot.assignments) || {}, [snapshot]);

        const groups = React.useMemo(() => {
          const all = (snapshot && snapshot.groups) || [];
          const q = filter.trim().toLowerCase();
          if (!q) return all;
          return all.filter(
            (g) =>
              g.id.toLowerCase().includes(q) ||
              String(g.title || '').toLowerCase().includes(q) ||
              g.tools.some((n) => n.toLowerCase().includes(q)) ||
              g.sections.some((n) => n.toLowerCase().includes(q)),
          );
        }, [snapshot, filter]);

        const savedJson = React.useMemo(() => {
          const specs = (snapshot && snapshot.overrides && snapshot.overrides[dir]) || [];
          return JSON.stringify([...specs].sort());
        }, [snapshot, dir]);
        const dirty = JSON.stringify([...hidden].sort()) !== savedJson;

        const savedChars = React.useMemo(() => {
          if (!snapshot) return 0;
          const all = snapshot.groups || [];
          const byId = new Map(all.map((g) => [g.id, g]));
          let chars = 0;
          for (const spec of hidden) {
            const sep = spec.indexOf(':');
            const kind = spec.slice(0, sep);
            const rest = spec.slice(sep + 1);
            if (kind === 'plugin') {
              const g = byId.get(rest);
              if (g) chars += g.chars || 0;
            } else {
              const g = all.find((x) => x.tools.includes(rest) || x.sections.includes(rest));
              if (g) {
                const per = (g.tools.length || 0) + (g.sections.length || 0) || 1;
                chars += Math.round((g.chars || 0) / per);
              }
            }
          }
          return chars;
        }, [snapshot, hidden]);

        const offGroups = hidden.filter((s) => s.startsWith('plugin:')).length;
        const totalGroups = (snapshot && snapshot.groups && snapshot.groups.length) || 0;

        const toggleSpec = (spec, on) => {
          setHidden((prev) => {
            const next = new Set(prev);
            if (on) next.add(spec);
            else next.delete(spec);
            return [...next].sort();
          });
        };

        const post = (path, body) =>
          fetch(`${API}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          }).then((res) =>
            res.ok
              ? res.json()
              : res
                  .json()
                  .then((b) => Promise.reject(new Error((b && b.error) || `HTTP ${res.status}`)))
                  .catch((err) => Promise.reject(err instanceof Error ? err : new Error(`HTTP ${res.status}`))),
          );

        /** 手工指定某一项归到哪个分组；group 传空串 = 撤销、回到自动归属。 */
        const assign = (spec, group) => {
          if (busy) return;
          setBusy(true);
          post('/assign', { entries: [{ spec, group }] })
            .then((data) => {
              if (data && data.groups) setSnapshot(data);
            })
            .catch((cause) => setMessage(t('failed') + String(cause && cause.message ? cause.message : cause)))
            .finally(() => setBusy(false));
        };

        const save = () => {
          if (!dir || busy) return;
          setBusy(true);
          setMessage('');
          post('/apply', { dir, hidden })
            .then((data) => {
              if (data && data.groups) setSnapshot(data);
              setMessage(t('ok'));
            })
            .catch((cause) => setMessage(t('failed') + String(cause && cause.message ? cause.message : cause)))
            .finally(() => setBusy(false));
        };

        const rescan = () => {
          if (busy) return;
          setBusy(true);
          fetch(`${API}/refresh`)
            .then((res) => res.json())
            .then((data) => setSnapshot(data))
            .catch(() => undefined)
            .finally(() => setBusy(false));
        };

        const addDir = () => {
          const value = manual.trim();
          if (!value) return;
          const key = value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          setSnapshot((prev) => {
            if (!prev) return prev;
            if ((prev.dirs || []).some((d) => d.key === key)) return prev;
            return {
              ...prev,
              dirs: [...(prev.dirs || []), { key, path: value, title: '', source: 'manual', sessions: 0, hidden: [] }].sort(
                (a, b) => String(a.path).localeCompare(String(b.path)),
              ),
            };
          });
          setDir(key);
          setManual('');
          setAdding(false);
        };

        if (error) {
          return h('div', { style: { padding: '24px 2px', color: T.error, fontSize: 13 } }, t('loadFailed') + error);
        }
        if (!snapshot) {
          return h('div', { style: { padding: '24px 2px', color: T.muted, fontSize: 13 } }, t('loading'));
        }

        const dirs = snapshot.dirs || [];
        const activeDir = dirs.find((d) => d.key === dir);
        const hasOwnOverride = Boolean(activeDir && activeDir.hidden && activeDir.hidden.length);

        // ── 工作区切换（一行 chip，选中态加深）
        const dirChips = dirs.map((entry) => {
          const selected = entry.key === dir;
          const count = Array.isArray(entry.hidden) ? entry.hidden.length : 0;
          const label = entry.title || entry.path.split(/[\\/]/).pop() || entry.path;
          return h(
            'button',
            {
              key: entry.key,
              type: 'button',
              title: entry.path,
              onClick: () => setDir(entry.key),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: 260,
                padding: '5px 11px',
                borderRadius: 999,
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: '18px',
                color: selected ? T.label : T.muted,
                background: selected ? T.bg2 : 'transparent',
                border: `1px solid ${selected ? T.border2 : T.border1}`,
                transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
              },
            },
            [
              h(
                'span',
                { key: 'l', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                label,
              ),
              count ? h('span', { key: 'c', style: { ...S.mono, fontSize: 10, color: T.brand } }, String(count)) : null,
            ],
          );
        });

        // ── 一级行：图标块 + 标题 + 灰描述 + 估算 + 开关
        const nameRow = (spec, name, reserved) => {
          const checked = hiddenSet.has(spec);
          const current = assignmentMap[spec] || '';
          const isCreating = creating && creating.spec === spec;
          const known = groups.some((group) => group.id.toLowerCase() === current.toLowerCase());
          return h(
            'div',
            {
              key: spec,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '4px 10px 4px 52px',
                borderRadius: 8,
                color: reserved ? T.muted : T.label,
                fontSize: 12,
              },
              onMouseEnter: (e) => {
                if (!reserved) e.currentTarget.style.background = T.bg2;
              },
              onMouseLeave: (e) => {
                e.currentTarget.style.background = 'transparent';
              },
            },
            [
              h('input', {
                key: 'i',
                type: 'checkbox',
                checked,
                disabled: reserved || busy,
                onChange: (event) => toggleSpec(spec, event.target.checked === true),
                style: { accentColor: T.brand, margin: 0, cursor: reserved ? 'default' : 'pointer' },
              }),
              h('span', { key: 'n', style: S.mono }, name),
              reserved ? h('span', { key: 'r', style: S.tag }, t('reserved')) : null,
              h('span', { key: 'sp', style: { marginLeft: 'auto' } }),
              isCreating
                ? h('input', {
                    key: 'ni',
                    autoFocus: true,
                    type: 'text',
                    value: creating.value,
                    placeholder: t('groupName'),
                    onChange: (event) => setCreating({ spec, value: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        const name = creating.value.trim();
                        if (name) assign(spec, name);
                        setCreating(null);
                      }
                      if (event.key === 'Escape') setCreating(null);
                    },
                    onBlur: () => setCreating(null),
                    style: { ...S.input, width: 130, fontSize: 11, padding: '2px 6px' },
                  })
                : h(
                    'select',
                    {
                      key: 'sel',
                      value: current,
                      disabled: busy,
                      title: t('assignHint'),
                      onChange: (event) => {
                        const next = event.target.value;
                        if (next === '__new__') {
                          setCreating({ spec, value: name.split(/[_:.-]/)[0] || name });
                          return;
                        }
                        assign(spec, next);
                      },
                      style: {
                        ...S.input,
                        width: 118,
                        fontSize: 11,
                        padding: '1px 4px',
                        color: current ? T.label : T.muted,
                      },
                    },
                    [
                      h('option', { key: 'auto', value: '' }, t('autoGroup')),
                      ...groups.map((group) =>
                        h('option', { key: group.id, value: group.id }, group.title || group.id),
                      ),
                      current && !known ? h('option', { key: current, value: current }, current) : null,
                      h('option', { key: '__new__', value: '__new__' }, t('newGroup')),
                    ],
                  ),
            ],
          );
        };

        const groupRow = (group) => {
          const pluginSpec = `plugin:${group.id}`;
          const on = hiddenSet.has(pluginSpec);
          const childSpecs = [...group.tools.map((n) => `tool:${n}`), ...group.sections.map((n) => `section:${n}`)];
          const partial = !on && childSpecs.some((spec) => hiddenSet.has(spec));
          const open = expanded[group.id] === true;
          const title = group.title || group.id;
          const toolNames = group.tools.length ? `${t('descTools')}: ${group.tools.slice(0, 4).join('、')}${group.tools.length > 4 ? ' …' : ''}` : '';
          const sectionNames = group.sections.length
            ? `${t('descSections')}: ${group.sections.slice(0, 3).join('、')}${group.sections.length > 3 ? ' …' : ''}`
            : '';
          const description = [toolNames, sectionNames].filter(Boolean).join('   ');

          return h('div', { key: group.id }, [
            h(
              'div',
              {
                key: 'row',
                onClick: () => setExpanded((prev) => ({ ...prev, [group.id]: !open })),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '9px 10px',
                  borderRadius: 10,
                  cursor: 'pointer',
                  background: on ? T.bg1 : 'transparent',
                  transition: 'background 120ms ease',
                },
                onMouseEnter: (e) => {
                  e.currentTarget.style.background = T.bg1;
                },
                onMouseLeave: (e) => {
                  e.currentTarget.style.background = on ? T.bg1 : 'transparent';
                },
              },
              [
                h(
                  'div',
                  {
                    key: 'icon',
                    style: {
                      flex: '0 0 auto',
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: T.bg2,
                      color: on ? T.brand : T.muted,
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 0.2,
                    },
                  },
                  monogram(title),
                ),
                h(
                  'div',
                  { key: 'text', style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
                  [
                    h(
                      'div',
                      { key: 'line1', style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
                      [
                        h('span', { key: 't', style: { ...S.title, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
                        group.title && group.title !== group.id
                          ? h('span', { key: 'id', style: { ...S.mono, fontSize: 11, color: T.muted } }, group.id)
                          : null,
                        group.tools.length ? h('span', { key: 'tg', style: S.tag }, t('tools', group.tools.length)) : null,
                        group.sections.length
                          ? h('span', { key: 'sg', style: S.tag }, t('sections', group.sections.length))
                          : null,
                        group.origin && group.origin !== 'unknown'
                          ? h(
                              'span',
                              {
                                key: 'og',
                                style: {
                                  ...S.tag,
                                  color:
                                    group.origin === 'user'
                                      ? T.muted
                                      : group.origin === 'experimental'
                                        ? T.warn
                                        : T.brand,
                                },
                              },
                              t(`origin_${group.origin}`),
                            )
                          : null,
                        partial ? h('span', { key: 'pg', style: { ...S.tag, color: T.warn } }, t('partial')) : null,
                      ],
                    ),
                    h('div', { key: 'line2', style: S.desc }, description || group.id),
                  ],
                ),
                group.chars
                  ? h(
                      'span',
                      {
                        key: 'tok',
                        title: `${t('approxTokens', formatTokens(group.chars))} ${t('tokensUnit')}`,
                        style: { ...S.mono, fontSize: 11, color: T.muted, flex: '0 0 auto' },
                      },
                      t('approxTokens', formatTokens(group.chars)),
                    )
                  : null,
                childSpecs.length
                  ? h(
                      'button',
                      {
                        key: 'chev',
                        type: 'button',
                        'aria-label': open ? t('collapse') : t('expand'),
                        onClick: (event) => {
                          event.stopPropagation();
                          setExpanded((prev) => ({ ...prev, [group.id]: !open }));
                        },
                        style: {
                          ...S.ghost,
                          flex: '0 0 auto',
                          transform: open ? 'rotate(90deg)' : 'none',
                          transition: 'transform 140ms ease',
                        },
                      },
                      '›',
                    )
                  : h('span', { key: 'chev', style: { width: 28, flex: '0 0 auto' } }),
                h(Switch, {
                  key: 'sw',
                  checked: on,
                  disabled: busy,
                  onToggle: (next) => toggleSpec(pluginSpec, next),
                  label: t('switchLabel', title),
                }),
              ],
            ),
            open
              ? h(
                  'div',
                  {
                    key: 'body',
                    style: {
                      margin: '2px 10px 6px 58px',
                      padding: '4px 6px',
                      borderRadius: 8,
                      background: T.bg1,
                      border: `1px solid ${T.border1}`,
                    },
                  },
                  [
                    ...group.tools.map((name) => nameRow(`tool:${name}`, name, false)),
                    ...group.sections.map((name) => nameRow(`section:${name}`, name, false)),
                  ],
                )
              : null,
          ]);
        };

        // 按来源分三（四）类目录；顺序固定：第三方 → 官方 → 实验性 → 未识别
        const ORIGIN_ORDER = ['user', 'manual', 'official', 'experimental', 'unknown'];
        const bucketMap = new Map(ORIGIN_ORDER.map((key) => [key, []]));
        for (const group of groups) {
          const key = group.origin && bucketMap.has(group.origin) ? group.origin : 'unknown';
          bucketMap.get(key).push(group);
        }

        const bucketRows = ORIGIN_ORDER.filter((key) => bucketMap.get(key).length > 0).map((key) => {
          const list = bucketMap.get(key);
          const open = !closedBuckets[key];
          const chars = list.reduce((sum, g) => sum + (g.chars || 0), 0);
          const offIn = list.filter((g) => hiddenSet.has(`plugin:${g.id}`)).length;
          return h('div', { key: `bucket-${key}`, style: { display: 'flex', flexDirection: 'column' } }, [
            h(
              'div',
              {
                key: 'head',
                role: 'button',
                tabIndex: 0,
                'aria-expanded': open === true,
                onClick: () => setClosedBuckets((prev) => ({ ...prev, [key]: !prev[key] })),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setClosedBuckets((prev) => ({ ...prev, [key]: !prev[key] }));
                  }
                },
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontSize: 12,
                  color: T.muted,
                },
                onMouseEnter: (e) => {
                  e.currentTarget.style.background = T.bg1;
                },
                onMouseLeave: (e) => {
                  e.currentTarget.style.background = 'transparent';
                },
              },
              [
                h(
                  'span',
                  {
                    key: 'chev',
                    style: {
                      display: 'inline-block',
                      width: 14,
                      color: T.muted,
                      transform: open ? 'rotate(90deg)' : 'none',
                      transition: 'transform 140ms ease',
                    },
                  },
                  '›',
                ),
                h(
                  'span',
                  {
                    key: 'title',
                    style: {
                      fontWeight: 600,
                      color: T.label,
                      cursor: 'pointer',
                    },
                  },
                  t(`origin_${key}`),
                ),
                h('span', { key: 'count', style: { ...S.mono, fontSize: 11 } }, String(list.length)),
                chars
                  ? h(
                      'span',
                      { key: 'tok', style: { ...S.mono, fontSize: 11, marginLeft: 'auto' } },
                      t('approxTokens', formatTokens(chars)),
                    )
                  : h('span', { key: 'tok', style: { marginLeft: 'auto' } }),
                offIn ? h('span', { key: 'off', style: { color: T.brand, fontSize: 11 } }, t('saved', offIn)) : null,
              ],
            ),
            open
              ? h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column' } }, list.map(groupRow))
              : null,
          ]);
        });

        const unassigned = snapshot.unassigned || { tools: [], sections: [] };
        const unassignedCount = (unassigned.tools || []).length + (unassigned.sections || []).length;
        const unassignedBlock = unassignedCount
          ? h('div', { key: 'unassigned', style: { marginTop: 4 } }, [
              h(
                'div',
                {
                  key: 'row',
                  onClick: () => setOpenUnassigned((prev) => !prev),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '9px 10px',
                    borderRadius: 10,
                    cursor: 'pointer',
                  },
                  onMouseEnter: (e) => {
                    e.currentTarget.style.background = T.bg1;
                  },
                  onMouseLeave: (e) => {
                    e.currentTarget.style.background = 'transparent';
                  },
                },
                [
                  h(
                    'div',
                    {
                      key: 'icon',
                      style: {
                        flex: '0 0 auto',
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: T.bg2,
                        color: T.muted,
                        fontSize: 12,
                        fontWeight: 700,
                      },
                    },
                    monogram(t('unassigned')),
                  ),
                  h(
                    'div',
                    { key: 'text', style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
                    [
                      h('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 7 } }, [
                        h('span', { key: 't', style: S.title }, t('unassigned')),
                        h('span', { key: 'c', style: S.tag }, String(unassignedCount)),
                      ]),
                      h('div', { key: 'l2', style: S.desc }, t('unassignedDesc')),
                    ],
                  ),
                  h(
                    'button',
                    {
                      key: 'chev',
                      type: 'button',
                      onClick: (event) => {
                        event.stopPropagation();
                        setOpenUnassigned((prev) => !prev);
                      },
                      style: {
                        ...S.ghost,
                        flex: '0 0 auto',
                        transform: openUnassigned ? 'rotate(90deg)' : 'none',
                        transition: 'transform 140ms ease',
                      },
                    },
                    '›',
                  ),
                  h('span', { key: 'pad', style: { width: 36, flex: '0 0 auto' } }),
                ],
              ),
              openUnassigned
                ? h(
                    'div',
                    {
                      key: 'body',
                      style: {
                        margin: '2px 10px 6px 58px',
                        padding: '4px 6px',
                        borderRadius: 8,
                        background: T.bg1,
                        border: `1px solid ${T.border1}`,
                      },
                    },
                    [
                      ...(unassigned.tools || []).map((name) => nameRow(`tool:${name}`, name, false)),
                      ...(unassigned.sections || []).map((name) => nameRow(`section:${name}`, name, false)),
                    ],
                  )
                : null,
            ])
          : null;

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0 8px' } }, [
          // 顶部说明 + 重新扫描
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'flex-start', gap: 12 } }, [
            h(
              'div',
              { key: 'lead', style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, color: T.muted, lineHeight: '18px' } },
              [
                h('div', { key: 'a' }, t('lead')),
                h('div', { key: 'b', style: { ...S.mono, fontSize: 11, marginTop: 2 } }, `${t('store')}: ${snapshot.storePath || '—'}`),
              ],
            ),
            h('button', { key: 'rescan', type: 'button', style: S.ghost, disabled: busy, onClick: rescan }, t('rescan')),
          ]),

          // 工作区 chips + 添加目录
          h('div', { key: 'dirs', style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
            h('span', { key: 'lb', style: { fontSize: 12, color: T.muted, marginRight: 2 } }, t('workspaces')),
            ...dirChips,
            adding
              ? h('span', { key: 'aa', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
                  h('input', {
                    key: 'i',
                    autoFocus: true,
                    type: 'text',
                    value: manual,
                    placeholder: t('addPlaceholder'),
                    onChange: (event) => setManual(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') addDir();
                      if (event.key === 'Escape') setAdding(false);
                    },
                    style: { ...S.input, ...S.mono, width: 200, fontSize: 11 },
                  }),
                  h('button', { key: 'b', type: 'button', style: S.ghost, onClick: addDir }, t('add')),
                ])
              : h(
                  'button',
                  { key: 'add', type: 'button', style: { ...S.ghost, border: `1px dashed ${T.border2}` }, onClick: () => setAdding(true) },
                  `+ ${t('addDir')}`,
                ),
          ]),

          // 当前目录状态
          h('div', { key: 'status', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: T.muted } }, [
            h('span', { key: 'p', style: { ...S.mono, fontSize: 11, color: T.label } }, activeDir ? activeDir.path : dir),
            h('span', { key: 'o' }, hasOwnOverride ? `· ${t('hasOwn')}` : `· ${t('followGlobal')}`),
            h('span', { key: 's' }, `· ${t('saved', offGroups)} · ${t('full', totalGroups)}`),
            savedChars ? h('span', { key: 't', style: { color: T.brand } }, `· ${t('approxTokens', formatTokens(savedChars))} ${t('tokensUnit')}`) : null,
            dirty ? h('span', { key: 'd', style: { color: T.warn } }, `· ${t('dirty')}`) : null,
          ]),

          // 列表头：分组标题 + 筛选
          h('div', { key: 'listhead', style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 2 } }, [
            h('span', { key: 'g', style: { fontSize: 12, color: T.muted } }, t('groups')),
            h('span', { key: 'f', style: { marginLeft: 'auto', display: 'flex' } }, [
              h('input', {
                key: 'i',
                type: 'text',
                value: filter,
                placeholder: t('filter'),
                onChange: (event) => setFilter(event.target.value),
                style: { ...S.input, width: 180, fontSize: 11 },
              }),
            ]),
          ]),

          h(
            'div',
            { key: 'list', style: { display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden' } },
            groups.length
              ? bucketRows
              : [h('div', { key: 'e', style: { padding: '14px 2px', fontSize: 12, color: T.muted } }, t('emptyGroups'))],
          ),

          unassignedBlock,

          // 底部操作
          h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } }, [
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                style: { ...S.primary, opacity: busy || !dir || !dirty ? 0.5 : 1, cursor: busy || !dir || !dirty ? 'default' : 'pointer' },
                disabled: busy || !dir || !dirty,
                onClick: save,
              },
              busy ? t('saving') : t('save'),
            ),
            h(
              'button',
              { key: 'clear', type: 'button', style: S.ghost, disabled: busy || !dir || hidden.length === 0, onClick: () => setHidden([]) },
              t('clear'),
            ),
            message ? h('span', { key: 'm', style: { fontSize: 11, color: T.success } }, message) : null,
          ]),
        ]);
      };
    }

    return {
      name: 'workspace-gate',
      inject: ['slots'],
      apply(ctx) {
        const dict = { zh, en };
        const boxes = { locale: { current: undefined } };
        const builtinDict = () => {
          try {
            return String(navigator.language || '').toLowerCase().startsWith('zh') ? zh : en;
          } catch (error) {
            return zh;
          }
        };
        const t = (key, ...args) => {
          const bound = boxes.locale.current;
          if (typeof bound === 'function') {
            try {
              const value = bound(key, ...args);
              if (typeof value === 'string' && value !== key) return value;
            } catch (error) {
              /* 宿主词典没有这条，退回内置 */
            }
          }
          const table = builtinDict();
          const value = table[key];
          if (value === undefined) return key;
          return typeof value === 'function' ? value(...args) : value;
        };

        const Panel = buildPanel(ctx, t);

        try {
          ctx.inject(['locale'], (scope) => {
            const locale = safeGet(scope, 'locale');
            if (!locale || typeof locale.register !== 'function') return undefined;
            const off = locale.register(NS, dict);
            boxes.locale.current = typeof locale.bind === 'function' ? locale.bind(NS) : undefined;
            return () => {
              boxes.locale.current = undefined;
              if (typeof off === 'function') off();
            };
          });
        } catch (error) {
          console.error('[workspace-gate] late-bind locale failed:', error);
        }

        try {
          ctx.slots.inject('plugins.tab', () =>
            ctx.slots.register(
              {
                name: 'plugins.tab',
                id: NS,
                order: 40,
                label: () => t('tab'),
                locale: NS,
                inject: () => ({ t }),
              },
              Panel,
            ),
          );
        } catch (error) {
          console.error('[workspace-gate] register plugins.tab failed:', error);
        }
      },
    };
  },
});
