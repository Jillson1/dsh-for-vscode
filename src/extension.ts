// src/extension.ts — 插件入口：装配各模块、注册命令、监听配置变更
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { initI18n, t } from './i18n';
import { readConfig, type DshConfig } from './config';
import { probeService } from './service/detect';
import { createProcessRunner, findInPath, resolveNpmGlobalNodeModules } from './service/process';
import { ServiceManager, type ManagerOptions } from './service/manager';
import { DshPanelProvider } from './panel/provider';
import { StatusBarController } from './statusbar';
import { resolveWorkspaceRoot } from './workspaceRoot';
import { addFileToDsh, addSelectionToDsh, type AddToDshTargets } from './addToDsh';
import {
  installBridge,
  uninstallBridge,
  createNodeFs,
  type BridgeInstallResult,
} from './bridge/installer';
import { evaluateBridgeStatus, bridgeWarningText } from './bridge/status';
import { DiffService } from './bridge/diff-service';
import { ChangeBook, type RevertOutcome } from './bridge/change-book';

let manager: ServiceManager | null = null;
let output: vscode.OutputChannel | null = null;
/** A 组修改服务（activate 内装配；命令 handler 经模块级引用） */
let diffService: DiffService | null = null;

/** 日志缓冲（供「复制日志」命令 dsh.copyLogs 使用；上限行数防内存膨胀） */
const logBuffer: string[] = [];
/** 日志缓冲最大行数（超出后丢弃最早的行） */
const LOG_BUFFER_MAX = 5000;

/** 统一日志出口：加 HH:MM:SS 时间戳 → 写入输出通道 + 日志缓冲（复制日志命令的数据源） */
function appendLog(line: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const full = `[${ts}] ${line}`;
  logBuffer.push(full);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  output?.appendLine(full);
}

/** globalState 键：用户点击「不再提示」后置 true，持久静默桥接降级警告 */
const BRIDGE_SILENCE_KEY = 'dsh.bridgeWarningSilenced';
/**
 * 握手超时（毫秒）：面板打开且服务就绪后，此时间内无任何 bridgeAck 视为握手失败。
 * 设 10s：DSH web 首次冷启动（加载全部插件与页面资源）可达 ~10s，若窗口过短会把
 * 慢启动误判为握手失败（degraded）而弹错误警告。
 */
const HANDSHAKE_TIMEOUT_MS = 10000;
/** 激活后评估桥接状态的延迟（毫秒）：略大于握手超时，给握手回执留出时间 */
const BRIDGE_EVAL_DELAY_MS = 11000;

/** DshConfig → ManagerOptions（探测 3s、轮询 0.5s，与规格一致） */
function toManagerOptions(config: DshConfig): ManagerOptions {
  return {
    host: config.host,
    port: config.port,
    extraArgs: config.extraArgs,
    autoStart: config.autoStart,
    // 子进程工作目录兜底：按 dsh.workspaceRootIndex 解析工作区根目录，让 dsh web 以工作区为 cwd
    cwd: resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], config.workspaceRootIndex),
    executablePath: config.executablePath,
    timeoutMs: 3000,
    pollMs: 500,
  };
}

/**
 * 定位 dsh 可执行文件并读取其版本（Windows 由 dsh.cmd 推导 bin.js 后读包内 package.json）。
 * 用于环境信息头：问题报告据此核对 dsh 安装位置与版本，无需再追问用户环境。
 */
