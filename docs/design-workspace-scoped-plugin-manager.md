# DSH 按工作区插件管理（Workspace-Scoped Plugin Manager）

**软件设计与架构文档**

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0（设计基线） |
| 状态 | 设计完成，待评审 → 可进入实现 |
| 目标读者 | 本项目实现者、DSH 插件生态开发者 |
| 一句话定位 | 让"插件启用/停用"从**全局**下沉到**工作区**，在保持全局默认行为不变的前提下，按工作区裁剪模型可见面（工具、人设、技能目录），从而**降低 token 消耗**并**隔离场景/身份**。 |

---

## 1. 背景与问题定义

### 1.1 现状

DSH 的插件（Cordis 插件）是**代码模块**，由 Loader 装载进 Host/Client 运行时，注册 Service / Event / Tool / Slot。它们的启用与停用是 **profile 级（全局）** 的：

- 插件管理入口：`plugin-manager` + `configEditor.entries()/edit(entry, change)`，最终写回 Cordis patch，属于"整个 profile"生效。
- 官方文档明确：要"给某个 session 不同的能力集"，应当**组合一个 agent preset**；要把服务注册限定到单个 agent，使用该 agent 的 `agent.ctx`。

也就是说：**能力集的选择粒度是 session/preset，而不是 workspace**，并且没有面向用户的"工作区 → 插件集合"视图。

### 1.2 痛点

| # | 痛点 | 说明 |
|---|---|---|
| P1 | token 浪费 | 工具 schema 是**每次请求全量发送**的。会话用不到的插件只要处于启用态，其工具 schema 就持续占用上下文。 |
| P2 | 场景/身份串味 | 学生风格整合包（讲解、脑图）与教师风格整合包（备课、教案）同时启用时，两套人设段落常驻同一 prompt，输出风格含混。 |
| P3 | 切换成本高 | 换工作区要手动逐个开关插件，或维护多个 profile/preset 并重启会话。 |
| P4 | 无自动化 | 工作区 = 目录 + 会话列表，本身不携带任何插件配置，无法"进入某工作区即自动套用能力集"。 |

### 1.3 目标 / 非目标

**目标**

- G1：全局默认行为不变（未单独配置工作区时，等价于现状）。
- G2：可按工作区对插件做 `inherit / enabled / disabled` 三态覆盖。
- G3：覆盖在**新会话创建时自动生效**，无需用户手动操作。
- G4：核心收益可量化——被禁用的工具**不再进入**该工作区会话的请求（token 实际下降）。
- G5：可为工作区绑定"人设/整合包"，且不引发人设段落冲突。
- G6：不修改 DSH 核心包的数据结构（非侵入式，可随上游升级）。

**非目标**

- N1：不做"不同工作区加载不同 Python/系统级重依赖"。

> 说明：N1 在架构上**可行**（用 `isolate` realm 或 agent preset），但成本高、重启重，列为可选增强（见 §6.3）。

- N2：不替代官方 plugin-manager，只在其"全局"之上叠加"工作区"层。
- N3：不解决 skill 正文的常驻问题（skill 正文本就是懒加载），但可选提供技能目录的按工作区裁剪（见 §6.5）。

---

## 2. 核心概念模型

```
Plugin (Cordis 代码模块)
   │  启用后向运行时注册：Tool / PromptSection / Context / SkillProvider / Slot / Service
   ▼
Capability (能力)  = 该插件对模型可见的贡献 + 对运行时的贡献
   │
   ├── token 可见面：Tool schema、Prompt section、runtime context、skill 目录
   └── 无 token 面：Service、Slot、后台事件
   ▼
Capability Set (能力集) = 一组 plugin 的三态选择 {inherit | enabled | disabled}
   │
   ▼
Workspace (工作区) = 目录 + 有序会话；本设计为其挂载一个 Capability Override
   │
   ▼
Agent (会话) = 运行时实体；在 agent/created 时把"解析后的能力集"施加为 scoped 注册
```

