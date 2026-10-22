# DSH 工作区插件管理 · MVP 设计与架构

| 项 | 内容 |
|---|---|
| 版本 | v1.2-MVP（已实装并验证，见 §15） |
| 范围 | **只做一件事：按工作区启用/停用插件，且真实降低 token** |
| 状态 | 设计基线，可进入实现 |
| 前置 | 长版设计（人设/技能/隔离层）另存为远期参考，**不在本 MVP 内** |

---

## 0. 与长版的取舍

| 能力 | 长版 | MVP | 理由 |
|---|---|---|---|
| 工作区级插件开关 | ✅ | ✅ | 核心价值 |
| 禁用后工具 schema 消失 | ✅ | ✅ | token 收益的唯一来源 |
| 人设/整合包按工作区替换 | ✅ | ❌ | 与"插件管理"正交，砍掉 |
| 技能目录裁剪 | ✅（P2） | ❌ | 依赖上游未确认能力 |
| 隔离层（preset / isolate realm） | ✅（可选） | ❌ | 重型方案，代码级隔离不是 MVP 必需 |
| token 预估面板 | ✅（P2） | ❌ | 锦上添花 |
| 运行中热切换 | ✅ | ❌ | MVP 只保证"新会话生效" |

**MVP 一句话**：工作区说"关掉这几个插件"，该工作区的新会话里这些插件的工具**不出现在请求中**；没配置工作区就完全等于现状。

---

## 1. 关键事实（源码已验证，决定架构）

写代码前必须先接受这四条，架构就是它们的直接推论。

### F1. token 的唯一来源是"模型可见面"

`SystemPrompt.assemble()` 把**所有可见工具**投影进请求：
`dsh-system-prompt/lib/index.js` 中
```js
result.schemas.map(({name,description,parameters,deferLoading}) => ({...}))
```
插件代码是否驻留内存与 token 无关。所以**不需要卸载插件**，只需要让工具在该会话不可见。

### F2. `restrict()` 正是"按会话隐藏工具"的官方开关

`dsh-tools/lib/index.js:2991-3006`：
```js
restrict(filter) {          // filter = { allow?: string[], deny?: string[] }
  const scope = scopeOf(this.ctx);
  if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx) ...");
  ...
  const known = this.view(scope).restrictableNames;
  // 名字必须已知（否则抛错）
  return this.layers.effect(this.ctx, layer => layer.restrictions.append(compiled), {label:"tools.restrict()"});
}
```
- **必须在 scoped ctx（`agent.ctx`）里调用**；全局调用会被拒绝（"would mask every agent"）。
- `allow` = 只保留；`deny` = 剔除；**多次 restrict 取交集**。
- 返回 disposer，可精确撤销。

### F3. 被 restrict 的工具"从 schema 消失，但仍是 knownName"

`SystemPrompt` 的 `orderTools` 注释：
> *Unknown configured names fail; **known but restricted names may be absent**.*

⇒ 隐藏工具**不会**让配置了 `toolOrder` 的 profile 报错。这正是我们要的语义。

### F4. 工具注册**不记录来源**（决定 MVP 的归属方案）

`dsh-tools/lib/index.js:2974-2983`：
```js
register(definition) {
  ...
  return this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition), {label:"tools.register()"});
}
```
层里只按 **name** 存 definition。而 `schemaOf()`（3135-3145）只投影
`{name, description, parameters, deferLoading}`，其余字段被丢弃。

**结论：运行时无法回答"这个工具是哪个插件注册的"。**
⇒ MVP 的**执行单元必须是"工具名"**；"插件"是**展示单元**，由本插件维护映射（见 §4）。

---

## 2. 架构

```
┌──────────────── Client (Web) ────────────────┐
│ 工作区 → 插件开关面板                          │
└───────────────┬──────────────────────────────┘
                │ remote service
┌───────────────▼──────────────────────────────┐
│ Host 插件：workspace-plugin-gate               │
│                                                │
│  workspaceOverride (Service)                    │
│      ├─ 读/写自有 storage domain（键=workspaceId）│
│      └─ 提供 list/get/set/clear                  │
│                                                 │
│  toolCatalog (归属映射)                          │
│      ├─ 静态扫描 packageDir/lib/index.js          │
│      ├─ 与全局工具名交叉验证 + 用户覆盖            │
│      └─ 解析 包名 → toolNames[]                    │
│                                                 │
│  gateBinder                                     │
│      └─ on('agent/created') → restrict({deny})   │
└───────────────┬─────────────────────────────────┘
                │ 既有原语（不改核心）
   workspaceRegistry · workingDirectory · tools.restrict · storageDomain
```