function describeDshExecutable(config: DshConfig): { path: string | null; version: string | null } {
  let shim: string | null = null;
  let binJs: string | null = null;
  if (process.platform === 'win32') {
    // Windows：显式 executablePath 优先；否则 PATH 找 dsh.cmd → 推导 bin.js 绝对路径
    shim = config.executablePath && !config.executablePath.endsWith('.js')
      ? config.executablePath
      : findInPath('dsh.cmd', process.env.PATH ?? '');
    if (shim) {
      binJs = shim.endsWith('.js')
        ? shim
        : join(dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    }
  } else {
    // 非 Windows：显式路径记录路径；否则只记录命令名（版本读取依赖具体安装布局，跳过）
    shim = config.executablePath && config.executablePath.length > 0 ? config.executablePath : 'dsh';
  }
  if (binJs) {
    try {
      // bin.js 上两级即 @deepseek-ai/dsh 包根，读其 package.json 的 version
      const version = JSON.parse(readFileSync(join(dirname(dirname(binJs)), 'package.json'), 'utf8')).version;
      return { path: shim, version };
    } catch {
      /* 读取失败按版本未知处理 */
    }
  }
  return { path: shim, version: null };
}

/** 插件激活：VS Code 启动完成后调用 */
export function activate(context: vscode.ExtensionContext): void {
  // 语言规则：vscode.env.language 以 zh- 开头 → 中文，其余一律英文
  initI18n(vscode.env.language);
  output = vscode.window.createOutputChannel('DSH');

  const { config, errors } = readConfig();
  for (const err of errors) appendLog(`[config] ${err}`);

  // —— 环境信息头：版本/平台/可执行文件/关键配置，问题报告排查的第一手依据 ——
  appendLog('=== DSH 扩展环境信息 ===');
  appendLog(`扩展版本: ${context.extension.packageJSON.version}`);
  appendLog(`VS Code 版本: ${vscode.version}`);
  appendLog(`平台: ${process.platform} (${process.arch})`);
  const electronVersion = (process.versions as { electron?: string }).electron;
  appendLog(`宿主 Node: ${process.version}${electronVersion ? ` / Electron ${electronVersion}` : ''}`);
  const dshInfo = describeDshExecutable(config);
  appendLog(`dsh 可执行文件: ${dshInfo.path ?? '未定位'}`);
  appendLog(`dsh 版本: ${dshInfo.version ?? '未知'}`);
  appendLog(
    `配置: host=${config.host} port=${config.port} autoStart=${config.autoStart} stopOnExit=${config.stopOnExit} ` +
    `bridgeEnabled=${config.bridgeEnabled} extraArgs=${JSON.stringify(config.extraArgs)} ` +
    `executablePath=${config.executablePath || '(空)'}`,
  );
  appendLog(`工作区: ${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(', ') || '(无)'}`);
  appendLog('=============================');

  // —— 桥接状态（单一状态，两个面板共享，避免多个面板重复触发定时器）——
  // install：桥接安装结果；桥接禁用时为 null（不安装、不评估、不弹警告）。
  // handshakeOk：握手回执（onBridgeAck 写入）；undefined=尚未握手，true/false=握手成败。
  let install: BridgeInstallResult | null = null;
  let handshakeOk: boolean | undefined;
  // bridgeCapabilities：桥接握手回执上报的能力表（0.4.0 起）；
  // undefined = 尚未握手或旧桥接未上报。T0 只记录+打日志，阶段 2/3 用它门控命令显隐。
  let bridgeCapabilities: string[] | undefined;
  let handshakeTimer: NodeJS.Timeout | undefined;
  let evalTimer: NodeJS.Timeout | undefined;
  let panelOpened = false; // 是否已有面板打开过（触发握手超时的前提之一）
  let warningShown = false; // 本次会话是否已弹过降级警告（防止重复弹）

  /** 桥接安装参数（dshHome / bridgeSourceDir 全插件共用，避免三处重复拼接；Windows 装配第三安装目标） */
  const installOpts = {
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    bridgeSourceDir: join(__dirname, 'bridge-client'),
    fs: createNodeFs(),
    npmGlobalNodeModules: resolveNpmGlobalNodeModules(config.executablePath),
  };

  /**
   * 安全安装桥接：installBridge 的 IO 异常会直接抛出（Task 2 已知局限），
   * 此处 try/catch 捕获后按 degraded 处理（原因写入日志），绝不影响面板其它功能。
   */
  function safeInstallBridge(): BridgeInstallResult {
    try {
      return installBridge(installOpts);
    } catch (err) {
      appendLog(`[bridge] install failed: ${String(err)}`);
      return { status: 'degraded', reason: String(err) };
    }
  }

  // 激活时安装桥接：bridge.enabled=false 时不安装、不注入握手脚本、不评估、不弹警告
  if (config.bridgeEnabled) {
    install = safeInstallBridge();
  }

  /** 清除握手超时定时器（收到回执或重试时调用） */
  function clearHandshakeTimer(): void {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    }
  }

  /**
   * 启动握手超时（幂等）：面板已打开且服务已就绪、且尚未回执时，3 秒内无 bridgeAck 视为失败。
   * 服务未就绪时没有 iframe、握手不可能发生，因此不在此刻启动定时器，
   * 避免「服务启动慢」被误判为桥接降级；待 manager 进入 ready 后由 onChange 再触发。
   */
  function startHandshakeTimeout(): void {
    if (install === null) return; // 桥接被禁用：无握手脚本，不启动定时器
    if (handshakeOk !== undefined || handshakeTimer !== undefined) return;
    if (!panelOpened) return;
    if (manager?.getSnapshot().state !== 'ready') return;
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      // 3 秒内无任何 bridgeAck → 判定握手失败（degraded）
      if (handshakeOk === undefined) {
        appendLog('[bridge] handshake timeout');
        handshakeOk = false;
        evaluateAndWarn(); // 握手刚失败，立即评估（不必再等固定延迟）
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * 面板握手回执回调（两个面板共享）：记录结果并取消超时（握手已发生，无论成败）。
   * bridge 0.4.0 起回执携带 capabilities 能力表：扩展据此门控命令显隐（最小版能力协商 E1）。
   * 旧桥接不带该字段 → capabilities 为 undefined，视为"未知能力"（按最保守策略处理）。
   */
  function onBridgeAck(ok: boolean, capabilities?: string[]): void {
    const caps = capabilities === undefined ? '(未上报)' : `[${capabilities.join(',')}]`;
    appendLog(`[bridge] handshake ${ok ? 'ok' : 'failed'} capabilities=${caps}`);
    handshakeOk = ok;
    bridgeCapabilities = capabilities;
    // 能力表写入 VS Code 上下文键：后续命令/菜单可用 when 子句门控显隐
    // （如 `dsh.bridge.capabilities =~ /approval/`），避免"只装一半"时命令点了没反应。
    void vscode.commands.executeCommand('setContext', 'dsh.bridge.capabilities', bridgeCapabilities ?? []);
    clearHandshakeTimer();
  }

  /** 交互增强（bridge 0.4.0）上行消息落点：T0 打桩（打日志），后续阶段由各服务接管 */
  function logBridgeEvent(event: { name: string; [k: string]: unknown }): void {
    appendLog(`[bridge] event ${event.name} ${JSON.stringify(event)}`);
  }

  /** 任一面板首次打开：标记已打开并尝试启动握手超时（幂等，不重复建定时器） */
  function onPanelFirstOpen(): void {
    panelOpened = true;
    startHandshakeTimeout();
  }

  /**
   * 评估桥接状态并在 degraded 时弹警告。
   * 静默条件（任一为真则不弹）：设置项 dsh.bridge.silenceWarning、globalState 静默标志、
   * 或本次会话已弹过；安装/握手成功（ok / pending-restart）也不弹。
   */
  function evaluateAndWarn(): void {
    if (install === null) return; // 桥接被禁用，不评估
    const status = evaluateBridgeStatus(install, handshakeOk);
    if (status !== 'degraded') return;
    if (readConfig().config.silenceWarning) return; // 设置项静默
    if (context.globalState.get<boolean>(BRIDGE_SILENCE_KEY)) return; // 「不再提示」静默
    if (warningShown) return; // 本次会话已弹过
    warningShown = true;
    const text = bridgeWarningText(status);
    if (text === null) return; // 防御性兜底（degraded 必有文案）
    void vscode.window
      .showWarningMessage(t(text), t('bridge.retryNow'), t('bridge.neverAgain'))
      .then((choice) => {
        if (choice === t('bridge.retryNow')) {
          void retryBridge(); // 重试安装：重新 installBridge + 重启服务
        } else if (choice === t('bridge.neverAgain')) {
          void context.globalState.update(BRIDGE_SILENCE_KEY, true); // 不再提示
        }
      });
  }

  /** 调度一次桥接状态评估（可重复调用；重复调用会重置定时器，只保留最后一次） */
  function scheduleEvaluation(): void {
    if (evalTimer) clearTimeout(evalTimer);
    evalTimer = setTimeout(() => {
      evalTimer = undefined;
      evaluateAndWarn();
    }, BRIDGE_EVAL_DELAY_MS);
  }

  /** 重试安装桥接（命令 dsh.bridge.retry 与警告「重试安装」按钮共用） */
  async function retryBridge(): Promise<void> {
    try {
      if (!readConfig().config.bridgeEnabled) return; // 桥接被禁用：不重试
      // 重新安装（异常降级并记日志，不中断重试流程）
      install = safeInstallBridge();
      // 重置握手状态：重启后 iframe 重载会重新握手，onBridgeAck 会写入新结果
      handshakeOk = undefined;
      clearHandshakeTimer();
      // 清警告静默（globalState 标志），允许后续再次弹出降级警告
      await context.globalState.update(BRIDGE_SILENCE_KEY, false);
      warningShown = false;
      // 重启服务，触发面板 iframe 重载与重新握手
      await manager?.restart();
      // 重启后重新评估一次（留出握手回执时间）
      scheduleEvaluation();
    } catch (err) {
      // 重试失败只记日志：命令入口是 void 调用，异常不能成为未处理拒绝
      appendLog(`[bridge] retry failed: ${String(err)}`);
    }
  }

  /** 卸载桥接（命令 dsh.bridge.uninstall）：删除 profile 条目与目录，提示需重启 DSH 服务生效 */
  async function uninstallBridgeCmd(): Promise<void> {
    try {
      uninstallBridge(installOpts);
      void vscode.window.showInformationMessage(t('bridge.uninstalled'));
    } catch (err) {
      appendLog(`[bridge] uninstall failed: ${String(err)}`);
      void vscode.window.showWarningMessage(t('bridge.uninstallFailed', { message: String(err) }));
    }
  }

  manager = new ServiceManager(toManagerOptions(config), {
    probeService,
    processRunner: createProcessRunner(),
    log: (line) => appendLog(line),
    // 端口被占用自动临时替换成功：弹窗告知用户新端口（仅本次会话，配置未变）
    onPortFallback: (requested, fallback) => {
      void vscode.window.showInformationMessage(t('msg.portFallback', { port: requested, fallback }));
    },
  });
  manager.setExitBehavior(!config.stopOnExit);

  // 工作区根目录解析：多根工作区按 dsh.workspaceRootIndex 取根（越界回退第一个）。
  // 该 getter 仅用于 provider 的文件相对路径解析（openFile 的 workspaceRoot 兜底基准）。
  const workspaceRootGetter = (): string | undefined =>
    resolveWorkspaceRoot(vscode.workspace.workspaceFolders ?? [], readConfig().config.workspaceRootIndex);
  // 桥接启用 getter：随时读取最新配置，供 readyPage 决定是否注入握手脚本
  const bridgeEnabledGetter = (): boolean => readConfig().config.bridgeEnabled;

  // —— A 组：修改可视化服务（单例，两个面板共享；高亮/撤销/diff 视图/hover）——
  // —— F1：变更账本（持久化到 workspaceState；跨 Reload / 重开会话仍可查、可撤）——
  // 撤销执行委托给 DiffService（账本不碰文件 IO，只负责"记什么、还在不在"）。
  const changeBook = new ChangeBook(
    context.workspaceState,
    async (_sessionId, callId): Promise<RevertOutcome> => {
      const svc = diffService;
      if (svc === null) return { status: 'failed', reason: 'diff service unavailable' };
      return svc.revertOutcome(callId);
    },
  );

  diffService = new DiffService({
    window: vscode.window,
    workspace: vscode.workspace,
    languages: vscode.languages,
    commands: vscode.commands,
    Uri: vscode.Uri,
    Position: vscode.Position,
    Range: vscode.Range,
    WorkspaceEdit: vscode.WorkspaceEdit,
    MarkdownString: vscode.MarkdownString,
    Hover: vscode.Hover,
    readFileText: async (p) => {
      const { promises: fs } = await import('node:fs');
      return fs.readFile(p, 'utf8');
    },
    log: (m) => appendLog(`[diff] ${m}`),
    workspaceRoot: workspaceRootGetter(),
    book: changeBook, // F1：record 写账本；keep/revert/清除标记同步移除
  });
  // 局部非空引用（模块级 diffService 供命令 handler 使用；activate 内用 ds 避免 null 收窄）
  const ds = diffService;

  // —— F1 恢复：把账本里的变更灌回修改栈，让 Reload 后记录与高亮仍在 ——
  // 口径说明：T1 恢复**全部会话**的记录（用户重载后最直接的期待是"我改过的文件还有标记"）；
  // 会话维度的过滤属于 T2 的树 / F2 的导航（那里才需要"当前会话"语义）。
  {
    const sessionIds = changeBook.sessions();
    let restored = 0;
    for (const sid of sessionIds) {
      const recs = changeBook.records(sid);
      if (recs.length > 0) restored += ds.adoptFromBook(recs);
    }
    appendLog(
      `[book] 恢复 ${restored} 条变更记录（账本 ${changeBook.count()} 条 / ${sessionIds.length} 个会话）`,
    );
  }

  // 左右两侧各一个 provider 实例，共享同一 manager（服务状态一致）
  const panelPrimary = new DshPanelProvider(
    manager,
    () => {
      void showSecondaryGuideOnce(context); // 首次打开面板弹一次入口引导
      onPanelFirstOpen(); // 面板打开：标记并尝试启动握手超时
    },
    onBridgeAck, // onBridgeAck：桥接握手回执 → handshakeOk（Task 7 状态评估）
    workspaceRootGetter, // workspaceRoot：文件相对路径解析的兜底基准
    bridgeEnabledGetter, // bridgeEnabled：dsh.bridge.enabled 驱动握手脚本注入
    diffService, // A 组：修改服务（recordDiff / bridgeDiffApplied 共用）
    logBridgeEvent, // bridge 0.4.0：交互增强上行消息落点（T0 打桩）
  );
  const panelSecondary = new DshPanelProvider(
    manager,
    onPanelFirstOpen, // 辅助侧边栏首次打开同样触发握手超时
    onBridgeAck,
    workspaceRootGetter,
    bridgeEnabledGetter,
    diffService,
    logBridgeEvent,
  );
  new StatusBarController(manager);

  // 服务就绪后启动握手超时（若面板已打开）
  manager.onChange((s) => {
    if (s.state === 'ready') {
      startHandshakeTimeout(); // 服务就绪：若面板已打开，启动握手超时
    }
  });

  context.subscriptions.push(
    // 第三参数：隐藏面板时保留 webview（iframe 不销毁、DSH 页面会话不丢）
    vscode.window.registerWebviewViewProvider('dsh.panel', panelPrimary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('dsh.panel.secondary', panelSecondary, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openPanel', () => openPanel()),
    vscode.commands.registerCommand('dsh.openSecondary', () => openSecondary(context)),
    vscode.commands.registerCommand('dsh.openExternal', () => openExternal()),
    vscode.commands.registerCommand('dsh.restart', () => void manager?.restart()),
    vscode.commands.registerCommand('dsh.stop', () => void manager?.stop()),
    vscode.commands.registerCommand('dsh.copyUrl', () => copyUrl()),
    vscode.commands.registerCommand('dsh.showLogs', () => output?.show()),
    vscode.commands.registerCommand('dsh.copyLogs', () => copyLogs()),
    vscode.commands.registerCommand('dsh.bridge.retry', () => void retryBridge()),
    vscode.commands.registerCommand('dsh.bridge.uninstall', () => void uninstallBridgeCmd()),
    // —— Add to DSH：右键文件/选区 → 注入文件引用到 DSH 输入框 ——
    // explorer/context 会把 resource 作为 uri 参数传入；无 uri 时回退活动编辑器文档。
    vscode.commands.registerCommand('dsh.addFileToDsh', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      const targets: AddToDshTargets = { providers: [panelPrimary, panelSecondary] };
      void addFileToDsh(target, targets);
    }),
    vscode.commands.registerCommand('dsh.addSelectionToDsh', () => {
      const targets: AddToDshTargets = { providers: [panelPrimary, panelSecondary] };
      void addSelectionToDsh(targets);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dsh')) onConfigChanged();
    }),
    // —— A/B 组：修改可视化命令 + 生命周期 ——
    vscode.commands.registerCommand('dsh.diff.show', () => void showDiffForActive()),
    // revert 支持可选参数：hover 按钮传 callId（精确撤销该处）；无参 = 撤销当前文件最近一处
    vscode.commands.registerCommand('dsh.diff.revert', (callId?: string) => {
      if (typeof callId === 'string' && callId !== '') void revertDiff(callId);
      else void revertActiveDiff();
    }),
    // keep：保留改动（文件不动），清除该处修改标记
    vscode.commands.registerCommand('dsh.diff.keep', (callId?: string) => {
      if (typeof callId === 'string' && callId !== '') void keepDiff(callId);
      else void keepActiveDiff();
    }),
    vscode.commands.registerCommand('dsh.diff.revertAll', () => void revertAllDiffs()),
    // 清除当前文件的全部 DSH 标记（保留改动）：记录/装饰错位时的一键清理入口
    vscode.commands.registerCommand('dsh.diff.clearMarks', () => void clearMarksForActive()),
    // 编辑器切换时刷新高亮（文件打开/聚焦时把已记录修改标出来）
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ds) ds.refreshFile(ed.document.uri.fsPath);
    }),
    // 编辑器可见集合变化（分屏/切组/新开标签）→ 重建所有可见文件的高亮
    vscode.window.onDidChangeVisibleTextEditors(() => {
      if (ds) ds.refreshVisible();
    }),
    // 文档内容变化（含 DSH 外部写入后 VS Code 重载文件）→ 重建该文件高亮。
    // 必要性：外部写入会替换内存文档内容，先前按旧内容算出的 decoration 区间会失效，
    // 表现为"刚编辑完看不到高亮，切几次标签才出现"。
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (ds && ds.hasRecords(e.document.uri.fsPath)) ds.refreshFile(e.document.uri.fsPath);
    }),
    ds.registerContentProvider(),
    ds.registerHoverProvider(),
    { dispose: () => { ds.dispose(); manager?.dispose(); } },
  );

  // 激活后延迟评估一次桥接状态：degraded 且未静默时弹警告
  scheduleEvaluation();
}