**关键洞察（决定架构走向）**

1. **插件 ≠ 提示词**。插件是代码，插件"启用"只是让代码装载；**真正消耗 token 的是它注册的 Tool schema / prompt section / context**。因此，降低 token 不需要"卸载代码"，只需要**让它们在该会话的 scope 内不可见**。
2. 因此本设计的主战场是 **Scoped 可见性**，而不是 **进程级装载/卸载**。
3. DSH 的 `core/scope` + `SystemPrompt` 的 `ScopedLayers` 已经提供了"同名 section 最近 scope 胜出、tool provider 按 scope 合并、`tools.restrict()` 可按 scope 隐藏工具"的原语——**本设计是对既有原语的产品化封装**，而非新造机制。

---

## 3. 需求规格

### 3.1 功能需求

| ID | 需求 | 优先级 |
|---|---|---|
| F1 | 工作区能力覆盖：对任意已安装插件设置 `inherit/enabled/disabled` | P0 |
| F2 | 解析顺序：`effective = base(profile) + workspace override` | P0 |
| F3 | 新会话进入工作区时，自动把 effective 能力集施加到该 agent | P0 |
| F4 | 被 `disabled` 的工具不出现在该会话的 tool schema 中（token 实测下降） | P0 |
| F5 | 工作区可绑定"人设/整合包"，人设段落按工作区替换而非叠加 | P0 |
| F6 | 管理 UI：工作区详情内查看/编辑覆盖矩阵 | P1 |
| F7 | 全局设置页：默认策略（例如"新工作区继承全局"） | P1 |
| F8 | 会话运行中修改覆盖 → 明确语义（下轮生效 / 需重开会话提示） | P1 |
| F9 | 覆盖项的可视化 token 预估（"禁用此插件预计省 N tokens/请求"） | P2 |
| F10 | 技能目录按工作区裁剪（可选） | P2 |

### 3.2 非功能需求

| ID | 需求 |
|---|---|
| NF1 | 非侵入：不改 `dsh-workspace` 的 domain schema（避免 v2→v3 迁移） |
| NF2 | 幂等：重复施加/撤销不产生重复注册（依赖 scope 幂等） |
| NF3 | 可卸载：插件移除后，行为回落到全局默认，无残留 |
| NF4 | 可观测：`tokenMeter.measure()` 可对比施加前后请求体 |
| NF5 | 并发安全：覆盖写入走 domain 的串行 mutation |
| NF6 | 降级：解析失败/插件已卸载 → 该条覆盖视为 `inherit`，不阻断会话 |

---

## 4. 总体架构

### 4.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│  Client (Web UI)                                             │
│  ┌───────────────────────┐  ┌────────────────────────────┐  │
│  │ Workspace 能力面板      │  │ 全局设置页（默认策略）       │  │
│  │ (覆盖矩阵 + token 预估) │  │ (SettingsForm)              │  │
│  └──────────┬────────────┘  └─────────────┬──────────────┘  │
└─────────────┼──────────────────────────────┼────────────────┘
              │  ctx.remote / service 调用
┌─────────────▼──────────────────────────────▼────────────────┐
│  Host 扩展（本插件，Cordis 插件）                              │
│  ┌──────────────────────────┐   ┌─────────────────────────┐ │
│  │ workspaceCapabilities     │   │ capabilityResolver       │ │
│  │ (Service, CRUD + 事件)     │──▶│ (base ⊕ override 解析)    │ │
│  └──────────┬───────────────┘   └───────────┬─────────────┘ │
│             │                               │               │
│  ┌──────────▼───────────────┐   ┌───────────▼─────────────┐ │
│  │ capabilityStore           │   │ scopeBinder              │ │
│  │ (独立 storage domain,     │   │ (agent/created 时施加     │ │
│  │  键 = WorkspaceId)        │   │  restrict / section /    │ │
│  └──────────────────────────┘   │  context 到 agent.ctx)   │ │
│                                 └───────────┬─────────────┘ │
└─────────────────────────────────────────────┼───────────────┘
                                              │ 既有原语
        ┌─────────────────────────────────────▼────────────────┐
        │ DSH 内核（不改）                                        │
        │  workspaceRegistry · tools.restrict/schemas             │
        │  systemPrompt.section/context/tools · agentPresets       │
        │  storageDomain · workingDirectory · tokenMeter           │
        └────────────────────────────────────────────────────────┘
