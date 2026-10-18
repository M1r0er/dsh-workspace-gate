<p align="right">
  <a href="./README.md">简体中文</a> ｜ <b>English</b>
</p>

# dsh-workspace-gate

> Plugins keep loading — but the prompt prefix they don't need is dropped **per workspace**. Tool schemas and prompt sections stop reaching the model.

[![version](https://img.shields.io/github/v/tag/M1r0er/dsh-workspace-gate?label=version&color=blue)](https://github.com/M1r0er/dsh-workspace-gate/tags)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-6f42c1)](https://github.com/topics/dsh-plugin)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It moves "should the model see this plugin" from a **global** switch down to the **workspace**.
Every plugin still loads and stays usable, but under the directories you choose, its tool JSON
schemas and system-prompt sections no longer appear in each request. What you save is prompt
input tokens every turn — not plugin load time.

---

## Contents

- [The problem](#the-problem)
- [What it does / does not do](#what-it-does--does-not-do)
- [Features](#features)
- [Interface](#interface)
- [Install](#install)
- [Usage](#usage)
- [How ownership is inferred](#how-ownership-is-inferred)
- [Where data lives](#where-data-lives)
- [Why not really disable plugins](#why-not-really-disable-plugins)
- [Measured numbers](#measured-numbers)
- [Development](#development)
- [Known limits](#known-limits)
- [License](#license)

---

## The problem

DSH's built-in plugin manager offers only a **global** switch: a plugin is either on for every
workspace or off for all of them.

But a plugin's prompt cost is paid **every turn**. As long as it is enabled, its tool JSON
schemas and its system-prompt sections are sent with every request — even in a conversation
that never touches it.

Typical cases:

- you installed a novel-writing plugin but spend 90% of your time writing code;
- you installed a web-search suite but one project must stay completely offline;
- a "student" workspace only needs explanations and mind maps, while a "teacher" workspace only
  needs lesson plans.

**This plugin scopes "visible to the model" to the workspace** — without touching global
switches, restarting, or reloading plugins.

## What it does / does not do

| Does | Does not |
| --- | --- |
| Decide per directory (with subdirectory inheritance) which tools/sections stay out of the prompt | ❌ Install / uninstall / upgrade plugins |
| Group-level switches, expandable down to a single tool or section name | ❌ Change a plugin's global enabled state |
| Group by origin: third-party / custom / official / official optional | ❌ Conjure up a globally disabled plugin (subtract only) |
| Automatic ownership inference + static package scan + manual assignment | ❌ Retro-fit already-open sessions (their prefix is already sent) |
| fail-open: any error behaves as "not configured" | ❌ Touch sandbox / approval policy |

## Features

- **Workspace-level narrowing**: the unit of configuration is a directory; subdirectories inherit
  their nearest configured ancestor (configure `D:\Projects` once and `D:\Projects\api` follows).
- **Subtract only**: it uses DSH's weakest narrowing primitive, `ctx.tools.restrict()`, which can
  only remove — never add capabilities.
- **Both visible surfaces**: tool schemas *and* system-prompt sections (the latter via
  same-name empty-section shadowing in agent scope).
- **Grouped by origin**: bundle `availability` tells "shipped with dsh" from "installed by the
  user"; the third-party group is expanded by default, official groups collapsed.
- **Correctable ownership**: every tool/section has an ownership dropdown, so unassigned items can
  be merged into an existing group or a brand-new one.
- **Model-callable**: the `workspace_gate` tool supports `status` / `list` / `set`.
- **Low noise**: no DOM writes, no host client packages imported, colors only via
  `--dsw-alias-*` theme tokens.
- **Testable**: the core logic lives in `lib/policy.mjs` with 24 unit tests that run without DSH.

## Interface

The plugin manager page gains a **“By workspace”** tab:

```
Plugins still load; whatever you switch off keeps its tools and prompt sections out of this directory's requests.
Store: ~/.dsh/data/workspace-gate.json                       [Rescan]
Workspaces  (default-workspace)  (my-project ●)  (+ Add directory)
C:\work\my-project  · follows global · 1 group off · 9 groups
Plugin groups                                             [Filter…]
› third-party  2                                    ≈ 2.7k
   [w] web-search-free   [9 tools][1 section]        ≈2.7k   ›  ●
› custom groups  1
› official  7                                       ≈ 17.8k
› official optional  1
› unassigned  27
```

- the trailing switch = whether that group is visible in this directory;
- `›` expands to individual tools/sections, and the dropdown on the right changes ownership;
- the header shows the current directory, whether it has its own override, how many groups are
  off, and roughly how many tokens per turn that saves.

## Install

This is a standard DSH bundle (`package.json` declares `dsh.bundle.patch`).

**Option 1 — install from a local checkout (development)**

```bash
git clone https://github.com/M1r0er/dsh-workspace-gate.git
# inside DSH: plugin_manager install_bundle  target=<absolute path of the clone>
```

**Option 2 — add it to your profile dependencies**

```bash
cd ~/.dsh/profiles/<your profile>
pnpm add github:M1r0er/dsh-workspace-gate
```

After installation the plugin manager shows a **Workspace Plugin Gate** row. **Turning that row
off disables the whole gate** and behaviour returns to stock (fail-open).

## Usage

### For humans

Plugin manager → “By workspace” → pick a directory → switch off the groups you don't need →
Save. Applies to **new sessions**.

### For the model

```text
workspace_gate(action:"status")                          # which sessions hit which directory, what was hidden
workspace_gate(action:"list")                            # gateable plugins → tool/section names
workspace_gate(action:"set", dir:"D:\\Projects\\api",
                hide:["plugin:r18-novel"])               # dir is required here
workspace_gate(action:"set", dir:"D:\\Projects",
                show:["tool:read"])                      # remove from the hidden list
```

> The tool does not use `deferLoading`: measured, that made it **invisible to sub-sessions**, so
> the model could never call it. Paying ~300 tokens of schema is the cheaper mistake.

Two equivalent forms (`dir` must be absolute; subdirectories inherit):

- hide a whole group: `plugin:<group id>`
- hide a single item: `tool:<name>` / `section:<name>`

## How ownership is inferred

DSH's runtime **does not record** which plugin registered a tool (`tools.register()` keys by name
only), so "tick a plugin" has to be inferred. This plugin tries, strongest first:

| # | Method | How | Confidence |
| --- | --- | --- | --- |
| 1 | Section namespace | `r18-novel:protocol` → `r18-novel`, compared after normalizing ids/package names | High (convention) |
| 2 | Tool name prefix | tool-name tokens must be a **leading match** with the plugin id **or package name** tokens | Medium-high |
| 3 | Static package scan | read `name: 'x'` definition sites in the package entry (recursively for third-party), intersect with unassigned tool names, **adopt only unambiguous hits** | High enough |
| 4 | Manual assignment | set in the UI, overrides everything above | Highest |

The scan exists for cases like `dsh-free-search`: its profile row id is `web-search-free`, while
the tools it registers (`platform_search`, `video_search`, `weather`, …) contain no package name
at all — prefix matching recovered 1 of 9, the scan recovers all 9.

**Hard boundary**: official built-in packages live inside `app.asar`, so there is no directory to
scan; tools registered dynamically at runtime have no package either. They stay in “unassigned”
until you classify them by hand.

## Where data lives

`<profile>/data/workspace-gate.json` (on this machine: `~/.dsh/data/workspace-gate.json`)

```json
{
  "version": 1,
  "overrides": {
    "d:/projects/api": ["plugin:r18-novel", "tool:free_search_news"]
  },
  "assignments": {
    "tool:read": "file tools"
  }
}
```

- `overrides` — the **per-workspace** hidden list; keys are normalized directories (lowercase,
  `/`-separated) and subdirectories inherit the nearest ancestor;
- `assignments` — **global** manual ownership; it beats inference and only changes grouping, not
  visibility;
- a corrupt or unreadable file degrades to an empty configuration (everything visible) — the gate
  never breaks a session.

## Why not really disable plugins

Three hard reasons:

1. **It is global state.** A profile's `disabled` is per profile, not per workspace; two
   workspaces wanting different states means rewriting the file back and forth.
2. **Rewriting means reactivating.** That triggers Loader reloads, and two open workspaces fight
   each other.
3. **It doesn't save tokens anyway.** Real disabling saves memory and startup time; tokens depend
   on what is in the prompt. The gate removes exactly the model-side payload, independent of how
   many workspaces exist.

## Measured numbers

DSH 0.2.0-rc.2, desktop profile:

| Fact | Value |
| --- | --- |
| Globally visible tools (`tools.schemas(undefined)`) | 19 |
| Union across 4 preset scopes | 53 |
| Tools visible to one concrete session | 52–59 |
| Prompt sections (same union approach) | 20 |
| Plugin rows | 204 |

Two things learned the hard way:

1. **The global view is missing 34+ tools** — most standard tools are registered by the agent
   preset in its own scope; the inventory must union
   `agentPresets.acquireScope(id)` across presets.
2. `systemPrompt.assemble()` is **async**; without `await` you get an empty object.

Verification record (hiding `tool:read` and `section:free-search:engines` for one directory, then
opening a new sub-session):

```text
bound = { cwd: "D:\\DSH Workspace", key: "d:/dsh workspace",
          deny: ["weather"], sections: ["free-search:engines"], skipped: [] }
weather             in agentTools    : no
free-search:engines in agentSections : no
```

`skipped: []` means both names were accepted — including the preset-scoped tool, i.e.
`restrict` works on the *inherited* surface (global + ancestor layers), not only on global
registrations.

## Development

```bash
npm run check   # node --check on the three entry points
npm test        # 24 unit tests (pure logic, no DSH needed)
```

```
index.js              Host half: per-agent binding, workspace_gate tool, HTTP routes
client.js             Client half: the "By workspace" tab
lib/policy.mjs        Pure logic: directory matching, ownership, spec expansion, store shaping
tests/policy.test.mjs Unit tests for the layer above
cordis.patch.yml      Bundle row declaration
locale/{zh,en}.json   Plugin manager title and description
icon.svg              Icon
```

The Host↔Client channel is an **HTTP route this plugin registers itself**
(`/workspace-gate/state|apply|assign|refresh`): a third-party Host service cannot grow its own
remote namespace out of thin air, and `webServer.register()` is the public seam the host offers.

## Known limits

1. **New sessions only** — an open session's prefix is already sent; no retro-fitting.
2. **Subtract only** — a globally disabled plugin cannot be conjured back.
3. **Ownership is inferred** — tools inside `app.asar` and dynamically registered tools need
   manual classification.
4. **`restrict` only covers the inherited surface** — the rare tools registered in an agent's own
   layer end up in `skipped`.
5. **Collapse state is not persisted** — a refresh returns to the default expansion policy.

## License

[MIT](LICENSE) © 2026 M1r0er

---

<sub>This repository carries the `dsh-plugin` topic so it can be discovered by the DSH plugin index/marketplace.</sub>