/** 打开面板：聚焦视图（VS Code 自动打开视图所在的侧边栏，左/右皆可） */
async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('dsh.panel.focus');
}

// —— A 组命令 handler ——

/** 在 diff 编辑器里查看当前文件的 DSH 修改对比。 */
async function showDiffForActive(): Promise<void> {
  const s = diffService;
  const ed = vscode.window.activeTextEditor;
  if (!s || !ed) return;
  await s.showDiff(ed.document.uri.fsPath);
}

/** 撤销当前文件最近一条 DSH 修改（后改先撤）。 */
async function revertActiveDiff(): Promise<void> {
  const s = diffService;
  const ed = vscode.window.activeTextEditor;
  if (!s || !ed) return;
  const callId = s.lastCallId(ed.document.uri.fsPath);
  if (callId === undefined) {
    void vscode.window.showInformationMessage('当前文件没有 DSH 修改记录');
    return;
  }
  await revertDiff(callId);
}

/** 撤销指定 callId 的 DSH 修改（hover 按钮入口）。 */
async function revertDiff(callId: string): Promise<void> {
  const s = diffService;
  if (!s) return;
  const r = await s.revert(callId);
  if (r.ok) {
    if (r.deletedFile === true) {
      void vscode.window.showInformationMessage('已删除该文件（可从系统回收站恢复）');
    } else if (r.keptUserPart === true) {
      void vscode.window.showInformationMessage('已丢弃 DSH 写入的内容，你的新增已保留');
    } else {
      void vscode.window.showInformationMessage('已撤销该处 DSH 修改');
    }
  } else if (r.reason === 'cancelled') {
    // 用户在确认弹窗中取消：静默返回
  } else if (r.reason === 'anchor-missing') {
    void vscode.window.showWarningMessage('文件已被改动，该处修改无法撤销');
  } else if (r.reason === 'unknown-tool') {
    void vscode.window.showWarningMessage('无法丢弃：未收到来源工具信息（旧版桥接），请 Reload Window 后重试');
  } else if (r.reason === 'delete-failed') {
    void vscode.window.showWarningMessage('删除文件失败（文件可能被其他程序占用）');
  } else if (r.reason === 'not-found') {
    void vscode.window.showInformationMessage('该处修改记录不存在（可能已保留或撤销）');
  } else {
    void vscode.window.showWarningMessage('撤销失败');
  }
}