**组件职责**

| 组件 | 职责 |
|---|---|
| `workspaceOverride` | 持久化 `{workspaceId → 禁用包名集合}`；串行 mutation |
| `toolCatalog` | `包名 → string[]`（工具名）映射；静态扫描 + 交叉验证 + 用户覆盖，并算未归属工具 |
| `gateBinder` | `agent/created` 时按 `sessionIds` 反查工作区并施加 `restrict` |
| `client panel` | 插件页「按工作区」tab（见 §7） |

---

## 3. 数据模型

### 3.1 为什么开自有 domain

`dsh-workspace` 的 domain 版本为 **2**，`workspaceRecord` 无插件字段。改核心 = v2→v3 迁移 + fork。故本插件 `defineDomain` 自开一域：

```ts
interface WorkspacePluginOverride {
  workspaceId: string;
  disabledPlugins: string[];   // ★ v1.1：插件包名，不再是 entry id
  revision: number;
  updatedAt: string;
}

interface GateDomainState {
  initialized: boolean;
  version: 1;
  overrides: Record<string, WorkspacePluginOverride>;
}
```

所有写走 `mutate()`（与 `dsh-workspace` 同构的两写恢复），完成后发 `domain/changed`。

### 3.2 语义

- **默认 = 不写入 = 完全跟随全局**（MVP 不做三态，只有"关/不关"，减少复杂度）。
- 未配置的工作区：`disabledPlugins` 为空 → **不发 restrict 调用** → 行为与现状 100% 一致。
- **为什么键是包名而不是 entry id**：entry id 由 bundle 的 patch 声明，重装 / 升级 / 重建 composition 时可能变化；包名（如 `@deepseek-ai/dsh-tool-web`）是稳定身份。同一包被声明成多个 entry 时，按包名一并处理，反而更符合用户心智（用户说的是"这个插件"，不是"这条 composition 行"）。

---

## 4. 归属映射（v1.1：自动扫描取代手写表）

因为 F4，必须维护 `插件包名 → toolNames[]`。三层来源，按优先级：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 用户覆盖 | `settings.toolAttribution`，键为包名 |
| 2 | 静态扫描 | 读 `<packageDir>/lib/index.js`，抽 `defineTool` 的 `name:` 候选 |
| 3 | 同名推断 | 包名去 `dsh-tool-` / `dsh-plugin-` 前缀后恰好是个已注册工具名 |

**静态扫描为什么比手写表好**

- `Config.listConfigs` 能给出每个 entry 的 `packageDir`，扫描只是本地读文件，**无需执行插件代码**。
- 候选名必须落在 `ctx.tools.schemas()` 的**现有全局工具名集合**里才采纳（交叉验证），因此不会把文档字符串里出现的词误判成工具。
- 插件升级 → 包内容变 → 映射自动跟上，不存在"内置表过期"这个长期负担。

抽取口径（宽松，由交叉验证兜底）：在包内找 `defineTool(` 调用附近的 `name:\s*['"]([A-Za-z0-9_.-]+)['"]`，以及包内所有字符串常量 `name:`，与全局工具名集合取交。

**未映射的插件**：UI 标 ⚠「无法确定工具，禁用不会减少 token」；仍允许禁用（对未来插件留口），但**不产生 restrict**。

**反向缺口（v1.1 新增）**：`全局工具名 − ∪已映射 = 未归属工具`。UI 单列「未归属工具（N）」，明示这些工具无法被任何工作区门控。不静默，用户才知道边界在哪。

> 执行单元仍是 100% 可靠的"工具名"；展示单元（插件）现在也基本自动了，只剩第三方非常规写法需要人工覆盖。

---

## 5. 生效流程

