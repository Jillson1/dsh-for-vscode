## [0.3.3] - 2026-09-18

> 本版在发布说明完成前又修掉一个同批次发现的缺陷（见下"选区工具条闪烁"），
> 因此**同一版本号 dsh-for-vscode-0.3.3.vsix 是修正后的构建**（此前数分钟内发布的附件已被替换）。

### 修复

- **编辑区划选后「添加到 DSH / Quick Edit」按钮闪一下就消失**：选区来源此前记的是
  "最后一次选区事件是什么"，而选区事件流里夹着大量 VS Code 的**程序化补发**
  （`kind = Command`：渲染 CodeLens、拖选收尾、视图变化都会发）。
  任何一次补发都会把刚记下的"用户选区"冲掉 → 120ms 防抖后的重算就把工具条收掉 → 表现为闪烁。

  修复：判定收敛到 `editorReveal.classifySelectionOrigin`，**只在提供新信息的事件上更新来源**：
  | 事件 | 判定 |
  |---|---|
  | `Mouse` / `Keyboard`（不在静音窗内） | 用户发起 → 出按钮 |
  | `Command` 不在静音窗内 | **不提供信息**（返回 null，调用方保持原值）← 本缺陷的修复点 |
  | `Command` 在静音窗内（= 我们自己的跳行定位） | 程序化 → 不出按钮 |
  | `undefined` / 其它 | 不提供信息 → 保持原值 |

  另外：切换活动编辑器时显式回到"未判定"，避免把上一个文件的用户选区状态带到新文件上。

### 修复

- **快速迭代会话里"edit/write 失去高亮"**：原定位只做"整段文本 `indexOf`"（外加一次换行风格归一），
  同一文件被连续编辑后，早先记录锚点**行与行之间会被插入别的改动** → 整段不再连续 → 定位失败 → 该记录被跳过、无高亮。
  真机实测（pdf-2c-skill 会话）：单轮内同一文件被改 **46 次**，失败记录距下一次编辑**中位数 3.9 秒**。
  在 532 条真实记录上复算：**可定位 62.4% → 85.7%，111 条记录重新获得高亮**。

  **分层定位**（`locateTextDetailed`，五档按序尝试）：
  | 档 | 含义 | 置信度 |
  |---|---|---|
  | `exact` | 整段精确命中 | 1.0 |
  | `eol` | 仅换行风格不同（CRLF ↔ LF） | 1.0 |
  | `ws` | 仅缩进/首尾空白不同（所有非空行 trim 后对齐） | 0.88–0.95 |
  | `gap` | **允许锚点各行之间夹着别的行**（行序列匹配）—— 本轮修复的核心场景 | 0.90–1.0 |
  | `near` | 滑窗逐行相似度取最像的一段（锚点 ≥3 行、相似度 ≥ 0.5） | 0.50–1.0 |

  **UI 分级护栏（关键）**：降级命中 ≠ 文件被改过，所以
  - `ws` / `gap` / `near` 三档一律**灰调呈现**（低透明度、无 overview ruler 标记），
    且**不注入行尾 `⇠ 原:` 提示**——那句提示是"这里原本是这段内容"的断言，放在推测位置上就是误导；
  - hover 里**不给「丢弃 / 保留」按钮**，只给「查看对比」，并说明原因（"位置由近似匹配还原…"）。
    原因：丢弃会按锚点改文件、保留会断言"这里就是那次改动"，两者都不接受"大概"。
  - `refreshFile` 日志同时给出"低置信 N 条"与每条的档位与分数，便于现场核对。

### 新增

- `test/bridge/locate-layered.test.ts`（14 例）：五档语义、置信度区间、`allowsInPlaceAction` 分级、
  `resolveRecordMarks` 与 legacy `locateNewText` 的位置一致性、以及"五档全失败必须返回 null"。

## [0.3.2] - 2026-09-17

### 修复

- **Quick Edit 交互统一（真机反馈）**：原先同一功能有**两种弹窗形态**——选区工具条按钮走"评论线程 + 编辑器内输入框"（弹在选区下方），右键菜单与 `Alt+K` 走"编辑器顶部 InputBox"。
  现在**三条入口共用顶部同一个 InputBox**（`dsh.selection.quickEdit` 直接调用 `quickEditFromInput`）：弹出位置、回车即发、空指令校验、发送前确认**完全一致**。
  - 为什么不能"两条路做成外观一样"：评论线程输入框是 VS Code 原生 widget，位置固定在选区下方、宽度不由扩展控制，**永远无法**与顶部 InputBox 对齐，因此只能统一到 InputBox。
  - 随之移除已不可达的死命令 `dsh.selection.submitReply`、菜单贡献点 `comments/commentThread/context` 与对应激活事件、文案键 `dsh.cmd.selectionSubmitReply.title`（中英）——不留"点了没反应"的命令。
  - 工具条按钮文案改为「用指令改这段代码 / Edit This Selection with an Instruction」，不再暗示"编辑器内输入框"。
  - 保留选区工具条两个按钮（`🐳 添加到 DSH` / `✨ Quick Edit`）与评论线程的锚点/标题按钮职责。