/** 保留当前文件最近一条 DSH 修改（清除标记，文件改动保留）。 */
async function keepActiveDiff(): Promise<void> {
  const s = diffService;
  const ed = vscode.window.activeTextEditor;
  if (!s || !ed) return;
  const callId = s.lastCallId(ed.document.uri.fsPath);
  if (callId === undefined) {
    void vscode.window.showInformationMessage('当前文件没有 DSH 修改记录');
    return;
  }
  await keepDiff(callId);
}

/** 保留指定 callId 的 DSH 修改（hover 按钮入口）。 */
async function keepDiff(callId: string): Promise<void> {
  const s = diffService;
  if (!s) return;
  const r = await s.keep(callId);
  if (r.ok) {
    void vscode.window.showInformationMessage('已保留该处修改（不再标记）');
  } else {
    void vscode.window.showInformationMessage('该处修改记录不存在（可能已撤销）');
  }
}

/** 清除当前文件的全部 DSH 标记（保留改动）：记录与装饰错位时的稳妥清理入口。 */
async function clearMarksForActive(): Promise<void> {
  const s = diffService;
  const ed = vscode.window.activeTextEditor;
  if (!s || !ed) return;
  const n = s.clearMarksForFile(ed.document.uri.fsPath);
  void vscode.window.showInformationMessage(
    n > 0 ? `已清除 ${n} 处 DSH 标记（文件内容未改动）` : '当前文件没有 DSH 标记',
  );
}