```js
// 插件 apply() 内，注册在全局 ctx（root 是各 agent 的祖先 → 收得到所有会话事件）
ctx.on('agent/created', async ({ agent }) => {
  try {
    // 1) 反查工作区：走权威的 sessionIds，不按 cwd 路径猜
    const ws = ctx.workspaceRegistry.list()
      .find(w => w.sessionIds.includes(agent.id));
    if (!ws) return;                                    // 无工作区 → 现状

    // 2) 读覆盖（无记录 = 完全跟随全局）
    const override = await workspaceOverride.get(ws.id);
    if (!override?.disabledPlugins.length) return;

    // 3) 解析工具名，并与"真实存在的全局工具"求交（restrict 对未知名抛错）
    const existing = new Set(ctx.tools.schemas(undefined).map(t => t.name));
    const deny = toolCatalog.resolve(override.disabledPlugins)
      .filter(name => existing.has(name));
    if (deny.length === 0) return;

    // 4) 必须作用于该 agent 的 scope
    const dispose = agent.ctx.tools.restrict({ deny });
    agentGates.get(agent.id)?.();                       // 幂等：先撤旧的
    agentGates.set(agent.id, dispose);                  // ← token 收益在此发生
  } catch (error) {
    // agent/created 抛错会让整个会话创建失败 → 必须吞掉并 warn
    ctx.logger?.warn?.('workspace-plugin-gate: apply failed', error);
  }
});

ctx.on('agent/disposed', ({ agent }) => {
  agentGates.get(agent.id)?.();
  agentGates.delete(agent.id);
});
```

**要点（v1.1 修订）**

1. **必须 scoped，且用 `agent.ctx`**：`restrict` 读的是 `scopeOf(this.ctx)`（`dsh-tools/lib/index.js:2991-3006`），全局 ctx 调用直接被拒。`agent/created` 的 `this` 只是 `scopeTarget(agent, agent)` 这个**投递载具**，不等于可用的 ctx；写 `payload.agent.ctx.tools.restrict(...)` 才是对的语义（M0 用一条断言锁定）。
2. **交集对象改成本 agent 的可见面**（v1.2 实测更正）：不能再与 `ctx.tools.schemas(undefined)` 求交——全局视图只有 **19** 个工具，而会话实际看得见 **52–59** 个。正确做法是按 preset 逐个 `agentPresets.acquireScope(id)` 取并集，再与具体 agent 的视图求交（§15）。
3. **四种 source 都要跑**：`startup / resume / clear / compact` 都会重建 agent，逻辑不能只在 `startup` 上挂条件。
4. **幂等 + 显式释放**：同 id 重复 created（compact）时先撤旧 disposer；`agent/disposed` 再删。
5. **吞异常**：`agent/created` 是 serial 且会被 await，抛错等于"插件把用户的会话弄开不起来"。任何失败只 warn，不改现状。
6. **不区分 allow/deny**：MVP 只用 `deny`，语义最直观、最小意外。

---

## 6. 接口

```ts
interface WorkspacePluginGate {
  listOverrides(): Promise<WorkspacePluginOverride[]>;
  getOverride(workspaceId: string): Promise<WorkspacePluginOverride | undefined>;
  setDisabled(workspaceId: string, pluginNames: string[]): Promise<void>;
  clear(workspaceId: string): Promise<void>;

  // 供 UI 预览：这个工作区会隐藏哪些工具、省多少
  preview(workspaceId: string): Promise<{
    plugin: string;            // 包名
    title: string;
    tools: string[];
    mapped: boolean;
    approxTokens: number;      // 该插件工具 schema 的估算 token
  }[]>;

  // v1.1：把覆盖重施到该工作区"已经在跑"的会话
  applyLive(workspaceId: string): Promise<{ applied: number; skipped: number }>;
}
```

**Config / 设置**

```yaml
workspacePluginGate:
  enabled: true
  toolAttribution: {}      # { [packageName]: string[] } 用户覆盖（v1.1：键为包名）
```

**事件**

| 方向 | 事件 | 用途 |
|---|---|---|
| 监听 | `agent/created` | 施加 restrict |
| 监听 | `agent/disposed` | 释放 disposer |
| 监听 | `domain/changed` | 刷新 UI |
| 发出 | `workspace-plugin-gate/changed` | UI 刷新 |

---

## 7. UI 设计（基于已核实的 Client Slot）

### 7.1 挂载点：`plugins.tab`

已核实的 Slot：

| Slot | kind | scope | 用途 |
|---|---|---|---|
| `plugins.tab` | list | root | **插件页自有 Installed 之后的 tab**（现已有 Discover） |
| `plugins.detail.section` | list | root | 某插件详情页内容之后的区块 |
| `plugins.detail.badge` | list | root | 插件详情页标题旁的小徽章 |
| `conversation.hero.options` | list | session | 新会话行右侧的紧凑选项 |

