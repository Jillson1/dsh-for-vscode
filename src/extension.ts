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
import { AgentStatusController, StatusBarController } from './statusbar';
import { resolveWorkspaceRoot } from './workspaceRoot';
import { addFileToDsh, addSelectionToDsh, type AddToDshTargets } from './addToDsh';
import {
  installBridge,
  uninstallBridge,
  createNodeFs,
  type BridgeInstallResult,
} from './bridge/installer';
import { evaluateBridgeStatus, bridgeWarningText } from './bridge/status';
import { ApprovalRouter } from './bridge/approval-router';
import { QuestionRouter, normalizeQuestions } from './bridge/question-router';
import { decideDelivery, deferredLogLine, type InteractionKind } from './bridge/interaction-routing';
import {
  applySessionState,
  turnCompleteMessage,
  IDLE_AGENT_STATE,
  type AgentState,
  type TurnCompleteNotice,
} from './bridge/agent-state';
import { DiffService } from './bridge/diff-service';
import { locateNewText } from './bridge/diff-tracker';
import { ChangeBook, type RevertOutcome } from './bridge/change-book';
import { ChangeNavigator } from './changes/change-navigation';
import { ChangesTreeProvider, type ChangeTreeNode } from './changes/changes-tree';
import {
  normalizeNodes,
  summarizeKept,
  summarizeOutcomes,
  targetsFromNodes,
  type BatchTarget,
} from './changes/batch';
import { ChangeCodeLensProvider } from './changes/change-code-lens';
import { SelectionCodeLensProvider } from './selection/selection-code-lens';
import { CheckpointStore, ledgerRoot, type CheckpointFs } from './checkpoints/checkpoint-store';
import { CheckpointTreeProvider, type CheckpointTreeNode } from './checkpoints/checkpoint-tree';
import {
  CheckpointContentProvider,
  registerCheckpointContent,
  showCheckpointDiff,
} from './checkpoints/checkpoint-content';
import type { CheckpointsReadyMsg } from './panel/html';
import {
  SELECTION_CONTROLLER_ID,
  SELECTION_THREAD_CONTEXT,
  SelectionThreadController,
} from './selection/selection-thread';
import { sendQuickEdit } from './selection/quick-edit';
import { selectionThreadsMuted } from './editorReveal';
import type { SelectionInfo } from './selection/selection-model';
import { revealLineInEditor } from './editorReveal';

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

  // —— F6/F7：上行消息的真实落点 ——
  // sessionState → agent 状态机（状态栏 + 完成通知）；approvalRequest → 审批路由器（模态框代答）；
  // questionRequest → 提问路由器（QuickPick / 计划文档）。changesSync/checkpointsReady 仍是打桩（F9 接管）。
  // 所有事件都进日志，便于排障。
  let agentState: AgentState = IDLE_AGENT_STATE;

  /** F7：本轮完成通知（只在本轮确有变更时才会被调用，见 agent-state.ts） */
  function notifyTurnComplete(notice: TurnCompleteNotice): void {
    void vscode.window
      .showInformationMessage(turnCompleteMessage(notice), t('msg.viewChanges'))
      .then((choice) => {
        if (choice !== undefined) void vscode.commands.executeCommand('dsh.changes.focus');
      });
  }

  /** F7：应用一次会话状态（账本计数作为"本轮改了多少"的基线） */
  function applyState(sessionState: { sessionId: string; running: boolean; turn: number; pending: number }): void {
    const { next, notice } = applySessionState(
      agentState,
      {
        ...sessionState,
        changeCount: changeBook.count(),
        fileCount: changeBook.allPaths().length,
      },
      { notifyOnTurnComplete: readConfig().config.notifyOnTurnComplete },
    );
    agentState = next;
    agentStatus.update(next);
    if (notice !== null) notifyTurnComplete(notice);
  }

  /** F6：审批路由器（模态框文案与安全边界都在 approval-router.ts 的纯逻辑里） */
  const approvalRouter = new ApprovalRouter({
    // showWarningMessage 返回 Thenable，这里用 async 包一层：依赖签名要的是 Promise
    ask: async (prompt, allow, deny) => vscode.window.showWarningMessage(prompt, { modal: true }, allow, deny),
    // 下发给可见面板：左右两个实例都试一次，任一可达即算送达
    send: (message) => panelPrimary.postToPage(message) || panelSecondary.postToPage(message),
    notify: (m) => void vscode.window.showWarningMessage(m),
    log: (m) => appendLog(`[approval] ${m}`),
  });

  // —— F8：提问 / plan-review ——
  // 计划正文开成只读虚拟文档（scheme `dsh-plan`）：容器是内存 Map，内容按需读，不落盘
  const planDocuments = new Map<string, string>();
  let planSeq = 0;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('dsh-plan', {
      provideTextDocumentContent: (uri) => planDocuments.get(uri.toString()) ?? '',
    }),
  );

  /** 打开计划审阅文档（先尝试 Markdown 预览，失败则退化为普通只读编辑器） */
  async function openPlanDocument(title: string, markdown: string): Promise<void> {
    planSeq += 1;
    const uri = vscode.Uri.parse(`dsh-plan://plan/${planSeq}.md`);
    planDocuments.set(uri.toString(), markdown);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    appendLog(`[question] 计划审阅文档：${title}（${markdown.length} 字符）`);
    try {
      // Markdown 预览让计划"读起来像文档"；内置 markdown 扩展被禁用时忽略失败
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      /* 预览不可用：只读编辑器已足够 */
    }
  }

  /** F8：提问路由器（问法与答案形状的规则都在 question-router.ts 的纯逻辑里） */
  const questionRouter = new QuestionRouter({
    pickOne: async (title, options, placeHolder) => {
      const picked = await vscode.window.showQuickPick(
        options.map((o) => (o.description === undefined ? { label: o.label } : { label: o.label, detail: o.description })),
        { title, placeHolder, ignoreFocusOut: true },
      );
      return picked?.label;
    },
    pickMany: async (title, options, placeHolder) => {
      const picked = await vscode.window.showQuickPick(
        options.map((o) => (o.description === undefined ? { label: o.label } : { label: o.label, detail: o.description })),
        { title, placeHolder, canPickMany: true, ignoreFocusOut: true },
      );
      return picked === undefined ? undefined : picked.map((p) => p.label);
    },
    // showInputBox 返回 Thenable：用 async 包一层（依赖签名要的是 Promise）
    input: async (title, placeHolder) => vscode.window.showInputBox({ title, placeHolder, ignoreFocusOut: true }),
    openPlan: openPlanDocument,
    send: (message) => panelPrimary.postToPage(message) || panelSecondary.postToPage(message),
    notify: (m) => void vscode.window.showWarningMessage(m),
    log: (m) => appendLog(`[question] ${m}`),
  });

  /**
   * F6/F8 的投递决策（策略 B，真机反馈后收敛）。
   *
   * 面板可见 = 用户就在 DSH 那边，同一个审批/提问面板上已有原生界面 → 交回面板；
   * 面板隐藏 = 用户在看代码 → 在 IDE 弹，这才是"不切窗口也能应答"的价值。
   */
  function shouldDeferToPanel(kind: InteractionKind): boolean {
    const delivery = decideDelivery({
      kind,
      onlyWhenPanelHidden: readConfig().config.interactionOnlyWhenPanelHidden,
      panelVisible: panelPrimary.isVisible() || panelSecondary.isVisible(),
    });
    if (delivery === 'panel') {
      appendLog(`[${kind}] ${deferredLogLine(kind)}`);
      return true;
    }
    return false;
  }

  /** 上行事件统一入口（注入给两个面板 provider） */
  function onUplinkEvent(event: { name: string; [k: string]: unknown }): void {
    appendLog(`[bridge] event ${event.name} ${JSON.stringify(event)}`);
    if (event.name === 'sessionState') {
      applyState({
        sessionId: String(event.sessionId ?? ''),
        running: event.running === true,
        turn: typeof event.turn === 'number' ? event.turn : 0,
        pending: typeof event.pending === 'number' ? event.pending : 0,
      });
      return;
    }
    if (event.name === 'checkpointsReady') {
      const result = event.event as CheckpointsReadyMsg;
      const resolve = result.requestId === undefined ? undefined : pendingCheckpoints.get(result.requestId);
      if (resolve !== undefined && result.requestId !== undefined) {
        pendingCheckpoints.delete(result.requestId);
        resolve(result);
      } else {
        appendLog('[checkpoint] 收到无对应请求的回执（已忽略）');
      }
      return;
    }
    if (event.name === 'questionRequest') {
      if (shouldDeferToPanel('question')) return; // 面板可见 → 面板上有原生提问界面
      void questionRouter.onRequest({
        sessionId: String(event.sessionId ?? ''),
        questionId: String(event.questionId ?? ''),
        questions: normalizeQuestions(Array.isArray(event.questions) ? (event.questions as unknown[]) : []),
      });
      return;
    }
    if (event.name === 'approvalRequest') {
      if (shouldDeferToPanel('approval')) return; // 面板可见 → 面板上有审批条
      void approvalRouter.onRequest({
        sessionId: String(event.sessionId ?? ''),
        approvalId: String(event.approvalId ?? ''),
        toolName: String(event.toolName ?? ''),
        callId: typeof event.callId === 'string' ? event.callId : undefined,
        reason: typeof event.reason === 'string' ? event.reason : undefined,
      });
    }
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
    updateChangeContext(); // F2：激活时即评估 F8 是否接管当前文件
  }

  // 左右两侧各一个 provider 实例，共享同一 manager（服务状态一致）
  // —— F2 变更导航（F8 / Shift+F8）+ F3 `DSH Changes` 树 ——
  // 状态栏计数项：显示"3/12"，点击等同按 F8（延续"导航状态要有一处可见的进度"）
  const changeCounter = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  changeCounter.command = 'dsh.change.next';

  const changeNavigator = new ChangeNavigator({
    book: changeBook,
    // 适配成导航层的"最小编辑器接口"：只暴露路径与内存文本，
    // 导航逻辑因此完全不依赖 vscode 类型（可用假实现单测）
    activeEditor: () => {
      const ed = vscode.window.activeTextEditor;
      if (ed === undefined) return undefined;
      return { fsPath: ed.document.uri.fsPath, getText: () => ed.document.getText() };
    },
    reveal: (path, line) => revealLineInEditor(path, line).then(() => undefined),
    readFileText: async (p) => {
      const { promises: fs } = await import('node:fs');
      return fs.readFile(p, 'utf8');
    },
    status: (text) => {
      if (text === undefined) {
        changeCounter.hide();
        return;
      }
      changeCounter.text = `$(diff-modified) DSH 变更 ${text}`;
      changeCounter.tooltip = 'DSH 变更导航（点击跳到下一处）';
      changeCounter.show();
    },
    notify: (m) => void vscode.window.showInformationMessage(m),
    log: (m) => appendLog(`[nav] ${m}`),
  });

  const changesTree = new ChangesTreeProvider({
    book: changeBook,
    readFileText: async (p) => {
      const { promises: fs } = await import('node:fs');
      return fs.readFile(p, 'utf8');
    },
    log: (m) => appendLog(`[tree] ${m}`),
  });
  const changesView = vscode.window.createTreeView('dsh.changes', {
    treeDataProvider: changesTree,
    showCollapseAll: true,
    // F4：批量处置要能"框选一片"再右键（命令回落到 treeView.selection，见 normalizeNodes）
    canSelectMany: true,
  });

  // F5：变更行内 CodeLens（保留 / 丢弃 / 对比）——数据源同为账本，账本一变即重算
  const changeLenses = new ChangeCodeLensProvider({
    book: changeBook,
    log: (m) => appendLog(`[lens] ${m}`),
  });

  // F10：选区工具条（CodeLens 版）——划选后在选区首行上方常驻两个可点按钮。
  // 真机反馈：原 comment thread 的按钮由 VS Code 固定渲染在编辑区左侧留白、位置不可控，
  // 而且实际观感上"只有一个按钮"；改由 CodeLens 承载入口，线程继续负责编辑器内输入框。
  /**
   * 最近一次选区变更的**来源**（鼠标 / 键盘 / 命令）。
   *
   * 用它把"用户选的"与"我们跳行时设的"分开 —— VS Code 内部映射已核实：
   * `keyboard → 1`、`mouse → 2`、`api / code.jump / code.navigation → 3(Command)`；
   * 我们的 `editor.selection = …`（revealLineInEditor）走的正是 `api` → Command。
   * 因此工具条只在 Mouse/Keyboard 时出现，点卡片路径跳行不会再冒出来。
   */
  let lastSelectionKind: vscode.TextEditorSelectionChangeKind | undefined;

  const selectionLenses = new SelectionCodeLensProvider({
    activeSelection: () => {
      const ed = vscode.window.activeTextEditor;
      if (ed === undefined) return undefined;
      const sel = ed.selection;
      return {
        fsPath: ed.document.uri.fsPath,
        startLine: sel.start.line,
        isEmpty: sel.isEmpty,
        userInitiated:
          lastSelectionKind === vscode.TextEditorSelectionChangeKind.Mouse ||
          lastSelectionKind === vscode.TextEditorSelectionChangeKind.Keyboard,
      };
    },
    enabled: () => readConfig().config.selectionLensEnabled,
    log: (m) => appendLog(`[lens] ${m}`),
  });

  /**
   * 打开变更所在文件并定位到该处（F3 树点击 / 命令面板）。
   *
   * 定位基准的选择：优先用**已打开文档的内存文本**（用户可能有未保存改动，磁盘内容会偏），
   * 没有打开过才读磁盘。定位失败（newText 已被手改）就只打开文件——不硬跳到第 1 行假装成功。
   */
  async function openChange(node: ChangeTreeNode): Promise<void> {
    if (node.kind !== 'change') return;
    const rec = changeBook.get(node.sessionId, node.view.callId);
    if (rec === undefined) return;
    let content: string | null = null;
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === rec.absPath);
    if (openDoc !== undefined) {
      content = openDoc.getText();
    } else {
      try {
        const { promises: fs } = await import('node:fs');
        content = await fs.readFile(rec.absPath, 'utf8');
      } catch {
        content = null; // 读不到：仅打开文件
      }
    }
    const line = (content === null ? null : locateNewText(content, rec.newText)?.line) ?? 1;
    await revealLineInEditor(rec.absPath, line);
    appendLog(`[change] open ${rec.absPath}:${line} callId=${rec.callId}`);
  }

  /** 保留一处（树/命令面板）：走 DiffService.keep —— 它同时移除栈与账本条目 */
  async function keepChange(node: ChangeTreeNode): Promise<void> {
    if (node.kind !== 'change') return;
    const r = await ds?.keep(node.view.callId);
    appendLog(`[change] keep ${node.view.callId} ok=${r?.ok ?? false}`);
  }

  /** 丢弃一处：账本委托执行（成功才移除记录），失败把原因如实告诉用户 */
  async function revertChange(node: ChangeTreeNode): Promise<void> {
    if (node.kind !== 'change') return;
    const outcome = await changeBook.revert(node.sessionId, node.view.callId);
    appendLog(`[change] revert ${node.view.callId} → ${outcome.status}${outcome.status === 'reverted' ? '' : ` (${outcome.reason})`}`);
    if (outcome.status !== 'reverted') {
      void vscode.window.showWarningMessage(`未能丢弃该处修改：${outcome.status}（${outcome.reason}）`);
    }
  }

  /**
   * 批量保留（F4）：逐条走 DiffService.keep —— 它同时清修改栈与账本，不会出现"账本删了、高亮还在"。
   * 如实报条数：请求 N 条、实际保留 M 条（记录可能已被别处移除）。
   */
  async function batchKeep(targets: readonly BatchTarget[]): Promise<void> {
    changesTree.clearFailed();
    let requested = 0;
    let kept = 0;
    for (const target of targets) {
      for (const rec of recordsOf(target)) {
        requested += 1;
        const r = await ds?.keep(rec.callId);
        if (r?.ok === true) kept += 1;
      }
    }
    const text = summarizeKept(requested, kept);
    appendLog(`[batch] keep → ${text}（目标 ${targets.length} 个）`);
    void vscode.window.showInformationMessage(text);
  }

  /**
   * 批量丢弃（F4）：逐条执行、逐条报告；失败条目在树里标红留痕（方案 §7.4）。
   * 语义要点：**失败的记录留在账本里**（账本只在成功时移除），用户可以看清原因后单独重试。
   */
  async function batchRevert(targets: readonly BatchTarget[]): Promise<void> {
    changesTree.clearFailed();
    const outcomes: RevertOutcome[] = [];
    const failures: { callId: string; reason: string }[] = [];
    for (const target of targets) {
      for (const rec of recordsOf(target)) {
        const outcome = await changeBook.revert(target.sessionId, rec.callId);
        outcomes.push(outcome);
        if (outcome.status !== 'reverted') failures.push({ callId: rec.callId, reason: outcome.reason });
      }
    }
    if (failures.length > 0) changesTree.markFailed(failures);
    const summary = summarizeOutcomes(outcomes);
    appendLog(`[batch] revert → ${summary.text}（目标 ${targets.length} 个）`);
    if (summary.failed > 0) void vscode.window.showWarningMessage(summary.text);
    else if (summary.ok > 0) void vscode.window.showInformationMessage(summary.text);
  }

  /** 批量目标 → 账本记录（会话 / 文件 / 单条三种粒度统一取记录；快照式取出，避免边执行边变） */
  function recordsOf(target: BatchTarget): readonly { callId: string }[] {
    if (target.scope === 'session') return changeBook.records(target.sessionId);
    if (target.scope === 'file') return changeBook.records(target.sessionId, target.absPath);
    const rec = changeBook.get(target.sessionId, target.callId);
    return rec === undefined ? [] : [rec];
  }

  /** 解析命令实参 → 批量目标（树右键多选 / 单选 / 命令面板 / 视图标题四种入口，见 normalizeNodes） */
  function targetsFromArg(arg: unknown): BatchTarget[] {
    return targetsFromNodes(normalizeNodes(arg, changesView.selection));
  }

  /**
   * 维护上下文键 `dsh.hasFileChanges`：F8 / Shift+F8 只在"当前文件确有 DSH 变更"时接管。
   *
   * 为什么要门控：F8 是 VS Code 内置的"下一个问题"（problems / 诊断跳转），无条件抢占会
   * 破坏用户已有的工作流。门控后语义变成"有 DSH 变更时 F8 走变更导航，否则维持原行为"，
   * 这也是贡献点里 `when: editorTextFocus && dsh.hasFileChanges` 的来源。
   */
  function updateChangeContext(): void {
    const ed = vscode.window.activeTextEditor;
    const has = ed !== undefined && changeBook.recordsForPath(ed.document.uri.fsPath).length > 0;
    void vscode.commands.executeCommand('setContext', 'dsh.hasFileChanges', has);
  }

  // F9：DSH 检查点（只读 change-ledger；恢复走同源 /turn-rewind）
  const checkpointFs: CheckpointFs = {
    readdir: async (p) => {
      const { promises: fs } = await import('node:fs');
      try {
        return await fs.readdir(p);
      } catch {
        return []; // 目录不存在 = 账本还没建立，不是错误
      }
    },
    readFile: async (p) => {
      const { promises: fs } = await import('node:fs');
      return fs.readFile(p, 'utf8');
    },
    mtimeMs: async (p) => {
      const { promises: fs } = await import('node:fs');
      try {
        return (await fs.stat(p)).mtimeMs;
      } catch {
        return undefined;
      }
    },
  };
  const checkpointStore = new CheckpointStore({
    root: ledgerRoot(process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    fs: checkpointFs,
    log: (m) => appendLog(`[checkpoint] ${m}`),
  });
  const checkpointContent = new CheckpointContentProvider(checkpointStore);
  const checkpointsTree = new CheckpointTreeProvider({
    store: checkpointStore,
    workspaceRoot: workspaceRootGetter,
    readFileText: async (p) => {
      const { promises: fs } = await import('node:fs');
      return fs.readFile(p, 'utf8');
    },
    log: (m) => appendLog(`[checkpoint] ${m}`),
  });
  const checkpointsView = vscode.window.createTreeView('dsh.checkpoints', {
    treeDataProvider: checkpointsTree,
    showCollapseAll: true,
  });

  // 预览 / 应用是跨进程一问一答：用 requestId 配对，超时即失败（破坏性动作不自动重试）
  const pendingCheckpoints = new Map<string, (result: CheckpointsReadyMsg) => void>();
  let checkpointSeq = 0;

  async function checkpointCall(
    phase: 'preview' | 'apply',
    params: {
      sessionId: string;
      messageSeq: number;
      checkpointId: string;
      mode: 'code' | 'both';
      planId?: string;
      confirmation?: string;
    },
    timeoutMs = 20000,
  ): Promise<CheckpointsReadyMsg | null> {
    checkpointSeq += 1;
    const requestId = `cp-${checkpointSeq}`;
    const wait = new Promise<CheckpointsReadyMsg | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingCheckpoints.delete(requestId);
        appendLog(`[checkpoint] ${phase} 超时未收到回执（requestId=${requestId}）`);
        resolve(null);
      }, timeoutMs);
      pendingCheckpoints.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    const message = { type: 'bridgeCheckpointRestore' as const, phase, requestId, ...params };
    const sent = panelPrimary.postToPage(message) || panelSecondary.postToPage(message);
    if (!sent) {
      pendingCheckpoints.delete(requestId);
      void vscode.window.showWarningMessage('DSH 面板当前不可见，无法执行恢复；请先打开 DSH 面板');
      return null;
    }
    return wait;
  }

  /** 对比：检查点快照 ↔ 当前文件（原生 diff） */
  async function diffCheckpoint(node: CheckpointTreeNode): Promise<void> {
    if (node.kind !== 'drift') return;
    if (node.drift.blob === undefined) {
      void vscode.window.showWarningMessage('该条目没有内容快照（可能是目录或特殊文件），无法对比');
      return;
    }
    await showCheckpointDiff(
      checkpointContent,
      node.checkpoint,
      node.workspaceHash,
      node.drift.path,
      node.absPath,
      node.drift.blob,
    );
  }

  /**
   * 恢复此轮（两步：先预览拿 planId/confirmation，再确认后应用）。
   *
   * 为什么必须两步：引擎拒绝"没先给过计划"的恢复（POST 无 planId 会以 NO_CHANGES 拒绝）——
   * 也就是"先看得到要改什么"是引擎强制的，扩展只是顺着它走并补一次模态确认。
   */
  async function restoreCheckpoint(node: CheckpointTreeNode): Promise<void> {
    if (node.kind !== 'checkpoint') return;
    const cp = node.checkpoint;
    if (cp.sessionId === undefined || cp.turnStartSeq === undefined) {
      void vscode.window.showWarningMessage('该检查点没有记录会话/轮次起点，无法恢复（可用 diff 查看内容）');
      return;
    }
    const preview = await checkpointCall('preview', {
      sessionId: cp.sessionId,
      messageSeq: cp.turnStartSeq,
      checkpointId: cp.id,
      mode: 'code',
    });
    if (preview === null) return;
    if (!preview.ok) {
      appendLog(`[checkpoint] 预览失败 code=${preview.code ?? '-'} error=${preview.error ?? '-'}`);
      void vscode.window.showWarningMessage(
        `无法恢复：${preview.error ?? '未知原因'}${preview.code === undefined ? '' : `（${preview.code}）`}`,
      );
      return;
    }
    if (preview.restoreBlocked === true) {
      void vscode.window.showWarningMessage('该工作区有其他活跃会话在用同一份文件，暂不能恢复；请先关闭那些会话');
      return;
    }
    if (preview.planId === undefined || preview.confirmation === undefined) {
      void vscode.window.showWarningMessage('该轮没有需要恢复的项目文件（引擎未给出恢复计划）');
      return;
    }
    const count = preview.totalChanges ?? 0;
    const listed = preview.changes ?? [];
    const sample = listed.slice(0, 8).map((c) => `  · ${c.path}（${c.kind}）`).join('\n');
    const more = listed.length > 8 ? `\n  … 另有 ${listed.length - 8} 个` : '';
    const CONFIRM = '恢复本轮之前的代码';
    const choice = await vscode.window.showWarningMessage(
      `将把 ${count} 个文件恢复到该轮开始之前（只回滚代码，不动会话）：
${sample}${more}`,
      { modal: true },
      CONFIRM,
    );
    if (choice !== CONFIRM) {
      appendLog('[checkpoint] 用户取消恢复');
      return;
    }
    const applied = await checkpointCall('apply', {
      sessionId: cp.sessionId,
      messageSeq: cp.turnStartSeq,
      checkpointId: cp.id,
      mode: 'code',
      planId: preview.planId,
      confirmation: preview.confirmation,
    });
    if (applied === null) return;
    if (!applied.ok) {
      appendLog(`[checkpoint] 恢复失败 code=${applied.code ?? '-'} error=${applied.error ?? '-'}`);
      void vscode.window.showWarningMessage(
        `恢复失败：${applied.error ?? '未知原因'}${applied.code === undefined ? '' : `（${applied.code}）`}`,
      );
      return;
    }
    appendLog(`[checkpoint] 恢复完成 checkpoint=${cp.id}`);
    void vscode.window.showInformationMessage(`已恢复 ${count} 个文件到该轮之前`);
    checkpointsTree.refresh();
  }

  // —— F10/F11：选区工具条（Comments 内联线程）+ Quick Edit ——
  // VS Code 没有"选区悬浮工具条"API（探索文档 §8.5 实测：inline chat 不可接管），
  // Comments 线程是能做到的最接近形态：锚定选区 + 标题按钮 + 可回复的输入框。
  const selectionController = vscode.comments.createCommentController(SELECTION_CONTROLLER_ID, 'DSH');

  /** 当前选区信息（命令与线程回复共用同一口径） */
  function currentSelection(): SelectionInfo | null {
    const ed = vscode.window.activeTextEditor;
    return ed === undefined ? null : selectionThreads.infoOf(ed);
  }

  /** F11：把指令发给 DSH 当前会话（确认策略与失败提示都在 quick-edit.ts 里） */
  async function runQuickEdit(info: SelectionInfo, instruction: string): Promise<void> {
    const result = await sendQuickEdit(info, instruction, {
      confirmBeforeSend: () => readConfig().config.quickEditConfirmBeforeSend,
      confirm: async (text) => {
        const SEND = '发送';
        const NEVER = '发送并不再询问';
        const choice = await vscode.window.showWarningMessage(text, { modal: true }, SEND, NEVER);
        if (choice === NEVER) {
          // "不再询问"写回设置：用户明确表达了偏好，就不该每轮再问
          await vscode.workspace
            .getConfiguration('dsh')
            .update('quickEdit.confirmBeforeSend', false, vscode.ConfigurationTarget.Global);
          return true;
        }
        return choice === SEND;
      },
      send: (message) => panelPrimary.postToPage(message) || panelSecondary.postToPage(message),
      notify: (m) => void vscode.window.showInformationMessage(m),
      log: (m) => appendLog(`[quickEdit] ${m}`),
    });
    if (result === 'sent') selectionThreads.clear();
  }

  /** 选区线程控制器（防抖 / 复用 / 单线程清理都在类里） */
  const selectionThreads = new SelectionThreadController({
    activeEditor: () => vscode.window.activeTextEditor,
    uri: (path) => vscode.Uri.file(path),
    range: (startLine0, endLine0) => new vscode.Range(startLine0, 0, endLine0, 0),
    markdown: (text) => {
      const md = new vscode.MarkdownString(text)
      md.supportThemeIcons = true
      return md;
    },
    createThread: (uri, range, body) => {
      const thread = selectionController.createCommentThread(uri, range, [
        { body, author: { name: 'DSH' }, mode: vscode.CommentMode.Preview },
      ]);
      thread.canReply = true; // 回复框就是"编辑器内的 Quick Edit 输入框"
      // **默认收起**：标题行（含两个按钮）可见，输入框要用户点开才出现。
      // 这是真机反馈的直接修正：选完就弹输入框太打扰，而且原生 widget 的宽度不受我们控制。
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.contextValue = SELECTION_THREAD_CONTEXT; // 供 comments/commentThread/title 的 when 匹配
      thread.label = 'DSH';
      return thread;
    },
    disposeThread: (thread) => (thread as vscode.CommentThread).dispose(),
    enabled: () => readConfig().config.selectionThreadsEnabled,
    // 跳行定位等程序化选区要静音：否则每次点击卡片路径都会冒出一个评论线程（真机反馈缺陷）
    suppressed: () => selectionThreadsMuted(),
    log: (m) => appendLog(`[selection] ${m}`),
  });

  // 线程回复 = Quick Edit 指令。
  // 注意（实测纠正探索文档的一条结论）：Comments API **没有** `onDidSubmitCommentReply` 事件——
  // `vscode.CommentReply` 是 `comments/commentThread/context` 菜单命令的**实参**，
  // 也就是"线程输入框旁的那个动作按钮"点下去时把 { thread, text } 交给我们的命令。
  // 因此回复走命令（`dsh.selection.submitReply`），而"回车即发"由 Alt+K 的 InputBox 提供。
  function onSubmitReply(reply: vscode.CommentReply): void {
    const info = currentSelection();
    const text = typeof reply.text === 'string' ? reply.text : '';
    appendLog(`[quickEdit] 线程回复提交（${text.length} 字符）`);
    if (info === null) {
      void vscode.window.showInformationMessage('选区已失效，请重新选中要修改的代码');
      return;
    }
    void runQuickEdit(info, text);
  }

  // 选区变化：挂线程（防抖）；编辑器切换：清线程（避免线程挂在不相关的文件上）
  // 同时刷新选区工具条（CodeLens）：选区一变就让 VS Code 重取那两个按钮。
  // 防抖理由与线程一致：拖选过程中选区事件每秒触发几十次，逐次重算会让按钮行抖动。
  let lensTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshSelectionLens = (): void => {
    if (lensTimer !== undefined) clearTimeout(lensTimer);
    lensTimer = setTimeout(() => {
      lensTimer = undefined;
      selectionLenses.refresh();
    }, 120);
  };
  const selectionSubscription = vscode.window.onDidChangeTextEditorSelection((e) => {
    // 记录来源：工具条据此区分"用户选的"与"我们跳行设的"（后者不出工具条）
    lastSelectionKind = e.kind;
    selectionThreads.onSelectionChanged();
    refreshSelectionLens();
  });
  /** 切换活动编辑器：离散事件，立即重算（旧编辑器的按钮不该留在新文件上） */
  const activeEditorForLens = vscode.window.onDidChangeActiveTextEditor(() => selectionLenses.refresh());

  /** Alt+K / 命令面板：Ask 一次指令再发送（不依赖线程是否可见） */
  async function quickEditFromInput(): Promise<void> {
    const info = currentSelection();
    if (info === null) {
      void vscode.window.showInformationMessage('请先选中要修改的代码');
      return;
    }
    const instruction = await vscode.window.showInputBox({
      title: `Quick Edit · ${info.pathRef}`,
      placeHolder: '对这段代码做什么修改？（回车发送）',
      ignoreFocusOut: true,
    });
    if (instruction === undefined) return;
    await runQuickEdit(info, instruction);
  }

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
    onUplinkEvent, // F6/F7：上行事件落点（sessionState / approvalRequest 已接管）
  );
  const panelSecondary = new DshPanelProvider(
    manager,
    onPanelFirstOpen, // 辅助侧边栏首次打开同样触发握手超时
    onBridgeAck,
    workspaceRootGetter,
    bridgeEnabledGetter,
    diffService,
    onUplinkEvent,
  );
  new StatusBarController(manager);
  // F7：agent 状态项（与"服务状态"分开：一个是进程活着，一个是 agent 在干什么）
  const agentStatus = new AgentStatusController();

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
    // —— F2 变更导航 ——
    vscode.commands.registerCommand('dsh.change.next', () => void changeNavigator.next()),
    vscode.commands.registerCommand('dsh.change.prev', () => void changeNavigator.prev()),
    // —— F3 `DSH Changes` 树 ——
    vscode.commands.registerCommand('dsh.changes.refresh', () => changesTree.refresh()),
    vscode.commands.registerCommand('dsh.change.open', (node?: ChangeTreeNode) =>
      node === undefined ? undefined : void openChange(node),
    ),
    vscode.commands.registerCommand('dsh.change.keep', (node?: ChangeTreeNode) =>
      node === undefined ? undefined : void keepChange(node),
    ),
    vscode.commands.registerCommand('dsh.change.revert', (node?: ChangeTreeNode) =>
      node === undefined ? undefined : void revertChange(node),
    ),
    // —— F4 批量处置：三种粒度（会话 / 文件 / 单条），实参归一后走同一套批量逻辑 ——
    vscode.commands.registerCommand('dsh.file.keepAll', (node?: unknown) => void batchKeep(targetsFromArg(node))),
    vscode.commands.registerCommand('dsh.file.revertAll', (node?: unknown) => void batchRevert(targetsFromArg(node))),
    vscode.commands.registerCommand('dsh.session.keepAll', (node?: unknown) => void batchKeep(targetsFromArg(node))),
    vscode.commands.registerCommand('dsh.session.revertAll', (node?: unknown) => void batchRevert(targetsFromArg(node))),
    // 编辑器级（命令面板："保留当前文件全部修改"）：按**路径**取记录，跨会话都算——
    // 与 F2 导航同一口径（用户在意的是"这个文件"，不是"哪个会话碰过它"）
    vscode.commands.registerCommand('dsh.diff.keepAll', () => {
      const ed = vscode.window.activeTextEditor;
      if (ed === undefined) {
        void vscode.window.showInformationMessage('请先打开一个文件，再执行"保留当前文件全部修改"');
        return;
      }
      const targets: BatchTarget[] = changeBook.recordsForPath(ed.document.uri.fsPath).map((r) => ({
        scope: 'change',
        sessionId: r.sessionId,
        callId: r.callId,
        absPath: r.absPath,
      }));
      void batchKeep(targets);
    }),
    // F5：CodeLens provider 与其生命周期
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, changeLenses),
    changeLenses,
    // F10：选区工具条（CodeLens 版）
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, selectionLenses),
    selectionLenses,
    activeEditorForLens,
    // —— F10/F11：选区工具条与 Quick Edit ——
    selectionSubscription,
    selectionController,
    selectionThreads,
    vscode.commands.registerCommand('dsh.quickEdit.selection', () => void quickEditFromInput()),
    // 线程标题上的「Quick Edit」：展开该线程 → 回复框（编辑器内输入框）出现，
    // 用户在框里写指令后点「发送到 DSH」。没有线程时（例如被手动关掉）退化为 Alt+K 的 InputBox。
    vscode.commands.registerCommand('dsh.selection.quickEdit', () => {
      const thread = selectionThreads.currentThread() as vscode.CommentThread | undefined;
      if (thread === undefined) {
        void quickEditFromInput();
        return;
      }
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      appendLog('[selection] Quick Edit：已展开线程输入框');
    }),
    // 与既有 dsh.addSelectionToDsh 同一个实现（Comments 线程标题按钮用它）
    vscode.commands.registerCommand('dsh.selection.addToDsh', () =>
      void addSelectionToDsh({ providers: [panelPrimary, panelSecondary] }),
    ),
    vscode.commands.registerCommand('dsh.selection.submitReply', (reply?: vscode.CommentReply) =>
      reply === undefined ? undefined : onSubmitReply(reply),
    ),
    // —— F9 检查点：视图 / 内容提供者 / 命令 ——
    checkpointsView,
    checkpointsTree,
    registerCheckpointContent(checkpointContent),
    checkpointContent,
    vscode.commands.registerCommand('dsh.checkpoints.refresh', () => checkpointsTree.refresh()),
    vscode.commands.registerCommand('dsh.checkpoint.diff', (node?: CheckpointTreeNode) =>
      node === undefined ? undefined : void diffCheckpoint(node),
    ),
    vscode.commands.registerCommand('dsh.checkpoint.restore', (node?: CheckpointTreeNode) =>
      node === undefined ? undefined : void restoreCheckpoint(node),
    ),
    changesView,
    changeCounter,
    changesTree,
    agentStatus,
    // 账本变化（新增/保留/丢弃）→ 重新评估 F8 是否接管当前文件
    changeBook.onChange(() => updateChangeContext()),
    // 编辑器切换时刷新高亮（文件打开/聚焦时把已记录修改标出来）
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ds) ds.refreshFile(ed.document.uri.fsPath);
      updateChangeContext(); // 换文件 → 重新评估 F8 是否应接管
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