/** 撤销当前文件的全部 DSH 修改。 */
async function revertAllDiffs(): Promise<void> {
  const s = diffService;
  const ed = vscode.window.activeTextEditor;
  if (!s || !ed) return;
  const n = await s.revertAll(ed.document.uri.fsPath);
  if (n > 0) {
    void vscode.window.showInformationMessage(`已撤销 ${n} 处 DSH 修改`);
  } else {
    void vscode.window.showInformationMessage('没有可撤销的 DSH 修改');
  }
}

/** 在外部浏览器打开 DSH 页面 */
async function openExternal(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(s.url));
}

/** 复制 DSH 页面地址到剪贴板 */
async function copyUrl(): Promise<void> {
  const s = manager?.getSnapshot();
  if (!s || s.state !== 'ready' || !s.url) {
    void vscode.window.showWarningMessage(t('info.notReady'));
    return;
  }
  await vscode.env.clipboard.writeText(s.url);
  void vscode.window.showInformationMessage(t('info.urlCopied', { url: s.url }));
}

/** 复制完整 DSH 日志（含环境信息头）到剪贴板：问题报告的提交内容 */
async function copyLogs(): Promise<void> {
  await vscode.env.clipboard.writeText(logBuffer.join('\n'));
  void vscode.window.showInformationMessage(t('msg.logsCopied'));
}