**主入口选 `plugins.tab`**（注册 `id: "workspace"`，`label` 走 locale）。理由：

- 用户对"插件开关"的既有心智就在**插件页**；把按工作区开关放在全局开关旁边，不需要重新教学。
- `plugins.detail.section`（每个插件页显示"哪些工作区停用了它"）与 `plugins.detail.badge`（"2 个工作区已停用"）作为**第二入口**，从"插件"视角反向配置。
- `conversation.hero.options` 放一个**状态芯片**："本工作区停用 3 个插件"，点击 `ctx.layout.selectPanel(<plugins 面板 id>)` 跳过去。
- **不选** `settings.plugins.tab`：那也是合法挂载点，但它在"设置"下，语义是"偏好"；这是"能力范围"，放插件页更准。

### 7.2 页面结构

```
插件页 → [Installed] [Discover] [按工作区]        ← 新增第三个 tab
┌───────────────┬──────────────────────────────────────────────┐
│ 全局默认       │ 学生-高一        D:\study\grade10    [跟随全局] │
│ 学生-高一  ●   ├──────────────────────────────────────────────┤
│ 教师-备课      │ 内置插件                                       │
│ 实验-沙箱      │  ☑ 备课助手 lesson-plan   3 工具  ~1.2k tok    │
│                │  ☑ 脑图 mindmap           1 工具  ~0.4k tok    │
│                │  ☐ 代码执行 shell         2 工具  ~0.9k tok    │
│                │ 官方插件                                       │
│                │  ☐ 网页抓取 web-fetch     1 工具  ~0.3k tok    │
│                │ 第三方插件                                     │
│                │  ☑ xyz-tools              ⚠ 无法确定工具       │
│                ├──────────────────────────────────────────────┤
│                │ ▸ 未归属工具（4）  不属于任何已识别插件的工具    │
│                ├──────────────────────────────────────────────┤
│                │ 已停用 2 个插件 · 约省 1.2k tokens / 请求       │
│                │ [重置为跟随全局]  [应用到当前会话]               │
└───────────────┴──────────────────────────────────────────────┘
```

### 7.3 交互规则

| 场景 | 行为 |
|---|---|
| 未配置的工作区 | 所有行按全局状态显示，顶部标「跟随全局」；**第一次拨动开关**才创建 override 记录 |
| 全局已禁用 | 该行灰显 + 「全局已关闭」，本页不可打开（MVP 只做"收窄"不做"放宽"） |
| 插件归属未知 | ⚠ 徽标 + tooltip「禁用不会减少 token」；仍可关闭（为将来插件留位） |
| 拨动开关 | 乐观更新 → 写宿主 → 失败回滚 + toast；成功 toast「已保存，新会话生效」 |
| 点「应用到当前会话」 | 调 `applyLive(workspaceId)`，对该工作区活跃会话重施 restrict；返回 `{applied, skipped}` |
| 点「重置为跟随全局」 | `clear(workspaceId)`，删记录而不是存空数组，语义干净 |
| 未归属工具区 | 折叠、只读。让人知道"不是全部都能关" |

### 7.4 实现形态（Client 半）

- `package.json` 加 `dsh.client` 段（`platform` / `immediately` / `inject`）+ `./client` 导出；`client.js` 注册**懒工厂**（id = 包名），在 `ctx.slots.register` 里挂到 `plugins.tab`。
- Slot 已自带标准 props：`useWorkspaces`、`useWorkspaceAccess`、`useResource`、`useSessions`、`useRemoteAccess` —— 工作区列表与权限判定不必自造。
- 数据获取走"一条 Host 命令"：`ctx.remote.commands.execute(...)`，宿主侧对应 `WorkspacePluginGate` 的同名方法；`domain/changed` 到达后失效重取。
- 文案走 `ctx.locale.register(ns, ...)`；颜色、间距全部用 theme token，不写死。
- 样式与监听器在 `apply` 内用 `ctx.effect` 注册并返回清理函数（可 HMR、可卸载）。

### 7.5 双调用者（UI + 工具）

按"一个操作、两个调用者"的既有约定，`setDisabled` / `clear` / `preview` 同时暴露成一个 agent 工具（如 `workspace_plugin`，带 `action` 参数），**UI 与工具调同一个宿主方法**，不写两套逻辑。授权类操作（真正放开权限）不由工具代劳——本插件只做"收窄"，天然安全。

