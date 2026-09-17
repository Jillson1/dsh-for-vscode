# DSH for VS Code 🐳

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/Jillson1/dsh-for-vscode?style=social)](https://github.com/Jillson1/dsh-for-vscode)
[![DSH Plugin](https://img.shields.io/badge/DSH%20Plugin-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.91-blue)](https://code.visualstudio.com/)

**English** | [中文](README.zh.md)

Use [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) as a **real IDE-grade AI coding setup** inside VS Code. It is not just an embedded web page: it brings "which files the AI touched, where, and can I undo it" plus "the moment DSH needs your decision" right into the editor. Your code and the AI stay on one screen — no window switching, no browser tab juggling.

> In one line: **DSH does the editing; VS Code makes it reviewable, actionable and undoable.**

## 📸 Screenshot

![DSH for VS Code screenshot](docs/screenshots/overview.png)

![DSH for VS Code demo](docs/screenshots/overview.gif)

## 🎬 Demo video

[![How to use DeepSeek Harness in VS Code? Use DSH!! (Bilibili)](docs/screenshots/video-cover.jpg)](https://www.bilibili.com/video/BV1p8bD6dE18)

*59-second demo (Chinese): [BV1p8bD6dE18](https://www.bilibili.com/video/BV1p8bD6dE18)*

---

## ✨ Feature overview

| Group | Capability | One-liner |
|---|---|---|
| 🧭 Basics | Panel + file linking | Embedded DSH panel; click a file path to jump, `edit` lands on the changed line |
| 📝 Change visualization | Three-color highlights + hover actions | See what changed, where, and how to undo it — in the editor |
| 🗂️ Reviewable change set | Change ledger / navigation / tree / batch actions / inline buttons | Changes become persistent: survive a Reload, review one by one |
| 🎛️ Editor as the frontend | Approval gate / status bar state machine / questions & plan review | Answer DSH where you are, without leaving VS Code |
| ⏪ Cross-turn rollback | Checkpoints + native diff + one-click restore | Go back to "before turn N" (code only) |
| ⚡ Edit in place | Selection toolbar + Quick Edit | Select lines, type an instruction, hit send |
| ⚙️ Controllable | Every feature can be turned off | All on by default; silence anything instantly, no reload needed |

## ✨ Feature details

### 🧭 Panel and file linking

- 🖱️ **One-click open**: a DSH whale icon in both the Activity Bar and the Secondary Side Bar; click either to embed the DSH web UI in that side bar;
- 🚀 **Automatic service management**: probes the port — reuses an existing `dsh web`, otherwise starts one silently in the background and loads when ready;
- 🔄 **Live status**: the status bar shows service state (running / starting / failed / stopped); click it to toggle the panel;
- 🛟 **Error fallbacks**: busy port, missing `dsh`, startup timeout, crashed or unreachable service all get a readable notice and one-click retry — never a blank page; a port conflict falls back to a free port for that session;
- 🌐 **Bilingual UI**: copy follows the VS Code display language — Chinese for `zh-*`, English otherwise (setting descriptions are bilingual too);
- 📂 **File jumps**: click a file path in the panel to open it in VS Code — `edit` cards **jump to the exact changed line**, `read` cards to the read line, and it **only jumps** (no stray input box or comment thread);
- ➕ **Add to DSH**: right-click a file/selection, or press <kbd>Alt</kbd>+<kbd>D</kbd>, to write `@path` or `@path:start-end` into the composer as a **draft** — you review it and send manually;
- 📋 **Copy/paste/context menu that just works**: fixes broken `Cmd+C` / paste / right-click inside VS Code's embedded webview (macOS especially); a standalone browser is completely unaffected;
- 🧹 **Clean exit**: stops the service it started when the last window closes; never touches a service you started yourself;
- 🔒 **Security boundary**: loopback only (`127.0.0.1` / `localhost` / `[::1]`); never reads credentials.

### 📝 Change visualization: see what the AI did

As soon as DSH edits a file through `edit` / `write`:

- 🟢 **Added lines in green**, 🔴 **deleted lines in red** (drawn as a seam marker so surviving lines are not smeared), 🟡 **replacements in amber**, mirrored in the overview ruler;
- ↩️ an inline `⇠ was: …` hint at the end of the line shows the replaced/deleted original;
- 🖱️ **Hover a changed line** → `DSH edit | add | delete`, +/- stats, a diff preview and **Discard / Keep / Show diff** buttons (multiple records on one line merge into a single hover);
- 🛡️ **Safe discard**: if the original text is gone (you edited it yourself) it asks for confirmation; discarding a `write`-created file deletes it; pure appends only remove the part DSH wrote — **your own code is never harmed**;
- 🧽 Escape hatch when marks drift: `DSH: Clear Marks (Keep Changes)`.

### 🗂️ Reviewable change set: survives Reload, reviewed one by one

- 💾 **Change ledger (ChangeBook)**: changes become **persistent objects** stored in workspace state — after `Developer: Reload Window`, reopening or switching sessions, **records and highlights are still there** and still actionable; the same edit is never recorded twice; files you edited yourself are marked stale (greyed out, "file modified externally") instead of being silently dropped;
- 🧭 **Change navigation**: <kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> walk through changes in the current file, with `DSH Changes 1/3` in the status bar (clicking it equals pressing F8), wrapping around at the end;
  - ⚠️ **No regression to VS Code habits**: <kbd>F8</kbd> only takes over when the current file really has DSH changes; otherwise it stays VS Code's own "next problem";
- 🗂️ **`DSH Changes` tree**: three levels — `session → file → change` (session nodes show "N files · M changes"); click to jump, right-click a node to **keep / discard**;
- 🧨 **Batch actions** at single / **file** / **session** granularity, with <kbd>Ctrl</kbd> multi-select in the tree; the result message always includes the **failure reason breakdown** (e.g. `7 succeeded, 2 failed (original text no longer found (file was edited) ×2)`), and failed entries stay in the tree in red for a retry;
- 🏷️ **Inline CodeLens**: `✅ Keep / ❌ Discard / 🔍 Diff` buttons permanently above changed lines — no hovering required; several changes on one line produce a single group (labelled `(2 changes)`); records whose anchor can no longer be located **show no buttons** (no false "this was edited here" claims).

### 🎛️ Editor as the frontend: answer where you are

- 🛂 **Approval gate**: when DSH needs permission for an out-of-scope action, VS Code shows a **modal** with "Allow once / Deny" — no switching back to the panel;
  - 🔐 Only those two outcomes exist (DSH's payload does not support "always allow", so the UI **never makes a promise it cannot keep**); pressing <kbd>Esc</kbd> means **no answer** — DSH keeps waiting and you can reply in the panel;
  - 🚫 Credential/secret style requests (tool names containing credential / secret / api-key / token / password / env) are **never answered by the IDE**; you are pointed back to the DSH panel;
- 📊 **Agent status item**: a second status bar item, separate from service state — `$(sync~spin) DSH · running · turn N` / `$(bell) DSH · waiting for approval` / `$(check) DSH · idle`;
- 🔔 **Completion notification**: when a turn finishes **and actually changed files**, you get `DSH turn 3 finished: 4 files changed` with a "View" button that focuses the changes tree; empty turns stay silent;
- ❓ **Questions and plan review**: DSH questions surface in the IDE — options become a QuickPick (multi-select supported), free-form answers use an InputBox, and `plan-review` first renders the plan as a **read-only Markdown document** before asking you to approve or send back (optionally with a reason); multi-question batches are **answered all at once and returned as one payload** — cancelling any question abandons the whole batch;
- 🧠 **No double-asking**: by default, approvals/questions are left to the panel while it is visible (`dsh.interaction.onlyWhenPanelHidden`) — if you are already looking at the panel, the IDE stays quiet.

### ⏪ Cross-turn rollback: back to before a given turn

- 🕐 **`DSH Checkpoints` view**: reads DSH's `change-ledger` and lists checkpoints per turn ("turn N · time · N files"); expanding shows the files modified or deleted since that turn;
- 🔍 **Native diff**: click an entry to open VS Code's built-in diff editor (that turn's snapshot ↔ now);
- ⏪ **One-click restore**: right-click → "Restore code to before this turn" → **preview** the affected file list → modal confirmation → apply, ending with `Restored N files to before that turn`;
- 🧯 **Honest degradation**: regular git worktrees only (non-git workspaces show "no checkpoints in this workspace"); if another active session uses the same workspace it reports `WORKSPACE_IN_USE` instead of forcing its way; destructive actions are **never auto-retried**.

### ⚡ Edit in place: selection toolbar + Quick Edit

- 🎯 **Selection toolbar**: after you select code, `Add Selection to DSH` / `⚡ Quick Edit` appear above the first selected line, alongside an in-editor comment-thread input box;
- 📝 **Add to DSH**: writes `@file:start-end` into the composer as a **draft** (not sent) so you can finish your prompt first;
- ⚡ **Quick Edit**: type "debounce this" in the box and send — or press <kbd>Alt</kbd>+<kbd>K</kbd> and hit Enter — and DSH receives `@file:12-14 debounce this` and runs it;
  - 🛑 A confirmation dialog (showing the full text) appears before the first send, with a "send and don't ask again" option; empty instructions are never sent, so **no model turn is spent on your behalf**;
  - ⏸️ While DSH is busy the instruction is only written to the draft with a "DSH is running" notice — **nothing is preempted and nothing is lost**;
- 🕊️ **Never intrusive**: only user selections trigger it (programmatic jumps do not), the cursor never moves, focus is never stolen, and zero-length or whitespace-only selections do nothing.

### ⚙️ Controllable: every feature can be turned off

Everything introduced in v1.2 has its own setting, **all enabled by default**, and **changes apply instantly with no window reload** (see [Settings](#️-settings-dsh)).

## 📥 Installation

**Option 1: .vsix package (recommended)**

1. Download the latest `dsh-for-vscode-*.vsix` from [Releases](https://github.com/Jillson1/dsh-for-vscode/releases);
2. In VS Code press `Ctrl+Shift+P` → run `Extensions: Install from VSIX...` → select the file;
3. Reload the window (`Developer: Reload Window`).

**Option 2: Build from source**

```bash
git clone https://github.com/Jillson1/dsh-for-vscode.git
cd dsh-for-vscode
npm install
npm run package        # produces dsh-vscode.vsix — install it as in option 1
```

**Prerequisite**: the `dsh` CLI from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) available on `PATH` (it is probed automatically, with a clear notice if missing).

> 💡 The change set, approval gate, questions, checkpoints and Quick Edit require the companion DSH plugin **`@jillson1/dsh-file-jump`** (it provides replay, uplink forwarding and the same-origin restore call). With the extension alone those features look "unfinished".

## 🚀 Usage

1. After installation a DSH whale icon appears in both the **Activity Bar** and the **Secondary Side Bar**;
2. Click either icon: the extension starts (or reuses) `dsh web` and embeds the DSH web UI;
   - The **right** icon opens the panel on the right, leaving the Explorer untouched;
   - If `dsh.port` is taken, a free port is used for this session (with a notification; your setting is unchanged);
3. Panel title bar: `Open in Browser` `Restart Service` `Stop Service` `Copy URL` `Show Logs`;
4. The status bar shows both service and agent state; clicking toggles the panel;
5. **Let DSH edit a few files**, then: press <kbd>F8</kbd> to review one by one → use hover or the inline buttons to keep/discard → open the `DSH Changes` tree in the Activity Bar for the big picture → use `DSH Checkpoints` when you want to roll back a turn.

### Typical workflows

| What you want | How to do it |
|---|---|
| See exactly what the AI changed | Three-color highlights + hover diff preview, or `DSH: Show Diff` |
| Review change by change | <kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> (progress in the status bar), or the inline `Keep / Discard / Diff` buttons |
| Undo one specific change | "Discard" in the hover, or right-click the node in the `DSH Changes` tree |
| Undo a whole file or session | Right-click a **file** or **session** node (multi-select with <kbd>Ctrl</kbd> supported) |
| Go back several turns | `DSH Checkpoints` view → right-click a checkpoint → restore to before that turn |
| Ask DSH to edit the code I selected | Select → "⚡ Quick Edit" or <kbd>Alt</kbd>+<kbd>K</kbd> → type the instruction |
| Reference this code in the conversation | Select → <kbd>Alt</kbd>+<kbd>D</kbd> (draft only, not sent) |
| Approve an out-of-scope action | Choose "Allow once / Deny" in the VS Code modal |
| Keep things quiet | Turn off `dsh.ideInteraction.enabled`, `dsh.changes.enabled`, etc. |

## ⌨️ Keybindings and context menus

| Action | Default key | Active when |
|---|---|---|
| Next change | <kbd>F8</kbd> | The current file really has DSH changes **and** the change-set switch is on (otherwise VS Code keeps its own behaviour) |
| Previous change | <kbd>Shift</kbd>+<kbd>F8</kbd> | Same as above |
| Add selection to DSH | <kbd>Alt</kbd>+<kbd>D</kbd> | Editor has a selection |
| Quick Edit this selection | <kbd>Alt</kbd>+<kbd>K</kbd> | Editor has a selection |

Context menu entries: Explorer / editor tab (`Add to DSH`), editor (`Add to DSH`, `Quick Edit This Selection`), `DSH Changes` nodes (keep/discard/batch), `DSH Checkpoints` nodes (diff/restore), comment thread title (`Add to DSH` / `Quick Edit`).

## 🧰 Command palette (`DSH:`)

**Panel and service**

| Command | Description |
|---|---|
| `DSH: Open Panel` | Open the left panel |
| `DSH: Open in Secondary Side Bar` | Open the right panel |
| `Open in Browser` | Open the DSH page in your system browser |
| `Restart Service` / `Stop Service` | Restart / stop the extension-managed service |
| `Copy URL` | Copy the DSH page URL |
| `Show Logs` / `DSH: Copy Logs` | Open the log channel / copy full logs (including environment info) for bug reports |
| `DSH: Retry Bridge Install` / `DSH: Uninstall Bridge` | Reinstall the bridge / remove it and restore `cordis.patch.yml` |

**Add to DSH**

| Command | Description |
|---|---|
| `Add to DSH` | Write a `@path` draft |
| `Add Selection to DSH (Alt+D)` | Write a `@path:start-end` draft |

**Change visualization and actions**

| Command | Description |
|---|---|
| `DSH: Show Diff` | Open the before/after diff editor |
| `DSH: Revert Last Modification` / `DSH: Keep Last Modification` | Act on the most recent change in the current file |
| `DSH: Revert All Modifications` / `DSH: Keep All Modifications in File` | Act on the whole current file |
| `DSH: Clear Marks (Keep Changes)` | Clear marks only, files untouched (escape hatch when marks drift) |

**Change set (F1–F5)**

| Command | Description |
|---|---|
| `DSH: Next Change` / `DSH: Previous Change` | Same as <kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> |
| `Open Change` / `Keep Change` / `Discard Change` | Per-change actions (tree or inline buttons) |
| `Keep All Changes in File` / `Discard All Changes in File` | File-level batch |
| `Keep All Changes in Session` / `Discard All Changes in Session` | Session-level batch |
| `Refresh Change List` | Refresh the `DSH Changes` tree |

**Checkpoints (F9)**

| Command | Description |
|---|---|
| `Refresh Checkpoints` | Re-read the ledger |
| `Diff Against This Turn` | Native diff: that turn's snapshot ↔ the current file |
| `Restore Code To Before This Turn` | Preview → confirm → apply |

**Selection and Quick Edit (F10/F11)**

| Command | Description |
|---|---|
| `DSH: Quick Edit Selection (Alt+K)` | Input box; Enter sends |
| `Quick Edit This Selection` | Thread title button: expand the in-editor input box |
| `Add Selection to DSH` | Thread title button: write a draft without sending |
| `Send to DSH` | Thread input button: send the instruction to DSH |

## 🔗 Bridge and integration

On installation the extension installs its bridge package into your DSH user directory (through DSH's official client-plugin extension point) so the panel and VS Code can talk both ways:

- 🔗 **External links**: clicking a link inside the panel opens your system browser instead of being trapped in the iframe;
- 📂 **File jumps**: clicking a file path opens and reveals it in VS Code;
- 📋 **Clipboard copy**: copy buttons inside DSH write to the system clipboard through the extension host, bypassing VS Code's cross-origin iframe clipboard restriction;
- 🔄 **Bidirectional messages (interaction enhancements)**: replay/attribution of applied diffs, session state (running / turn / pending count), approval requests and question requests travel **upstream**; approval decisions, question answers, Quick Edit instructions and checkpoint restore calls travel **downstream**.

After a successful handshake the log prints the capability list:

```
[bridge] handshake ok capabilities=[openFile,diffApplied,injectComposer,quickEdit,approval,question,changes,checkpoint,sessionState]
```

### Install / uninstall mechanics (full disclosure)

1. Installs the bridge package `dsh-vscode-bridge` into your DSH user directory (`$DSH_HOME/profiles/web`, i.e. `~/.dsh/profiles/web` by default); the extension ships the matching version and reinstalls it when the version differs;
2. Writes an `insert:` entry marked with `# dsh-vscode-bridge: begin` / `# dsh-vscode-bridge: end` into `cordis.patch.yml`, registering the bridge as an official DSH client plugin (**user directory only — the DSH installation directory is never touched**).

To remove it, run `DSH: Uninstall Bridge`: the marked entry is deleted precisely, the bridge directory is removed, and `cordis.patch.yml` is restored byte-for-byte (your own content is unaffected).

### Degraded mode

The bridge only works inside the panel. If it is unavailable (e.g. you opened the DSH page in a standalone browser, or installation failed) the **panel remains fully usable** — only the integrations above are missing, and a one-time warning offers "Retry install" or "Don't show again". Interaction features (approvals, questions, checkpoints, Quick Edit, change replay) depend on the bridge and quietly stay absent without it.

## ⚙️ Settings (`dsh.*`)

> Every switch is **on by default** and applies **instantly** — no window reload.

### Feature master switches (v1.2 interaction enhancements)

| Setting | Default | When turned off |
|---|---|---|
| `dsh.changes.enabled` | `true` | Stops recording edits (not even reading files), removes three-color highlights and inline buttons, empties the `DSH Changes` tree, hands <kbd>F8</kbd> back to VS Code; **also clears existing marks and the ledger** (the only switch that drops history — the setting description says so) |
| `dsh.checkpoints.enabled` | `true` | Never reads `~/.dsh/change-ledger` (no I/O), the checkpoints view is empty, restore commands only notify instead of calling out |
| `dsh.ideInteraction.enabled` | `true` | No approval modal, question picker or completion notification in the IDE; no selection toolbar or in-editor input box; approvals and questions are **left to the DSH panel** |
| `dsh.quickEdit.enabled` | `true` | <kbd>Alt</kbd>+<kbd>K</kbd>, the context-menu item and thread sending all report that the feature is off and **never send anything** |
| `dsh.statusbar.agent.enabled` | `true` | Hides only the agent status item (service state and notifications unaffected) |

### Fine-grained switches and behaviour

| Setting | Default | Description |
|---|---|---|
| `dsh.selection.lens.enabled` | `true` | The toolbar buttons above the first selected line (context menu and shortcuts still work when off) |
| `dsh.selection.threads.enabled` | `true` | In-editor comment thread input box (with it off, Quick Edit falls back to the Alt+K input box) |
| `dsh.quickEdit.confirmBeforeSend` | `true` | Confirm before Quick Edit sends (it spends a real model turn); choosing "send and don't ask again" flips this to `false` |
| `dsh.notify.onTurnComplete` | `true` | Turn-complete notification (only when the turn really changed files) |
| `dsh.interaction.onlyWhenPanelHidden` | `true` | Leave approvals/questions to the panel while it is visible instead of asking again in the IDE |

### Service and bridge

| Setting | Default | Description |
|---|---|---|
| `dsh.port` | `3080` | Expected port (used for both probing and startup) |
| `dsh.host` | `127.0.0.1` | Service address (loopback only) |
| `dsh.autoStart` | `true` | Start the service automatically when it is not running |
| `dsh.stopOnExit` | `true` | Stop the extension-started service when the last window closes |
| `dsh.extraArgs` | `[]` | Extra arguments when starting `dsh web` |
| `dsh.executablePath` | `""` | Absolute path to the `dsh` executable (`dsh.cmd` on Windows); empty = look up on `PATH` |
| `dsh.workspaceRootIndex` | `0` | Which workspace root to use as the `dsh web` working directory |
| `dsh.bridge.enabled` | `true` | Enable the bridge (with it off, none of the integrations above work) |
| `dsh.bridge.silenceWarning` | `false` | Suppress bridge degradation warnings |

## 🌍 Localization

UI strings follow the VS Code display language (`Configure Display Language`): `zh-*` → Simplified Chinese, everything else → English. Setting descriptions are bilingual too (`package.nls.json` / `package.nls.zh-cn.json`).

## 🧑‍💻 Development

Requirements: Node.js ≥ 22, VS Code ≥ 1.91.

```bash
npm install
npm run test          # 400 unit/integration tests (including a real dsh web round trip)
npm run compile       # build out/extension.js
npm run watch         # watch build
npm run typecheck     # type check
npm run package       # package the .vsix
```

Debugging: open this folder in VS Code and press `F5` to launch the Extension Development Host.

```
src/
├── extension.ts           # entry: wiring, command registration, settings dispatch
├── config.ts              # settings read + normalization (including feature switches)
├── i18n.ts                # dynamic string dictionary (zh-* vs English)
├── statusbar.ts           # service status item + agent status item (F7)
├── bridge/                # bridge installer, handshake host, message handling, diff executor
│   ├── diff-service.ts    # three-color highlights / revert / hover / diff view
│   ├── diff-tracker.ts    # locating and revert-edit construction (pure logic)
│   ├── change-book.ts     # F1 change ledger (persistence + stale detection)
│   ├── approval-router.ts # F6 approval gate (safety boundaries)
│   ├── question-router.ts # F8 questions / plan review
│   └── agent-state.ts     # F7 state machine
├── changes/               # F2 navigation / F3 tree / F4 batch / F5 CodeLens
├── checkpoints/           # F9 ledger reading, blob diff, restore orchestration
├── selection/             # F10 toolbar and thread / F11 Quick Edit
├── service/               # port probing, child process wrapper, service manager
└── panel/                 # webview view provider and placeholder page template
```

## 🧭 Known limitations

- **Checkpoints require a regular git worktree** (engine limitation): non-git folders, sparse checkouts and submodules produce no checkpoints;
- **Restore depends on the DSH-side plugin**: without `@jillson1/dsh-file-jump` the checkpoints view still lists history, but "restore" reports that it is unavailable;
- **No sound notification**: the VS Code extension API has no audio capability, so there is deliberately no "play a sound when done" setting (better to omit it than ship a dead switch);
- **The selection input box width is not controllable**: comment threads are native VS Code widgets; this extension's compromise is "collapsed by default + a compact summary body";
- **Turning off the change set clears history**: `dsh.changes.enabled` clears the ledger together with the marks (to keep state consistent), and re-enabling does not restore history;
- The colourful icon on the walkthrough card comes from Marketplace gallery data and only appears once listed there;
- VS Code platform rule: the left icon opens the left panel and the right icon the right one; they cannot be crossed.

## 🌐 Community

This project is a DeepSeek Harness community plugin (topic: [`dsh-plugin`](https://github.com/topics/dsh-plugin)).

- DSH repository: <https://github.com/deepseek-ai/deepseek-harness>
- Companion DSH plugin: <https://github.com/Jillson1/dsh-file-jump>
- Issues: <https://github.com/Jillson1/dsh-for-vscode/issues>
- DSH discussions: <https://github.com/deepseek-ai/deepseek-harness/discussions>

## 📄 License

[MIT](./LICENSE) © 2026 liufuchen