```

### 4.2 组件职责

| 组件 | 运行位置 | 职责 |
|---|---|---|
| `capabilityStore` | Host | 打开独立 storage domain（`defineDomain`），持久化每个工作区的覆盖记录；串行 mutation、崩溃恢复由 domain 机制保证 |
| `capabilityResolver` | Host | 纯函数：输入 `{baseProfileCapabilities, workspaceOverride}`，输出 `ResolvedCapabilitySet` |
| `scopeBinder` | Host | 监听 `agent/created`，把 `ResolvedCapabilitySet` 施加到 `agent.ctx`（scoped 注册） |
| `workspaceCapabilities` | Host | 对外 Service：`list/get/set/clear/preview/resolve`；发 `domain/changed` |
| `client panel` | Client | 工作区能力矩阵 UI，读写 Service |
| `settings form` | Client | 全局默认策略 |

### 4.3 与既有 Service 的对接关系

| 既有 Service | 用途 | 读/写 |
|---|---|---|
| `ctx.workspaceRegistry` | `list()/get(id)/resolveByPath(path)` 定位工作区 | 只读 |
| `ctx.workingDirectory.get(session)` | 会话 → 目录 → 工作区 | 只读 |
| `ctx.tools.restrict(filter)` | **关键**：按 scope 隐藏工具（不进 schema，保留 knownName） | 写（agent scope） |
| `ctx.tools.schemas(scope)` | 预估/校验工具可见集 | 只读 |
| `ctx.systemPrompt.section(...)` | 按工作区覆盖人设段落（同名覆盖） | 写（agent scope） |
| `ctx.systemPrompt.context(...)` / `suppressRuntimeContext()` | 可选的上下文裁剪 | 写（agent scope） |
| `ctx.systemPrompt.tools(provider)` | 需要"新增"能力时（如仅该工作区启用的工具） | 写（agent scope） |
| `ctx.agentPresets`（可选） | 重型隔离方案：整包插件集 | 读/写（按需） |
| `ctx.tokenMeter.measure()` | 覆盖前后 token 对比 | 只读 |
| `ctx.storageDomain` | 持久化 | 写（自有 domain） |
| `ctx.settings` | 全局默认策略表单 | 写（自有 namespace） |

---

## 5. 数据模型与持久化

### 5.1 为什么"自有 domain"而不是扩展 workspace 记录

`dsh-workspace` 的 domain 版本为 **2**，其 `workspaceRecord` 只有 `{path, title, sessionIds, createdAt, updatedAt}`，**没有插件配置字段**。若直接在核心包里加字段：

- 需要 domain schema **v2 → v3** 迁移；
- 需要 fork/侵入核心包，与上游升级冲突。

因此选择**非侵入式**：本插件用 `defineDomain` 打开自己的域，表以 `WorkspaceId` 为键。核心包零改动。

### 5.2 领域定义

```ts
// 概念定义（实现时用 zod 表达）
interface WorkspaceCapabilityOverride {
  workspaceId: string;            // 对应 dsh-workspace 的 WorkspaceId
  revision: number;               // 单调递增，用于并发与缓存失效
  entries: Record<string, 'inherit' | 'enabled' | 'disabled'>; // key = plugin/entry id
  persona?: {
    bundleId?: string;            // 人设整合包 id（可选）
    sectionName?: string;         // 默认 deployment:persona-prefix
    content?: string;             // 直接内联人设文本（可选）
  };
  skillFilter?: {                 // 可选：技能目录裁剪
    allow?: string[];
    deny?: string[];
  };
  updatedAt: string;
}