---

## 8. 边界、降级、兼容

| 场景 | 行为 |
|---|---|
| 工作区未配置 | 不调用 restrict，行为 = 现状 |
| 条目已卸载 | 映射解析为空 → 忽略，不报错 |
| 工具名不存在 | 过滤掉，不抛错（§5 要点 1） |
| 插件未安装本 MVP | 无影响 |
| 会话无工作区（cwd 不匹配） | 不施加 |
| 会话运行中改配置 | 提示"新会话生效"（MVP 明确不做热切换） |
| 与 agent preset 共存 | restrict 只作用于**继承面**；preset 在 agent 自己层注册的工具剥不掉（源码 3055-3081 的 own-layer 豁免）⇒ 这是能力缺口，UI 对"该工作区有 preset"时标 ⚠ |

---

## 9. 验收标准（可测）

| # | 标准 | 测法 |
|---|---|---|
| A1 | 未配置工作区：请求体与现状**逐字节相同** | 抓 `tokenMeter.measure()` 对比 |
| A2 | 关闭 1 个单工具插件：该工具**不出现在**请求 tools 中 | 同上，检查 tools 数组 |
| A3 | 关闭后 token 数**下降**，降幅 ≈ 该工具 schema 大小 | tokenMeter 差值 |
| A4 | `toolOrder` 配置了被隐藏工具名时**不报错** | 配置该 profile 跑一轮 |
| A5 | 未知映射条目被禁用**不导致任何异常** | 手工造一条假包名 |
| A6 | 卸载映射中的插件后打开工作区**不报错** | 删包 → 重开会话 |
| A7 | 重启 DSH 后覆盖仍在 | 重开 → 检查面板 |

---

## 10. 实现计划（≈3.5 人日）

| 阶段 | 内容 | 产出 | 估时 |
|---|---|---|---|
| M0 | 断言 `agent.ctx.tools.restrict()` 在 `agent/created` 内对目标 agent 生效 | 一页验证记录 | 0.25d |
| M1 | domain + `workspaceOverride` Service + 单测 | 可读写的覆盖表 | 0.5d |
| M2 | `toolCatalog`（静态扫描 + 交叉验证）+ 未归属计算 | 包名→tools 可解析 | 0.5d |
| M3 | `gateBinder` + restrict 施加 + 幂等/释放 + 吞异常 | A1/A2/A4 通过 | 0.5d |
| M4 | 插件页「按工作区」tab（主）+ 插件详情页区块（次） | 可勾选、可看 token | 1.5d |
| M5 | A3/A5/A6/A7 联调 + 文档 | 发布候选 | 0.5d |

---

## 11. 不做清单（明确写下来，防止范围漂移）

- ❌ 人设 / 整合包绑定
- ❌ 技能目录过滤
- ❌ agent preset / isolate realm 隔离
- ❌ 运行中热切换
- ❌ token 预算/成本分析面板（只保留单插件估算这一列）
- ❌ 按工具粒度（而非插件）的 UI
- ❌ 修改 DSH 核心任何包

---

## 12. 风险

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| R1 | ~~`agent/created` 监听器是否带 agent scope~~ | 已定位 | v1.1 结论：用 `payload.agent.ctx.tools`，M0 写断言锁定即可 |
| R2 | 归属覆盖率（第三方非常规写法扫不到） | 体验（部分插件不可省 token） | 静态扫描 + 与全局工具名交叉验证 + ⚠ 标记 + 用户覆盖；长期推动插件自查声明 `dsh.capabilities` |
| R3 | `restrict` 与 agent preset 的 scoped 工具交互 | 语义 | 源码保证 restrict 只作用于继承面；写进验收 |
| R4 | 用户误以为"禁用插件 = 卸载代码" | 预期错位 | UI 文案：**"本工作区不可见（省 token），插件仍在内存"** |
| R5 | 上游内建同能力 | 长期 | 本 MVP 小而正交，易被替代也易撤 |

---

## 13. 一页速览