## [0.3.1] - 2026-09-17

### 新增

- **设置开关：v1.2 交互增强的每个功能都可在 VS Code 设置里开/关**（默认全开，升级不改变既有行为；**改开关立即生效，无需 Reload Window**）：
  - `dsh.changes.enabled`：F1 变更账本 / F2 `F8` 导航 / F3 `DSH 变更` 树 / F4 批量处置 / F5 行内 CodeLens（含三色高亮与 hover 处置）。
    关闭后不再记录改动（连文件都不读）、不出高亮与按钮、`F8` 交还 VS Code 原本的"下一个问题"，并**清空已有标记与账本**（设置描述里已写明该后果）。
  - `dsh.checkpoints.enabled`：F9 检查点树 / blob 原生 diff / 跨轮恢复。关闭后完全不读 `~/.dsh/change-ledger`，恢复类命令只提示不发起请求。
  - `dsh.ideInteraction.enabled`：F6 审批闸门 / F7 完成通知 / F8 提问与计划审阅 / F10 选区工具条与编辑器内输入框。关闭后不在 IDE 弹任何东西，审批与提问**交回 DSH 面板**应答。
  - `dsh.quickEdit.enabled`：F11 Quick Edit（`Alt+K` / 右键菜单 / 线程内发送）。关闭后四个入口均明确提示，**绝不向 DSH 发送指令**。
  - `dsh.statusbar.agent.enabled`：F7 agent 状态栏项（状态栏项不支持 `when` 条件，由扩展自行隐藏）。
  - 设置的**中英描述已随包发布**（`package.nls.zh-cn.json` / `package.nls.json`），每条都写明"关掉会发生什么"。
- **默认值守卫测试**：钉住"`package.json` 贡献点默认值 ↔ `config.ts` 的 `DEFAULTS` ↔ 用户从未配置时的运行时回退值"三处一致，防止出现"设置面板勾是开的、功能却没生效"。

### 变更

- **扩展版本 `0.3.0 → 0.3.1`**；内置桥接 `dsh-vscode-bridge@0.4.2`（三处安装目标需同版本）。
- `F8` 键位的上下文键由 `dsh.hasFileChanges` 改为 `dsh.changeNavActive`（= 变更集开关打开 **且** 当前文件确有 DSH 变更），使"关闭变更集"时键位自动让位，无需条件化贡献点。

### 修复

- **加字段后旧断言未同步**的回归风险：`config.test.ts` 的「合法配置原样通过」断言随新配置字段同步更新。

### 说明

- 本版设置面板可见的开关共 10 项（5 个粗粒度总开关 + 5 个细分项），**默认全部开启**。
- 插件侧（DSH 网页里的 `@jillson1/dsh-file-jump`）不读 VS Code 设置：关闭开关后它仍会上报消息，扩展侧不处理即等于关闭（功能契约不受影响，仅多一次无效上报）。

## [0.2.4] - 2026-08-19

### 修复

- **macOS 上聊天内容无法复制/粘贴/右键（issue #3）**：VS Code 在 macOS 上会吞掉嵌套 iframe 内的 `Cmd+C` / `Cmd+V` / `Cmd+A` 等标准快捷键与右键菜单（上游 bug [microsoft/vscode#129178](https://github.com/microsoft/vscode/issues/129178) / [#180234](https://github.com/microsoft/vscode/issues/180234)，官方未修复）。桥接包在握手后接管这些操作：
  - 捕获 `keydown`，识别 `Cmd/Ctrl+C/V/X/A/Z` 与 `Shift+Insert`，优先用 `document.execCommand` 模拟（此方案由 Flutter DevTools 团队在同类场景验证有效）；
  - **复制/剪切兜底**：`execCommand` 不可用时，把选区文本经剪贴板写桥接交给扩展宿主写入系统剪贴板；
  - **粘贴兜底**：新增剪贴板读取桥接（`vscode.env.clipboard.readText`，无 webview 权限限制），把剪贴板文本插入焦点输入框（textareas 兼容 React 受控组件）；
  - **右键菜单**：捕获 `contextmenu` 弹出自定义菜单（复制/粘贴/剪切/全选/撤销/重做），不再依赖 VS Code 的原生菜单；
  - 未握手（普通浏览器）时保持原生行为完全不变。