interface WorkspaceCapabilityDomainState {
  initialized: boolean;
  version: number;                // 本域自身版本
  overrides: Record<string, WorkspaceCapabilityOverride>;
}
```

```ts
// 域规格（与 dsh-workspace 同构的写法）
const capabilityDomainSpec = defineDomain({
  name: 'workspace-capabilities',
  version: 1,
  global: { schema: capabilityDomainStateSchema, initial: { initialized: true, version: 1, overrides: {} } },
  tables: {
    overrides: domainTable(workspaceCapabilityOverrideSchema),
  },
});
```

### 5.3 一致性

- 所有写操作经 `mutate()`/串行队列，使用"两写恢复"的 pending 标记，语义与 `dsh-workspace` 一致。
- 写成功后发 `domain/changed`（`DomainChanged`），UI 与 resolver 缓存订阅该事件失效。

---

## 6. 关键机制设计（核心章节）

### 6.1 生效集合解析

```ts
// 纯函数，无副作用
function resolve(
  base: Map<string, PluginState>,       // profile 里各 entry 的启用态
  override?: WorkspaceCapabilityOverride,
): ResolvedCapabilitySet {
  const result = new Map(base);
  if (!override) return { entries: result, source: 'global' };

  for (const [id, state] of Object.entries(override.entries)) {
    if (state === 'inherit') continue;           // 显式继承
    if (state === 'enabled') result.set(id, 'enabled');
    else result.set(id, 'disabled');             // 只允许"关闭全局已开启项"或"开启已安装项"
  }
  // 约束：不能启用 profile 中未安装的插件（UI 层置灰）
  return { entries: result, source: 'workspace' };
}
```

**三态语义**

| 值 | 含义 | UI |
|---|---|---|
| `inherit` | 跟随全局（默认） | 灰色「继承」 |
| `enabled` | 即使全局关闭也启用（限已安装） | 绿色开关 |
| `disabled` | 即使全局开启也禁用 | 红色开关 |

### 6.2 施加机制（Token 层，主方案）

**时机**：监听 `agent/created`（serial，payload `{agent, source, signal}`），此时 agent 已就绪、尚未开始首个 turn。

**做法**：在该监听器（其 `this` 已是 scoped 到该 agent 的 ctx）内执行：

```ts
on('agent/created', async ({ agent }) => {
  const ws = await resolveWorkspaceFor(agent);          // workingDirectory.get(session) → workspaceRegistry
  if (!ws) return;                                       // 无工作区 → 全局行为
  const resolved = resolve(baseCapabilities(), override(ws.id));

  // 1) 隐藏被禁用的工具  ← token 的真正来源
  const hidden = [...allToolNames()].filter(n => resolved.isDisabled(n));
  if (hidden.length) ctx.tools.restrict(namesFilter(hidden));

  // 2) 人设段落覆盖（同名声明的"最近 scope 胜出"）
  if (resolved.persona) {
    ctx.systemPrompt.section({
      name: PERSONA_PREFIX_SECTION,                       // "deployment:persona-prefix"
      order: 0,
      content: resolved.persona.content,
    });
  }

  // 3) 可选：该工作区专属新增工具（例如仅学生工作区需要"出题"）
  for (const def of resolved.exclusiveTools) ctx.tools.register(def);

  // 4) 可选：上下文裁剪
  if (resolved.suppressRuntimeContext) ctx.systemPrompt.suppressRuntimeContext();
});
```

**为什么 `restrict` 是正确杠杆**

`SystemPrompt.assemble()` 的流程是：收集所有 tool provider 的 `schemas` → 映射为请求体 → `orderTools(collected, toolOrder, knownNames)`。`orderTools` 的注释明确：

> *Unknown configured names fail; **known but restricted names may be absent**.*

即：`restrict` 能让工具**从 schemas 中消失**（省 token），同时**保留在 `knownNames`**（不会让 `toolOrder` 里配置了该工具名的 profile 报错）。这正好是本需求的语义。

**为什么不用"卸载/重装插件"**

- 插件是代码，卸载重装需要 Loader 重排，代价高且会中断会话；
- token 只取决于 prompt/tools，与代码是否在内存无关；
- 因此 **scoped 可见性 = 用最小代价拿到全部 token 收益**。

### 6.3 施加机制（隔离层，可选增强）

对**重型**插件（自带本地进程、模型、大 UI bundle），"隐藏 schema"省不了内存/启动成本。此时用官方已提供的两种原语：

| 方案 | 原语 | 适用 | 代价 |
|---|---|---|---|
| **agent preset** | `agentPresets.select(agent, preset)`，preset 由 `AgentPreset` 插件行声明，含 `plugins: []`；选择会**写入 session 持久日志**并发 `agent-preset/selected` | 整包能力切换（"学生包"/"教师包"） | 需为每个组合维护 preset |
| **isolate realm** | Cordis composition 中给 service row 加 `isolate` | 需要独立服务实例（如独立 sandbox/存储） | 配置复杂度高 |

本设计默认只做 Token 层；隔离层作为**可插拔策略**：`scopeBinder` 内按 `plugin.capability.isolation === 'realm'` 分流。

### 6.4 人设整合包（Persona Bundle）如何不与全局冲突

问题（来自上一轮讨论）：学生整合包与教师整合包同时启用 → 两段 persona 常驻 → 风格含混。

本设计的解法：**人设是内容，不是代码。**

- 整合包中"人设"部分不通过"加载插件"表达，而是声明为一段 **persona section**；
- 工作区绑定时，用 `ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, content })` 在 agent scope 注册**同名** section；
- `ScopedLayers.merge()` 的规则是"最近 scope 胜出" → 该工作区拿到的是**替换**后的人设，而不是叠加；
- 全局整合包可保持"启用"（提供技能/工具），仅人设被按工作区替换。

这样既保留了整合包的能力，又消除了人设冲突，且**不增加** token（同名替换，非新增）。

### 6.5 技能目录裁剪（可选，P2）

`dsh-tool-skill` 在 `agent/pre-step` 中把 `<available_skills>` 目录作为一条消息注入，目录条目来自 `SkillRegistry.list()`（仅摘要），正文仍懒加载。

若要让"教师工作区不出现『讲解/脑图』技能"，需要在该注入点按 scope 过滤。**实现时需验证**：`dsh-tool-skill` 的 catalog 监听器是否在 agent scope 下查询 registry——若是，可注册一个 scoped skill provider/或对 catalog 做 scope 级过滤；若否，需上游提供 filtered catalog 入口。此项标记为**待验证**，不阻塞 P0。

### 6.6 运行中变更的语义

| 场景 | 处理 |
|---|---|
| 会话未运行，改工作区覆盖 | 下次 `agent/created` 自动生效（自然） |
| 会话运行中，改工作区覆盖 | 标记 `dirty`；在下一 `agent/pre-step` 前重新施加（`refreshContext` + 重新 restrict）。若 provider 缓存不可热更新，则提示"本会话需重开才能完全生效" |
| 会话运行中，切换工作区（`workingDirectory.set`） | 同上，**显式提示**语义（不静默换能力集） |
| 插件被卸载 | `domain/changed` → resolver 对 unknown id 视作 `inherit`（NF6） |

---

## 7. Token 成本模型

### 7.1 成本构成（什么会随插件进入请求）

| 贡献面 | 是否每次请求 | 是否被本设计裁剪 |
|---|---|---|
| Tool schema（name + description + parameters JSON） | ✅ 全量 | ✅ `restrict` 后不再出现 |
| Prompt section（`systemPrompt.section`） | ✅ | ✅ 同名替换 / 可空 |
| Runtime context（`systemPrompt.context`） | ✅ | ✅ `suppressRuntimeContext` / 按 scope |
| Skill 目录摘要（`<available_skills>`） | ✅（每 pre-step 一条消息） | ⚠️ 可选（§6.5） |
| Skill 正文 | 懒加载（调用 `skill` 工具/`/name`） | 不需要 |
| Service / Slot / 后台代码 | ❌ | 不涉及 token |

### 7.2 量化估算

单个工具 schema 的经验体积：**约 150–900 tokens**（取决于 `parameters` 复杂度）。

> 例：某工作区启用 40 个工具，其中 22 个与该场景无关，平均每个 400 tokens →
> **每请求浪费 ≈ 22 × 400 = 8,800 tokens**。
> 在 128K 上下文里接近 7%；在 agent 多轮循环中，每轮都重复承担。

本设计对 `disabled` 工具的效果是**线性、精确**的：少一个 schema 就少一份体积，且可被 `tokenMeter.measure()` 直接测量。

### 7.3 可观测性设计

- `preview(workspaceId)` 返回：`{ visibleTools, hiddenTools, estimatedPromptDeltaTokens }`。
- UI 在覆盖矩阵旁展示"预计节省 ≈ N tokens / 请求"（基于 schema 序列化长度 / 4 的粗估，或实测）。
- 提供一键 A/B：施加前/后调用 `tokenMeter.measure(session)` 对比。

---

## 8. 接口设计

### 8.1 Host Service：`workspaceCapabilities`

```ts
interface WorkspaceCapabilitiesService {
  // 查询
  getOverride(workspaceId: string): Promise<WorkspaceCapabilityOverride | undefined>;
  listOverrides(): Promise<WorkspaceCapabilityOverride[]>;
  resolve(workspaceId: string): Promise<ResolvedCapabilitySet>;
  preview(workspaceId: string): Promise<CapabilityPreview>;