- **做什么**：每个工作区可以关掉若干插件；该工作区新会话里，这些插件的工具**不再进入请求**。
- **怎么做**：`agent/created` → 解析工作区 → `ctx.tools.restrict({deny:[工具名]})`。
- **为什么可行**：`restrict` 是官方"按会话隐藏工具"的开关（源码 2991-3006），且被隐藏的工具仍是 knownName，不会破坏 `toolOrder`。
- **唯一的坑**：工具注册不记来源（源码 2974-2983），所以要自备 `插件包名 → 工具名` 映射（v1.1 改为静态扫描 + 与现有工具名交叉验证）；执行以工具名为准，展示以插件名为准。
- **必须 scoped**：`restrict` 要用 `agent.ctx.tools`，不是插件自己的 `ctx.tools`。
- **唯一的能力缺口**：agent preset / scoped 注册的工具在 agent 自己层，restrict 剥不掉（§14.4）。
- **不碰核心**：自有 storage domain，`dsh-workspace` 零改动。
- **默认零影响**：不配置 = 不调用 restrict = 现状。

---

## 14. 复审与优化（v1.1）

### 14.1 结论

骨架不动——`restrict` 仍是唯一真实的 token 杠杆。但首版有 **6 处会真实咬人**的地方必须改，另有 **6 处优化**值得进 MVP。改完之后，风险从"可能不可行"降为"照图施工"。

### 14.2 必改项（正确性）

| # | 问题 | 修法 |
|---|---|---|
| C1 | `ctx.tools.restrict()` 在全局 ctx 调用直接抛错 | 用 `payload.agent.ctx.tools`；`agent/created` 的 `this` 只是 `scopeTarget(agent, agent)` 投递载具，不等于可用 ctx |
| C2 | `agent/created` 被 await，抛错 = 用户的会话开不起来 | 整个 binder 包 `try/catch`，只 warn |
| C3 | `source` 有 `startup / resume / clear / compact`，**四种都会重建 agent** | 逻辑无条件跑，不按 source 过滤 |
| C4 | 同一 agent id 会被重建（compact / clear） | `Map<SessionId, dispose>`，先撤旧再设新；`agent/disposed` 清理 |
| C5 | 过期映射会让 restrict 抛 "unknown name"，整个会话初始化失败 | deny 先与 `ctx.tools.schemas(undefined)` 求交 |
| C6 | 按 cwd 路径反查工作区有歧义（两个工作区同路径） | 改按 `workspaceRegistry.list()` 的 `sessionIds.includes(agent.id)` 反查；cwd 只作兜底 |

### 14.3 优化项

| # | 优化 | 收益 |
|---|---|---|
| O1 | override 键从 entry id 改**包名** | 重装 / 升级不丢配置；符合"我在关一个插件"的心智 |
| O2 | 归属改**静态扫描 + 交叉验证** | 免维护内置表；随插件升级自动更新 |
| O3 | UI 列出**未归属工具** | 边界透明，不假装全覆盖 |
| O4 | 每插件 **~token 估算**（`JSON.stringify(schema).length / 4`） | 直接回答"到底省多少"，是产品说服力核心 |
| O5 | `applyLive(workspaceId)` | 改完能对活跃会话生效，不必重开 |
| O6 | 一个操作两个调用者（UI + `workspace_plugin` 工具） | 符合既有约定；Agent 也能被要求"给学生工作区关掉 shell" |

### 14.4 明确的能力边界（写下来，避免预期错位）

1. **只收窄不放宽**：全局已关的插件，工作区打不开。
2. **只作用于"继承面"，而 preset 恰好在继承面里**（v1.2 实测更正）：preset 注册的工具属于**祖先层**，`restrict` **可以**剥掉——实测隐藏 `read` 后新会话里 `read` 消失且 `skipped: []`。真正剥不掉的是**该 agent 自己层**在那之后注册的工具（`subagent`/`team`/`goal` 这类按 agent 现注册的），它们会落进 `skipped`。
3. **不卸载代码**：插件仍在内存，只是该会话的模型看不到它的工具。
4. **不省 system prompt 段**：本 MVP 只看工具 schema。插件若贡献 prompt section，这里不动它（长版才处理）。
5. **不对会话历史生效**：token 收益是"下一次请求"的；已发生的对话不回溯。

### 14.5 复核后的工时

| 阶段 | v1.0 | v1.1 | 变化原因 |
|---|---|---|---|
| M0 验证 | 0.5d | 0.25d | C1 已有明确结论，只需写断言 |
| M2 归属 | 1d | 0.5d | 静态扫描替代手写内置表 |
| M4 UI | 1d | 1.5d | 两个入口 + token 估算列 |
| 合计 | ≈3.5d | ≈3.5d | 总量不变，风险显著下降 |

