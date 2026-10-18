<p align="right">
  <b>简体中文</b> ｜ <a href="./README.en.md">English</a>
</p>

# dsh-workspace-gate · 工作区插件门控

> 插件照常加载，但**按工作区**把它不该占的提示词前缀摘掉——工具 schema 与提示词段都不再进模型上下文。

[![version](https://img.shields.io/github/v/tag/M1r0er/dsh-workspace-gate?label=version&color=blue)](https://github.com/M1r0er/dsh-workspace-gate/tags)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1)](https://github.com/topics/dsh-plugin)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件。

它让"要不要让模型看见某个插件"从**全局**下沉到**工作区**：插件依然全部加载、功能随时可用，
但在你指定的目录下，它的工具 JSON schema 和系统提示词段不再出现在每一次请求里。
省下的是每轮请求的输入 token，而不是插件的加载开销。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [它做什么 / 不做什么](#它做什么--不做什么)
- [主要特性](#主要特性)
- [界面](#界面)
- [安装](#安装)
- [使用](#使用)
- [归属是怎么判断的](#归属是怎么判断的)
- [数据存放](#数据存放)
- [为什么不是"真·停用插件"](#为什么不是真停用插件)
- [实测数据](#实测数据)
- [开发](#开发)
- [已知边界](#已知边界)
- [许可证](#许可证)

---

## 它解决什么问题

DSH 自带的插件管理只有 **全局** 开关：一个插件要么对所有工作区都开，要么都关。

但插件对 prompt 的成本是**每轮都付**的——只要它启用了，它的工具 JSON schema 和
系统提示词段就会出现在每一次请求里，哪怕这次对话完全用不到它。

典型场景：

- 装了「小说写作」插件，但你 90% 的时间在写代码；
- 装了「网页搜索」全家桶，但某个离线项目根本不该联网；
- 学生工作区只需要讲解/脑图，教师工作区只需要备课/教案。

**本插件把"要不要让模型看见"从全局下沉到工作区**，不动全局开关、不重启、不重载插件。

## 它做什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 按目录（含子目录继承）决定哪些工具/段不进 prompt | ❌ 不安装/卸载/升级插件 |
| 组级开关 + 展开到单个工具名/段名 | ❌ 不改变插件的全局启用状态 |
| 按来源分档：第三方 / 自定义 / 官方 / 官方可选包 | ❌ 不能把全局已停用的插件"变出来"（只减不加） |
| 自动归属推断 + 静态扫包 + 手工归属 | ❌ 不回溯已开会话（前缀已经发出去了） |
| fail-open：任何异常都当作"没配置" | ❌ 不碰 sandbox / approval 策略 |

## 主要特性

- **工作区级收窄**：配置单位是目录，子目录自动继承最近祖先（给 `D:\Projects` 配一次，
  `D:\Projects\api` 就继承）。
- **只减不加**：用的是 DSH 最弱的收窄原语 `ctx.tools.restrict()`，它只能移除，不会新增能力。
- **两类可见面都管**：工具 schema + 系统提示词段（后者用"同名空文本段遮蔽"实现）。
- **按来源分档**：靠 bundle 的 `availability` 判断"随 dsh 安装"还是"用户自装"，
  第三方档默认展开，官方档默认收起。
- **归属可手工矫正**：每个工具/段右侧有归属下拉，可以把未归属的项并入已有分组或新建分组。
- **模型可调**：`workspace_gate` 工具支持 `status` / `list` / `set`。
- **可控的噪声**：不写 DOM、不加载宿主客户端包、颜色只用 `--dsw-alias-*` 主题 token。
- **可测试**：核心逻辑抽在 `lib/policy.mjs`，24 条单测，不启动 DSH 也能跑。

## 界面

插件管理页会多出一个 **「按工作区」** 页签：

```
插件照常加载；勾掉的插件，它的工具与提示词段不再进入这个目录的请求。
存储: ~/.dsh/data/workspace-gate.json                        [重新扫描]
工作区  (default-workspace)  (my-project ●)  (+ 添加目录)
C:\work\my-project  · 跟随全局 · 已关 1 组 · 共 9 组
插件组                                                    [筛选…]
› 第三方  2                                    ≈ 2.7k
   [网] web-search-free   [9 工具][1 段]        ≈2.7k   ›  ●
› 自定义分组  1
› 官方  7                                      ≈ 17.8k
› 官方可选包  1
› 未归属  27
```

- 行尾开关 = 这一组在这个目录下是否可见；
- `›` 展开后可以只勾单个工具/段，右侧下拉可以改它的归属；
- 顶部显示当前目录、是否已单独配置、关了几组、大概省多少 token/轮。

## 安装

本插件是标准 DSH bundle（`package.json` 里声明 `dsh.bundle.patch`）。

**方式一：从本地目录安装（开发时）**

```bash
git clone https://github.com/M1r0er/dsh-workspace-gate.git
# 在 DSH 里：plugin_manager install_bundle  target=<克隆下来的绝对路径>
```

**方式二：装进 profile 的依赖**

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add github:M1r0er/dsh-workspace-gate
```

装好后插件管理页会出现「工作区插件门控」这一行；**关掉这一行 = 门控整体不生效**，
行为回到未安装状态（fail-open）。

## 使用

### 给人

插件管理 → 「按工作区」→ 选目录 → 关掉不需要的组 → 保存。对**新会话**生效。

### 给模型

```text
workspace_gate(action:"status")                          # 最近哪些会话命中了哪个目录、摘掉了什么
workspace_gate(action:"list")                            # 可门控的插件 → 工具名/段名
workspace_gate(action:"set", dir:"D:\\Projects\\api",
                hide:["plugin:r18-novel"])               # 需要显式给 dir
workspace_gate(action:"set", dir:"D:\\Projects",
                show:["tool:read"])                      # 从隐藏清单移除
```

> 这个工具没有用 `deferLoading`：实测打开后子会话里它**直接不可见**，模型想调也调不到。

两种写法等价（`dir` 必须是绝对路径，子目录会继承）：

- 隐藏整组：`plugin:<分组 id>`
- 隐藏单项：`tool:<工具名>` / `section:<段名>`

## 归属是怎么判断的

DSH 运行时**不记录**某个工具是哪个插件注册的（`tools.register()` 只按名字存），
所以"按插件勾选"只能推断。本插件按强度依次尝试：

| 顺序 | 手段 | 说明 | 可靠度 |
| --- | --- | --- | --- |
| 1 | 段名命名空间 | `r18-novel:protocol` → `r18-novel`，与插件 id/包名归一后比较 | 高（约定） |
| 2 | 工具名前缀 | 工具名 token 与插件 id **或包名** token 的**前导全等**匹配 | 中高 |
| 3 | 静态扫包 | 读包入口（第三方递归扫 `.js`）里的 `name: 'x'` 定义位，与未归属工具名求交，**只在唯一命中时采纳** | 较高 |
| 4 | 手工归属 | 界面里自己指定，赢过以上全部 | 最高 |

静态扫包解决的是这类情况：`dsh-free-search` 的 profile 行 id 是 `web-search-free`，
而它注册的 `platform_search` / `video_search` / `weather` 等名字里根本不含包名——
只靠前缀只能认出 1/9，扫包之后 9 个全部归位。

**硬边界**：官方内置包在 `app.asar` 里，磁盘上没有目录，扫不到；运行时动态注册的工具
（没有对应文件插件）也没有包可扫。这些会留在「未归属」，用手工归属分类即可。

## 数据存放

`<profile>/data/workspace-gate.json`（本机示例：`~/.dsh/data/workspace-gate.json`）

```json
{
  "version": 1,
  "overrides": {
    "d:/projects/api": ["plugin:r18-novel", "tool:free_search_news"]
  },
  "assignments": {
    "tool:read": "文件工具"
  }
}
```

- `overrides`：**按工作区**的隐藏清单，键是归一化目录（小写 + `/`），子目录继承最近祖先；
- `assignments`：**全局**的手工归属，赢过自动推断，只改分组、不影响"要不要隐藏"；
- 文件损坏 / 读不到 → 退化为空配置（全放行），不会让门控把会话搞挂。

## 为什么不是"真·停用插件"

三条硬理由：

1. **全局状态**。profile 的 `disabled` 是每个 profile 一份，不是每个工作区一份；
   两个工作区想一开一关只能来回改文件。
2. **来回改 = 反复重激活**。会触发 Loader 重载，而且同时开两个工作区会互相打架。
3. **那也不省 token**。真停用省的是内存与启动开销；而 token 取决于 prompt 里有什么。
   本插件摘的正是"模型侧的东西"，与工作区数量无关。

## 实测数据

本机 DSH 0.2.0-rc.2 / desktop profile：

| 事实 | 数值 |
| --- | --- |
| 全局可见工具（`tools.schemas(undefined)`） | 19 |
| 4 个 preset 作用域并集 | 53 |
| 某个具体会话可见工具 | 52–59 |
| 提示词段（按 preset 并集取） | 20 |
| 插件行总数 | 204 |

两个踩出来的坑：

1. **只查全局会漏掉 34+ 个工具**——多数标准工具由 agent preset 在自己的作用域注册，
   清单必须按 preset 逐个 `agentPresets.acquireScope(id)` 取并集。
2. `systemPrompt.assemble()` 是 **async**，不 `await` 只拿到一个空对象。

验证记录（对某个目录隐藏 `tool:read` 与 `section:free-search:engines` 后新开子会话）：

```text
bound = { cwd: "D:\\DSH Workspace", key: "d:/dsh workspace",
          deny: ["weather"], sections: ["free-search:engines"], skipped: [] }
weather             in agentTools    : no
free-search:engines in agentSections : no
```

`skipped: []` 说明两个名字都被接受——包括 preset 作用域里的工具，即 `restrict` 对
"继承面"（全局 + 祖先层）有效，不必是全局注册。

## 开发

```bash
npm run check   # node --check 三个入口
npm test        # 24 条单测（纯逻辑，不需要 DSH）
```

```
index.js              Host 半：绑定 agent、workspace_gate 工具、HTTP 路由
client.js             Client 半：插件页「按工作区」页签
lib/policy.mjs        纯逻辑：目录匹配、归属推断、spec 展开、存储规整
tests/policy.test.mjs 上面那层的单测
cordis.patch.yml      组合包的行声明
locale/{zh,en}.json   插件管理页标题与描述
icon.svg              图标
```

Host 与 Client 之间的通道是本插件**自注册的 HTTP 路由**
（`/workspace-gate/state|apply|assign|refresh`）：第三方插件的 Host 服务无法凭空长出
一个 remote namespace，而 `webServer.register()` 是宿主公开的接缝。

## 已知边界

1. **只对新会话生效**：已开会话的前缀已经发出去，不回溯。
2. **只减不加**：不会把全局已停用的插件变出来。
3. **归属靠推断**：`app.asar` 内与动态注册的工具无法自动归属，需手工分类。
4. **`restrict` 只作用于继承面**：极少见的、在该 agent 自己层注册的工具会落进 `skipped`。
5. **折叠状态不持久化**：刷新后回到默认展开策略。

## 许可证

[MIT](LICENSE) © 2026 M1r0er

---

<sub>本仓库打了 `dsh-plugin` topic，便于在 DSH 插件索引/市场里被检索到。</sub>