  // 变更（串行 mutation）
  setEntry(workspaceId: string, entryId: string, state: 'inherit' | 'enabled' | 'disabled'): Promise<void>;
  setPersona(workspaceId: string, persona: WorkspaceCapabilityOverride['persona']): Promise<void>;
  clear(workspaceId: string): Promise<void>;

  // 施加
  bindAgent(agent: Agent): Promise<void>;   // 幂等；供 agent/created 与手动触发
}
```

### 8.2 插件 Config

```yaml
# 本插件自身的 Config（全局默认策略）
workspaceCapabilities:
  enabled: true
  defaultPolicy: inherit          # 新工作区默认 follow global
  personaSectionName: deployment:persona-prefix
  exposeTokenEstimate: true
  skillFiltering: false           # P2
```

### 8.3 事件

| 方向 | 事件 | 用途 |
|---|---|---|
| 监听 | `agent/created` | 施加能力集 |
| 监听 | `workingDirectory` 变更 | 会话跟随目录切换时重新解析 |
| 监听 | `domain/changed` | 覆盖变更 → UI / 缓存失效 |
| 监听 | `tools/change` | 工具集变化时重算可隐藏集合 |
| 发出 | `workspace-capabilities/changed` | 自定义事件，驱动 UI 刷新 |

### 8.4 Client 契约

- 一个 Remote Service（`ctx.remote`）包装 `workspaceCapabilities`。
- 一个工作区面板组件：矩阵（行 = 插件，列 = [继承/开/关]）+ 顶部 token 预估。
- 一个全局 SettingsForm（`ctx.settings.configure(...)`），承载 §8.2 的默认策略。

---

## 9. UI 设计

```
┌─ 工作区：学生-高一 ────────────────────────────── [能力集] ─┐
│ 基础行为：跟随全局 ◉    自定义 ○                          │
│                                                          │
│ 搜索插件…                                 预计节省 ≈ 8.8k  │
│ ┌────────────────────────────┬──────┬──────┬──────┐       │
│ │ 插件 / 工具                  │ 继承 │ 启用 │ 禁用 │       │
│ ├────────────────────────────┼──────┼──────┼──────┤       │
│ │ 备课助手 (lesson-plan)       │  ●   │  ○   │  ○   │       │
│ │ 脑图生成 (mindmap)           │  ●   │  ○   │  ○   │       │
│ │ 教案模板 (plan-template)     │  ●   │  ○   │  ○   │       │
│ │ 网页抓取 (web-fetch)         │  ○   │  ○   │  ●   │       │
│ │ 代码执行 (shell)             │  ○   │  ○   │  ●   │       │
│ └────────────────────────────┴──────┴──────┴──────┘       │
│                                                          │
│ 人设：[学生风格 ▾]  （来自整合包，按工作区替换全局人设）     │
│ 技能：[仅学生技能 ▾]（可选）                              │
└──────────────────────────────────────────────────────────┘
```

- **状态可视化**：已被全局禁用但本工作区强制启用的项 → 黄色提示"全局关闭，此工作区例外"。
- **变更即时**：写入成功 → `domain/changed` → 面板刷新；提示"新会话生效 / 当前会话需重开"。

---

## 10. 关键流程

### 10.1 新会话进入工作区

```
User 开新会话（cwd = D:\课程\高一数学）
  │
  ├─▶ agent-loop 创建 Agent
  │
  ├─▶ emit "agent/created" (serial, Scoped<Agent>)
  │        │
  │        ├─▶ scopeBinder: workingDirectory.get(session) → path
  │        ├─▶ workspaceRegistry.resolveByPath(path) → ws
  │        ├─▶ capabilityResolver.resolve(base, override(ws.id))
  │        ├─▶ ctx.tools.restrict(hiddenNames)
  │        ├─▶ ctx.systemPrompt.section(personaOverride)
  │        └─▶ 记录"已施加"标记（幂等）
  │
  └─▶ 首个 turn：assemble() 只含可见工具 → 请求体更小