---

## 15. 实现与验证记录（v1.2）

### 15.1 交付物

`D:\DSH Workspace\dsh-workspace-gate\`

| 文件 | 大小 | 作用 |
|---|---|---|
| `index.js` | 21 KB | Host：绑定 agent、`workspace_gate` 工具、HTTP 路由 |
| `client.js` | 18 KB | Client：插件页「按工作区」页签 |
| `lib/policy.mjs` | 8 KB | 纯逻辑：目录匹配 / 归属推断 / spec 展开 / 存储规整 |
| `tests/policy.test.mjs` | 6 KB | 15 条单测，`node --test` 全绿 |
| `cordis.patch.yml` · `locale/{zh,en}.json` · `icon.svg` · `package.json` · `README.md` | —— | 组合包与展示元数据 |

安装：`plugin_manager install_bundle target=D:\DSH Workspace\dsh-workspace-gate` → `application: applied`。
Client 侧确认：`plugins.tab` 占位者 = `[discover, workspace-gate(order 40, active)]`。

### 15.2 实测数据（本机 desktop profile）

| 项 | 数值 |
|---|---|
| 全局可见工具 `tools.schemas(undefined)` | **19** |
| 4 个 preset 作用域并集 | **53** |
| 某个具体会话可见工具 | **52–59** |
| 提示词段（按 preset 取并集） | **20** |
| 插件行总数 | **204** |
| preset | `standard` / `ptc` / `minimal` / `cordis` |

### 15.3 验证记录

把 `tool:read`（preset 作用域内的工具）与 `section:free-search:engines`（全局段）对 `D:\DSH Workspace` 隐藏，再开一条子会话：

```
bound = { cwd: "D:\\DSH Workspace", key: "d:/dsh workspace",
          deny: ["weather"], sections: ["free-search:engines"], skipped: [] }

weather            in agentTools : no
free-search:engines in agentSections : no
```

另一条实验单独隐藏 `read`：子会话工具表 52 项、`read` 缺失、`workspace_gate` 仍在（保留名单生效）。

### 15.4 实装中推翻/确认的四条判断

| # | 设计时的判断 | 实装结果 |
|---|---|---|
| 1 | 用全局工具视图算 deny 名单 | ❌ **错**。全局只有 19 个；标准工具由 preset 注册。改为按 preset `acquireScope` 取并集，再与该 agent 视图求交 |
| 2 | preset 的工具 `restrict` 剥不掉 | ❌ **错**。preset 在**祖先层**，属于继承面，可以剥（`skipped: []` 为证） |
| 3 | `systemPrompt.assemble()` 同步返回 | ❌ **错**。它是 `async`，不 await 只得到 `{}` |
| 4 | `deferLoading` 可省 schema token | ⚠️ **有代价**。开了之后子会话里这个工具**直接不可见**，模型调不到；已改为 `deferLoading: false`，用约 300 token 换可用性 |

### 15.5 其余实装细节

- **`restrict` 逐条调用**：一条不在全局面上的名字会让整批 `restrict` 抛错，所以按名字逐条施加，单条失败只进 `skipped`。
- **存储位置**：宿主进程里 `DSH_PROFILE_DIR` 未设置，故落到 `~/.dsh/data/workspace-gate.json`；`overrides` 以**归一化目录**为键（不是 workspaceId），子目录按最长祖先前缀继承。
- **HTTP 通道**：`webServer.register({ kind: 'prefix', path: '/workspace-gate', handler })`，同源 `GET /workspace-gate/state`、`POST /apply|/refresh`。实测 `http://127.0.0.1:<port>/workspace-gate/state` 返回 200 + JSON。
- **提示词段枚举**：`assemble({ scope })` 按 preset 作用域逐个取，得到 20 段（`harness:identity`、`deployment:persona-prefix`、`tool:*`、`free-search:engines` 等）。

### 15.6 未验证项

- **UI 的视觉渲染**：页签已注册为 active，HTTP 通道与数据形状都验证过，但本次没有浏览器控制权，**没有看到实际画面**；用户需在插件页点开「按工作区」确认。
- 归属推断对第三方插件的准确率：只在 `free-search` / `plugin-market` / `schedule` 等少数组上确认过，未覆盖面广。