## [0.2.3] - 2026-08-17

### 修复

- **DSH 侧栏内代码块「复制」无反应**：双层修复剪贴板在 VS Code 内嵌跨源 iframe 中失效的问题：
  - 给内嵌 DSH 页面的 iframe 显式声明 `allow="clipboard-write"`；
  - 桥接包接管 DSH 页面的 `navigator.clipboard.writeText`：复制文本经面板转发给扩展宿主，由 `vscode.env.clipboard` 写入系统剪贴板，绕开 VS Code 对 webview 跨源 iframe 剪贴板 API 的权限拦截；桥接禁用/未安装时保持 DSH 原生行为不变。

# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-08-17

### 修复
- **Windows 下服务启动失败（全局 dsh 场景）**：修复 Windows 上「已全局安装 dsh，插件却报未找到 dsh / 服务启动失败」的完整问题链：
  - Windows 改用 `node <bin.js>` 直跑 dsh 入口，规避 spawn `dsh.cmd` 批处理 shim 的 EINVAL；
  - 桥接包安装到三个位置（web profile、profiles 根、npm 全局 node_modules），覆盖 VS Code 扩展宿主进程的模块解析链；
  - 桥接 host 插件改为**零外部依赖的函数式插件**，不再 import `@deepseek-ai/cordis`——npm 全局安装布局下该依赖嵌套在 dsh 包内部，顶层解析不到会导致整个插件树加载失败；
  - 安装器比对桥接包版本，升级插件时自动刷新旧版桥接包；
  - Windows 下改用系统 PATH 中的 `node.exe` 直跑 dsh 入口，不再使用扩展宿主的 `process.execPath`（Electron 的 Code.exe）——Electron 运行时缺少 dsh loader/HMR 依赖的系统 Node 内部特性，会报 `--expose-internals is required` 并崩溃。
- 子进程因端口被残留 dsh 实例占用而崩溃时，自动探测并复用现有服务，不再误报启动失败。
- 启动期间端口被其他程序抢占（如 WSL 与 Windows 共享 localhost 端口、WSL 侧 dsh 慢启动竞态）导致崩溃时，自动改用第一个空闲端口重启，不再报启动失败。

### 新增
- **端口占用自动替换**：`dsh.port` 被其他程序占用时，自动改用第一个空闲端口（仅本次会话临时生效，不修改设置），并弹窗告知临时端口。
- **日志增强**：日志带时间戳与环境信息头（扩展/VS Code/dsh/Node 版本、平台、关键配置）；记录实际启动命令；新增 `DSH: 复制日志` 命令一键复制完整日志用于问题报告。

## [0.2.1] - 2026-08-16

### 修复
- 构建前清空 out 目录，消除删除文件后的产物残留（测试数统计失真）
- 握手 token 改用 crypto 随机数（不可预测）
- retryBridge 失败路径兜底，消除未处理异常

### 改进
- 扩展改为按需激活，减少 VS Code 启动负担
- 新增 GitHub Actions CI（typecheck + 测试 + 打包）
- 新增 Issue/PR 模板与贡献指南
- README 英文主版 + 中文版（README.zh.md，顶部语言互链）

## [0.2.0] - 2026-08-15

### 新增

- **桥接与工作区联动**：通过官方扩展点桥接包，面板与 VS Code 之间新增两项联动能力：
  - 面板内点击外链，在系统默认浏览器中打开；
  - 面板内点击文件路径，在 VS Code 中打开对应文件。
- **桥接命令**：新增 `DSH: 重试桥接安装` 与 `DSH: 卸载桥接` 命令。
- **桥接设置项**：新增 `dsh.bridge.enabled`（默认 `true`）、`dsh.workspaceRootIndex`（默认 `0`）、`dsh.bridge.silenceWarning`（默认 `false`）。

### 移除

- **工作区自动同步**：移除打开面板时自动把 VS Code 工作区同步为 DSH 工作区的联动能力（用户决定放弃）。

### 修复

- **spawn 工作目录兜底**：自启 `dsh web` 时按 `dsh.workspaceRootIndex` 解析工作区根目录作为子进程工作目录，多根工作区不再错误落点。

### 降级与警告

- 桥接未生效时面板完全可用，仅两项联动不可用；插件启动时会弹一次降级警告，可「重试安装」或「不再提示」。

## [0.1.0] - 2026-08-15

### 新增

- DSH 网页界面在 VS Code 侧边栏内嵌显示，支持左右双侧栏入口。
- 服务自动探测 / 启动 / 复用与状态栏四态指示。
- 异常兜底提示页与一键重连、双语界面、退出清理、回环地址安全边界。