/** 一次性引导：告知 DSH 面板可通过左侧活动栏与右侧辅助侧边栏的图标打开 */
async function showSecondaryGuideOnce(context: vscode.ExtensionContext): Promise<void> {
  const KEY = 'dsh.secondaryGuideShown';
  if (context.globalState.get(KEY)) return;
  await vscode.window.showInformationMessage(t('guide.secondaryText'), t('guide.gotIt'));
  void context.globalState.update(KEY, true);
}

/** 在辅助侧边栏打开：新版 VS Code（≥1.91）直接聚焦右侧视图；旧版回退聚焦+引导 */
async function openSecondary(context: vscode.ExtensionContext): Promise<void> {
  const cmds = await vscode.commands.getCommands(true);
  // 视图声明在 package.json 里，VS Code 会自动生成 <viewId>.focus 命令；
  // 存在即说明当前版本支持辅助侧边栏容器（≥1.91）
  if (cmds.includes('dsh.panel.secondary.focus')) {
    await vscode.commands.executeCommand('dsh.panel.secondary.focus');
    return;
  }
  // 旧版回退：聚焦辅助侧边栏（命令 ID 因版本而异，取存在者）+ 一次性移动引导
  const focusId = cmds.includes('workbench.action.focusSecondarySideBar')
    ? 'workbench.action.focusSecondarySideBar'
    : 'workbench.action.focusAuxiliaryBar';
  await vscode.commands.executeCommand(focusId);
  await vscode.commands.executeCommand('dsh.panel.focus');
  await showSecondaryGuideOnce(context);
}

/** 配置变更：host/port 变化时自动重启自启服务，退出策略实时生效 */
function onConfigChanged(): void {
  const m = manager;
  if (!m) return;
  const { config } = readConfig();
  void m.reconfigure(toManagerOptions(config));
  m.setExitBehavior(!config.stopOnExit);
}

/** 插件停用：按 stopOnExit 决定是否停止自启服务（只杀插件自启的） */
export async function deactivate(): Promise<void> {
  const config = readConfig().config;
  if (config.stopOnExit) await manager?.stop();
  manager?.dispose();
}