```

### 10.2 运行中修改覆盖

```
User 在面板关掉某个插件
  │
  ├─▶ setEntry() → domain mutate → emit domain/changed
  │
  ├─▶ 若目标会话正在运行：
  │      ├─▶ 标记 dirty
  │      ├─▶ 下一 pre-step 前重新 bindAgent（refreshContext + 重 restrict）
  │      └─▶ 若 provider 不可热更 → UI 提示"重开会话后完全生效"
  │
  └─▶ 否则：下次 agent/created 自然生效
```

---

## 11. 兼容性、迁移与降级

| 项 | 策略 |
|---|---|
| 核心 schema | **零改动**；本插件自有 domain |
| 未安装本插件 | 行为 = 全局默认（无覆盖） |
| 插件被卸载/改名 | unknown id → 视为 `inherit`，并记录 warn |
| 与 agent preset 共存 | 优先级：**agent preset 显式选择 > 工作区覆盖 > 全局**；选择 preset 时以 preset 为准（避免两套机制打架） |
| 上游升级 | 只依赖公开 Service 签名（`tools.restrict/schemas`、`systemPrompt.section/context/tools`、`workspaceRegistry`、`storageDomain`、`workingDirectory`），不依赖内部字段 |
| 多实例 | 若用户同时装了旧版全局 manager，两者独立；本插件只叠加，不修改其状态 |

---

## 12. 安全与隔离边界

- **权限**：本插件不改变 sandbox / approval 策略；只影响"工具是否对模型可见"。被 `disabled` 的工具若被显式调用，因 `scoped(scope)` 不可见 → 模型根本不会调用，无需额外 guard；若仍需兜底，在 `tools/pre-execute` 加"本工作区禁用则不派发"。
- **数据**：覆盖记录仅含"插件 id + 状态 + 人设文本"，不含会话内容；存于 profile 的 storage。
- **风险**：人设内容来自用户自选整合包，属用户可控数据，不跨用户传播。

---

## 13. 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
|---|---|---|---|
| R1 | `ToolRestriction` 精确形态未在源码窗口确认（`restrict(filter)` 参数结构） | 实现细节 | 实现首日核对 `dsh-tools` 中 `ToolRestriction` 定义；语义已由 system-prompt 注释确认 |
| R2 | `dsh-tool-skill` 的 catalog 注入是否在 agent scope 下 | 技能裁剪可行性 | §6.5 标记待验证，不阻塞 P0 |
| R3 | 运行中热更新 provider 是否可行 | 体验（需重开会话） | 先实现"下次生效 + 提示"，后续优化 |
| R4 | 与 `agentPresets` 的优先级语义 | 两套机制冲突 | 明确"preset 显式选择优先"（§11） |
| R5 | 上游可能内建"按工作区预设" UI | 长期竞争 | 本插件以"轻量 + 非侵入 + 可量化 token"为差异点；若上游内建则平滑迁移 |
| R6 | 工具 schema 体积估算误差 | token 预估不准 | 用 `tokenMeter` 实测校准，标注"≈" |

---

## 14. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0（0.5d） | 核对 `ToolRestriction`、skill catalog scope、`agent/created` 时序 | 技术验证记录 |
| M1（1.5d） | domain + resolver + Service（无 UI） | 可用 API + 单测 |
| M2（1.5d） | `scopeBinder`：`restrict` + persona 覆盖 | 新会话自动生效 |
| M3（1.5d） | Client 面板 + token 预估 | 可操作 UI |
| M4（0.5d） | 运行中变更语义 + 事件刷新 | 完整体验 |
| M5（0.5d） | 文档、A/B 验证、回归 | 发布候选 |

---

## 15. 附录

### 15.1 现有能力对照表（本设计 vs 现状 vs 官方原语）

| 能力 | 现状 | 官方原语 | 本设计 |
|---|---|---|---|
| 全局启停插件 | ✅ plugin-manager | `configEditor.edit` + Cordis patch | 复用 |
| 按 session 换能力集 | ⚠️ 需手写 preset | `agentPresets.select` / `agent.ctx` | 复用（可选） |
| 按 workspace 换能力集 | ❌ | 无直接原语；`ScopedLayers` + `restrict` 可组合 | ✅ 产品化封装 |
| 人设按工作区替换 | ❌ | 同名 section 最近 scope 胜出 | ✅ |
| token 前后对比 | ⚠️ 手动 | `tokenMeter.measure` | ✅ 集成 |

### 15.2 关键源码/文档依据（实现时对照）

- `node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js`：`ScopedLayers` 合并、`PERSONA_PREFIX_SECTION`、`orderTools` 的 known/restricted 语义。
- `node_modules/@deepseek-ai/dsh-scope/lib/index.js`：`ScopedLayers.merge`、`createScope`、`scopeTarget`。
- `node_modules/@deepseek-ai/dsh-tools/lib/index.js`：`restrict`、`schemas(scope)`、dispatch 管线。
- `node_modules/@deepseek-ai/dsh-workspace/lib/index.js`：domain v2、`WorkspaceRegistry`。
- `node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js`：`<available_skills>` 注入。
- 事件目录：`agent/created`、`agent-preset/selected`、`system-prompt/assemble`、`tools/change`、`domain/changed`、`workingDirectory` 变更。

### 15.3 术语

| 术语 | 定义 |
|---|---|
| Scope | `ScopeKey` 标识的作用域层；agent 是其一个 scope |
| ScopedLayers | "全局层 + 精确 scope 层"的层叠容器，最近 scope 覆盖同名项 |
| Capability Override | 一个工作区对若干插件的三态设置 |
| Effective Set | base(profile) ⊕ override 的解析结果 |
| Token 层 / 隔离层 | 仅隐藏模型可见面 / 真正隔离进程或服务实例 |

---

*文档结束。*
