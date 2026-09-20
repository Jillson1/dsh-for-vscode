// src/panel/html.ts — 面板占位页模板（纯函数、无逻辑、不依赖 vscode）
import type { MsgKey } from '../i18n';

/** 翻译函数签名（把 i18n.t 传入模板） */
export type T = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** 面板内按钮发回扩展的消息类型（含桥接跳转、握手回执与交互增强上行消息） */
export type PanelMessage =
  | { type: 'retry' }
  | { type: 'reconnect' }
  | { type: 'openExternal' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'copyUrl' }
  | { type: 'showLogs' }
  | { type: 'bridgeOpenExternal'; url: string }
  | { type: 'bridgeOpenFile'; path: string; cwd?: string; line?: number; oldText?: string; newText?: string }
  | { type: 'bridgeDiffApplied'; path: string; cwd?: string; diffs: { oldText: string; newText: string }[]; callId: string; tool?: string; source?: 'relay' | 'replay'; sessionId?: string; turn?: number }
  | { type: 'bridgeCopyText'; text: string; requestId: string }
  | { type: 'bridgeReadText'; requestId: string }
  | { type: 'bridgeReadTextAck'; requestId: string; ok: boolean; text?: string }
  | { type: 'bridgeInjectComposer'; text: string }
  | { type: 'bridgeAck'; ok: boolean; capabilities?: string[] }
  /** DSH ≥0.1.2 登录引导页提交的启动网址（扩展负责校验与兑换，页面内不做任何逻辑） */
  | { type: 'authSubmitLaunchUrl'; url: string }
  // —— 交互增强（bridge 0.4.0）上行消息 ——
  | ({ type: 'bridgeSessionState' } & SessionStateMsg)
  | { type: 'bridgeApprovalRequest'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'bridgeQuestionRequest'; sessionId: string; questionId: string; questions: unknown[] }
  | { type: 'bridgeChangesSync'; sessionId: string; records: unknown[] }
  | ({ type: 'bridgeCheckpointsReady' } & CheckpointsReadyMsg);

/**
 * F7 会话状态（插件上报的 agent 运行态）。
 * 单独导出形状的原因：它是"消息 + 状态机输入"共用的数据类型，
 * 两处各自内联会让字段名一改就静默不同步（agent-state.ts 直接复用它）。
 */
export interface SessionStateMsg {
  readonly sessionId: string
  readonly running: boolean
  readonly turn: number
  readonly pending: number
}

/**
 * F9 检查点回执（预览 / 恢复两相共用）。
 * 单独导出形状的原因与 SessionStateMsg 相同：消息与状态机输入共用同一类型。
 */
export interface CheckpointsReadyMsg {
  readonly phase: 'preview' | 'apply'
  readonly ok: boolean
  /** 扩展侧请求 id（配对请求与回执） */
  readonly requestId?: string
  readonly sessionId?: string
  readonly error?: string
  readonly code?: string
  readonly turn?: number
  readonly totalChanges?: number
  readonly changes?: readonly { readonly path: string; readonly kind: string }[]
  readonly truncated?: boolean
  readonly restoreBlocked?: boolean
  readonly headChanged?: boolean
  readonly operationChanged?: boolean
  readonly planId?: string
  readonly confirmation?: string
}

/**
 * 扩展 → 页面（下行）消息类型（bridge 0.4.0）。
 * 由 provider.postToPage 投递到顶层 webview，握手脚本按 type 翻译成桥接 kind 转给 iframe，
 * 桥接再校验并加 `dsh-file-jump:` 前缀交给插件。T0 定义形状，调用方在 F6/F8/F11 接入。
 */
export type PanelDownlink =
  | { type: 'bridgeInjectComposer'; text: string }
  | { type: 'bridgeQuickEditSubmit'; path: string; startLine: number; endLine: number; instruction: string }
  | { type: 'bridgeApprovalDecision'; sessionId: string; approvalId: string; outcome: 'allowed-once' | 'rejected' }
  | { type: 'bridgeQuestionAnswer'; sessionId: string; questionId: string; answer: unknown }
  | { type: 'bridgeRequestChanges'; sessionId: string }
  // F9：检查点预览 / 恢复（两相共用；apply 需带 preview 拿到的 planId + confirmation）
  | {
      type: 'bridgeCheckpointRestore'
      phase: 'preview' | 'apply'
      sessionId: string
      messageSeq: number
      checkpointId: string
      mode: 'code' | 'both'
      requestId: string
      planId?: string
      confirmation?: string
    };

/** 渲染上下文 */
export interface PageCtx {
  /** 内联脚本的 CSP nonce */
  nonce: string;
  /** webview.cspSource（本地资源来源） */
  cspSource: string;
  /** 允许加载 iframe 的目标地址（DSH 服务地址） */
  frameHosts: string[];
}

/** CSP：最小权限——只放行目标 iframe 与带 nonce 的内联脚本 */
function csp(ctx: PageCtx): string {
  return [
    "default-src 'none'",
    `frame-src ${ctx.frameHosts.join(' ')}`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${ctx.nonce}'`,
    `img-src ${ctx.cspSource} data:`,
  ].join('; ');
}

/** 通用样式（使用 VS Code 主题变量，自动适配浅色/深色主题） */
const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
body.frame-body { display: block; }
.center { text-align: center; max-width: 90%; }
p { margin: 8px 0 16px; opacity: 0.9; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; margin: 4px; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
.spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; margin: 0 auto 12px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
iframe.frame { position: fixed; inset: 0; width: 100%; height: 100%; border: none; }
/* DSH ≥0.1.2 登录引导页 */
.auth-box { text-align: left; max-width: 92%; }
.auth-step { opacity: 0.85; font-size: 12px; margin: 6px 0; }
.auth-input { width: 100%; box-sizing: border-box; margin: 6px 0; padding: 5px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font-family: var(--vscode-font-family); }
.auth-hint { opacity: 0.7; font-size: 11px; margin: 4px 0 10px; }
`;

/** 按钮点击 → postMessage 的内联脚本（nonce 放行） */
const BUTTON_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  vscode.postMessage({ type: btn.dataset.action });
});
`;

/**
 * 桥接握手脚本（内联，nonce 放行，紧随 BUTTON_SCRIPT 之后、共用其声明的 vscode）。
 * 职责：
 *  - 上行：向 iframe 下发 { kind:'bridgeHello', token } 握手消息，接收其 bridgeAck 回执，
 *    并把 iframe 上行消息（openExternal / openFile / copyText）转发给扩展侧处理；
 *  - 下行：把扩展侧的剪贴板回执 { type:'bridgeCopyTextAck' } 转发回 iframe，
 *    供 DSH 页面内的 writeText Promise 收尾（VS Code 会拦截跨源 iframe 的原生剪贴板 API）。
 * 安全约束：上行仅接收「目标 origin」且「source 为 iframe 内容窗口」的消息，防止其它站点伪造。
 * @param token 握手防伪凭据（与桥接侧 isBridgeMessage 校验的一致）
 * @param allowedOrigin 允许的消息来源 origin（由 DSH 页面地址推导，如 http://127.0.0.1:3080）
 */
function bridgeHandshakeScript(token: string, allowedOrigin: string): string {
  return `
// dsh-bridge-handshake：DSH 页面桥接握手与消息路由（上行转发 + 剪贴板回执下行转发）
const iframeEl = document.getElementById('dsh-frame');
if (iframeEl) {
  // 握手 token 与允许的 DSH 页面 origin
  const TOKEN = ${JSON.stringify(token)};
  // 注意：ALLOWED_ORIGIN 由 provider 传入的**最终 iframe 地址**推导（DSH ≥0.1.2 鉴权下即
  // 本地代办代理的 origin，而非 DSH 真实地址）——改 iframe 源时必须同步，否则上行全被拒。
  const ALLOWED_ORIGIN = ${JSON.stringify(allowedOrigin)};
  let bridgeAcked = false;
  /**
   * 判定上行消息来源是否可信。不能只做 ALLOWED_ORIGIN 严格相等：
   * webview 的 service worker 可能重写 iframe 的回流 origin（remote 实测回流为
   * vscode-webview://<uuid>，此时 postMessage 用 src 推导的 origin 作 targetOrigin 会直接抛错），
   * 且 127.0.0.1 与 localhost 是同一服务的等价写法。
   * 接收窗口已由 iframeEl.contentWindow 锁定，hello 自带 token 防伪，故这里放行等价来源。
   */
  function isAllowedBridgeOrigin(o) {
    if (typeof o !== 'string') return false;
    if (o === ALLOWED_ORIGIN) return true;
    // webview SW 重写后的载体 origin（source 已限定为本 iframe，可接受）
    if (o.startsWith('vscode-webview://')) return true;
    // 127.0.0.1 / localhost / ::1 同端口互换（代办代理/隧道/WSL 场景 host 可能被替换）
    try {
      const a = new URL(ALLOWED_ORIGIN);
      const b = new URL(o);
      const loopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
      return loopback(a.hostname) && loopback(b.hostname) && a.port === b.port;
    } catch {
      return false;
    }
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    // —— 下行：扩展宿主回执（vscode.webview.postMessage 投递），转发给 iframe ——
    if (d && d.type === 'bridgeCopyTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'copyTextAck', requestId: d.requestId, ok: d.ok }, '*');
      return;
    }
    // 剪贴板读取回执：转发给 iframe，供其 resolve 粘贴兜底的 readText Promise
    if (d && d.type === 'bridgeReadTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'readTextAck',
        requestId: d.requestId,
        ok: d.ok,
        text: typeof d.text === 'string' ? d.text : undefined,
      }, '*');
      return;
    }
    // 下行：扩展把文件引用注入 DSH composer（右键 "Add to DSH"）→ 转发给 iframe
    // 由 bridge client 再转给 dsh-file-jump 插件写输入框草稿。
    if (d && d.type === 'bridgeInjectComposer' && typeof d.text === 'string') {
      iframeEl.contentWindow.postMessage({ kind: 'injectComposer', text: d.text }, '*');
      return;
    }
    // —— 下行（bridge 0.4.0）：交互增强新消息 → 转发给 iframe ——
    // 由 bridge client 用 core.js 的 parse* 校验、加 \`dsh-file-jump:\` 前缀后交给插件。
    if (d && d.type === 'bridgeQuickEditSubmit' && typeof d.path === 'string') {
      iframeEl.contentWindow.postMessage({
        kind: 'quickEditSubmit',
        path: d.path,
        startLine: d.startLine,
        endLine: d.endLine,
        instruction: d.instruction,
      }, '*');
      return;
    }
    if (d && d.type === 'bridgeApprovalDecision' && typeof d.sessionId === 'string' && typeof d.approvalId === 'string') {
      iframeEl.contentWindow.postMessage({
        kind: 'approvalDecision',
        sessionId: d.sessionId,
        approvalId: d.approvalId,
        outcome: d.outcome,
      }, '*');
      return;
    }
    if (d && d.type === 'bridgeQuestionAnswer' && typeof d.sessionId === 'string' && typeof d.questionId === 'string') {
      iframeEl.contentWindow.postMessage({
        kind: 'questionAnswer',
        sessionId: d.sessionId,
        questionId: d.questionId,
        answer: d.answer,
      }, '*');
      return;
    }
    if (d && d.type === 'bridgeCheckpointRestore' && typeof d.sessionId === 'string' && typeof d.checkpointId === 'string') {
      iframeEl.contentWindow.postMessage({
        kind: 'checkpointRestore',
        phase: d.phase,
        sessionId: d.sessionId,
        messageSeq: d.messageSeq,
        checkpointId: d.checkpointId,
        mode: d.mode,
        requestId: d.requestId,
        planId: d.planId,
        confirmation: d.confirmation,
      }, '*');
      return;
    }
    if (d && d.type === 'bridgeRequestChanges' && typeof d.sessionId === 'string') {
      iframeEl.contentWindow.postMessage({ kind: 'requestChanges', sessionId: d.sessionId }, '*');
      return;
    }
    // —— 上行：iframe 发来的消息，source + 来源校验 ——
    if (e.source !== iframeEl.contentWindow || !isAllowedBridgeOrigin(e.origin)) return;
    // 握手回执：统一形状 { kind:'bridgeAck', ok }（不带 token 字段），只读 ok
    if (d && d.kind === 'bridgeAck') {
      bridgeAcked = true;
      // capabilities（0.4.0）：桥接能力表，扩展据此门控命令显隐（旧桥接不带此字段 → undefined）
      const caps = Array.isArray(d.capabilities)
        ? d.capabilities.filter(function (c) { return typeof c === 'string'; })
        : undefined;
      vscode.postMessage({ type: 'bridgeAck', ok: d.ok === true, capabilities: caps });
      return;
    }
    // 打开外链：转发给扩展 → vscode.env.openExternal
    if (d && d.kind === 'openExternal' && typeof d.url === 'string') { vscode.postMessage({ type: 'bridgeOpenExternal', url: d.url }); return; }
    // 打开文件：转发给扩展 → showTextDocument（携带可选 cwd / line / oldText）
    // line 用于 read 场景的 offset 直传；oldText 用于 edit 场景，扩展读文件定位起始行。
    if (d && d.kind === 'openFile' && typeof d.path === 'string') {
      vscode.postMessage({
        type: 'bridgeOpenFile',
        path: d.path,
        cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
        line: typeof d.line === 'number' && Number.isFinite(d.line) ? d.line : undefined,
        oldText: typeof d.oldText === 'string' && d.oldText !== '' ? d.oldText : undefined,
        newText: typeof d.newText === 'string' && d.newText !== '' ? d.newText : undefined,
      });
      return;
    }
    // diff 已应用（A 组）：转发给扩展 → 编辑区高亮修改行 + 记入撤销栈。
    // payload 来自 dsh-file-jump 插件广播、桥接转发的 applied hunks。
    if (d && d.kind === 'diffApplied' && typeof d.path === 'string') {
      vscode.postMessage({
        type: 'bridgeDiffApplied',
        path: d.path,
        cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
        diffs: Array.isArray(d.diffs)
          ? d.diffs.filter(
              (h) => h && typeof h.oldText === 'string' && typeof h.newText === 'string',
            )
          : [],
        callId: typeof d.callId === 'string' ? d.callId : '',
        tool: typeof d.tool === 'string' ? d.tool : undefined,
        // F1 变更账本：来源（relay 实时 / replay 回放）、会话 id、轮次
        source: d.source === 'relay' || d.source === 'replay' ? d.source : undefined,
        sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
        turn: typeof d.turn === 'number' && Number.isFinite(d.turn) ? d.turn : undefined,
      });
      return;
    }
    // —— 交互增强（bridge 0.4.0）上行：会话状态 / 审批 / 提问 / 变更同步 / 检查点回执 ——
    // 形状已由桥接 core.js 的白名单构造器保证；此处只做最必要的字段校验（纵深防御），
    // 缺字段的消息直接丢弃，不让半成品数据进扩展。
    if (d && d.kind === 'sessionState' && typeof d.sessionId === 'string') {
      vscode.postMessage({
        type: 'bridgeSessionState',
        sessionId: d.sessionId,
        running: d.running === true,
        turn: typeof d.turn === 'number' ? d.turn : 0,
        pending: typeof d.pending === 'number' ? d.pending : 0,
      });
      return;
    }
    if (d && d.kind === 'approvalRequest' && typeof d.sessionId === 'string' && typeof d.approvalId === 'string' && typeof d.toolName === 'string') {
      vscode.postMessage({
        type: 'bridgeApprovalRequest',
        sessionId: d.sessionId,
        approvalId: d.approvalId,
        toolName: d.toolName,
        callId: typeof d.callId === 'string' ? d.callId : undefined,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
      });
      return;
    }
    if (d && d.kind === 'questionRequest' && typeof d.sessionId === 'string' && typeof d.questionId === 'string') {
      vscode.postMessage({
        type: 'bridgeQuestionRequest',
        sessionId: d.sessionId,
        questionId: d.questionId,
        questions: Array.isArray(d.questions) ? d.questions : [],
      });
      return;
    }
    if (d && d.kind === 'changesSync' && typeof d.sessionId === 'string') {
      vscode.postMessage({
        type: 'bridgeChangesSync',
        sessionId: d.sessionId,
        records: Array.isArray(d.records) ? d.records : [],
      });
      return;
    }
    if (d && d.kind === 'checkpointsReady' && typeof d.ok === 'boolean' && (d.phase === 'preview' || d.phase === 'apply')) {
      vscode.postMessage({
        type: 'bridgeCheckpointsReady',
        phase: d.phase,
        ok: d.ok,
        requestId: typeof d.requestId === 'string' ? d.requestId : undefined,
        sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
        error: typeof d.error === 'string' ? d.error : undefined,
        code: typeof d.code === 'string' ? d.code : undefined,
        turn: typeof d.turn === 'number' ? d.turn : undefined,
        totalChanges: typeof d.totalChanges === 'number' ? d.totalChanges : undefined,
        changes: Array.isArray(d.changes) ? d.changes : undefined,
        truncated: typeof d.truncated === 'boolean' ? d.truncated : undefined,
        restoreBlocked: typeof d.restoreBlocked === 'boolean' ? d.restoreBlocked : undefined,
        headChanged: typeof d.headChanged === 'boolean' ? d.headChanged : undefined,
        operationChanged: typeof d.operationChanged === 'boolean' ? d.operationChanged : undefined,
        planId: typeof d.planId === 'string' ? d.planId : undefined,
        confirmation: typeof d.confirmation === 'string' ? d.confirmation : undefined,
      });
      return;
    }
    // 复制文本：转发给扩展 → vscode.env.clipboard.writeText（跨源 iframe 原生剪贴板 API 被 VS Code 拦截）
    if (d && d.kind === 'copyText' && typeof d.text === 'string' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeCopyText', text: d.text, requestId: d.requestId });
      return;
    }
    // 读取剪贴板：转发给扩展 → vscode.env.clipboard.readText（Cmd+V 粘贴兜底）
    if (d && d.kind === 'readText' && typeof d.requestId === 'string') {
      vscode.postMessage({ type: 'bridgeReadText', requestId: d.requestId });
    }
  });
  // 下发握手消息（携带 token）。**不挂在 iframe 的 load 事件上**：本机直连时 iframe
  // 毫秒级完成加载，而本脚本在 body 尾部才注册监听——事件早已错过，hello 循环永不启动
  // （上游 issue #13-4 实测）。改为脚本执行即启动；DSH 的 client 插件 factory 可能在页面
  // 加载后才 materialize（实测 1.5~3s），故收到 bridgeAck 前每 250ms 重发一次，最长 15 秒
  // （覆盖慢启动/远程场景；扩展侧握手超时同步放宽）。
  let helloAttempts = 0;
  const sendHello = () => {
    if (!bridgeAcked && iframeEl.contentWindow) {
      iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: TOKEN }, '*');
    }
  };
  sendHello();
  const helloRetry = setInterval(() => {
    helloAttempts += 1;
    if (bridgeAcked || helloAttempts > 60) { clearInterval(helloRetry); return; }
    sendHello();
  }, 250);
}`;
}

/** HTML 转义（防御性，消息来自 i18n 但转义不费事） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 页面外壳：公共骨架 + BUTTON_SCRIPT，可选追加额外内联脚本（如桥接握手脚本）。
 * @param extraScripts 追加在 BUTTON_SCRIPT 之后、</body> 之前的内联脚本（含 <script> 标签）
 */
function shell(ctx: PageCtx, title: string, bodyClass: string, body: string, extraScripts = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(ctx)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="${bodyClass}">${body}
<script nonce="${ctx.nonce}">${BUTTON_SCRIPT}</script>${extraScripts}
</body>
</html>`;
}

/** 加载中占位页 */
export function loadingPage(t: T, ctx: PageCtx): string {
  return shell(ctx, t('panel.loading'), '', `<div class="center"><div class="spinner"></div><p>${t('panel.loading')}</p></div>`);
}

/** 启动失败占位页：原因 + 重试 + 查看日志 */
export function errorPage(t: T, ctx: PageCtx, message: string): string {
  return shell(
    ctx,
    t('panel.errorTitle'),
    '',
    `<div class="center"><p>${t('panel.errorTitle')}</p><p>${escapeHtml(message)}</p>
<button data-action="retry">${t('panel.retry')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 服务断开占位页：重连 + 查看日志 */
export function disconnectedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('panel.disconnectedTitle'),
    '',
    `<div class="center"><p>${t('panel.disconnectedTitle')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button>
<button data-action="showLogs">${t('panel.showLogs')}</button></div>`,
  );
}

/** 手动停止后的占位页 */
export function stoppedPage(t: T, ctx: PageCtx): string {
  return shell(
    ctx,
    t('status.stopped'),
    '',
    `<div class="center"><p>${t('status.stopped')}</p>
<button data-action="reconnect">${t('panel.reconnect')}</button></div>`,
  );
}

/**
 * 需要登录占位页（DSH ≥0.1.2 浏览器鉴权）。
 *
 * 展示时机：服务已就绪、但扩展拿不到可用会话——典型是「DSH 由扩展之外启动」（扩展读不到
 * 它的 stdout 启动日志），或启动网址已随服务重启失效。用户把 `dsh web: …` 那一行粘进来
 * 即可完成一次登录（会话最长 30 天）。
 *
 * 页面内**不做任何校验/兑换逻辑**，只把输入原样 postMessage 给扩展（扩展负责校验 authority
 * 是否与当前服务一致、兑换、持久化与提示）。
 *
 * ⚠️ 脚本**不得再次声明 `vscode`**：公共段（BUTTON_SCRIPT）已在顶层用
 * `acquireVsCodeApi()` 声明过；顶层重复声明会抛 SyntaxError 使整段脚本失效（上游 3cca6cc 的坑，
 * 症状是"按钮点了没反应"）。这里直接复用外层 `vscode`。
 */
export function authRequiredPage(t: T, ctx: PageCtx): string {
  const inputScript = `
// 复用 BUTTON_SCRIPT 已声明的 vscode（见上：不得重复声明）
const authInput = document.getElementById('auth-url-input');
const authHint = document.getElementById('auth-hint');
const authBtn = document.getElementById('auth-submit');
function submitAuthUrl() {
  const url = ((authInput && authInput.value) || '').trim();
  if (url === '') return;
  if (authBtn) authBtn.disabled = true;
  if (authHint) authHint.textContent = ${JSON.stringify(t('panel.authSubmitting'))};
  vscode.postMessage({ type: 'authSubmitLaunchUrl', url: url });
}
if (authBtn) authBtn.addEventListener('click', submitAuthUrl);
if (authInput) {
  authInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAuthUrl(); }
  });
}
`;
  return shell(
    ctx,
    t('panel.authTitle'),
    '',
    `<div class="center auth-box">
<p><strong>${t('panel.authTitle')}</strong></p>
<p>${t('panel.authExplain')}</p>
<p class="auth-step">${t('panel.authStep1')}</p>
<p class="auth-step">${t('panel.authStep2')}</p>
<input id="auth-url-input" class="auth-input" type="text" spellcheck="false"
  placeholder="${escapeHtml(t('panel.authPlaceholder'))}" />
<p id="auth-hint" class="auth-hint">${t('panel.authHint')}</p>
<button id="auth-submit">${t('panel.authSubmit')}</button>
</div>`,
    `<script nonce="${ctx.nonce}">${inputScript}</script>`,
  );
}

/**
 * 就绪页：全屏 iframe 加载真实 DSH 网页（无 sandbox，避免破坏页面自身功能）。
 * iframe 显式声明 allow="clipboard-write" 作为第一层修复；但 VS Code 对 webview 内跨源 iframe 的
 * 原生剪贴板 API 仍存在权限拦截（microsoft/vscode#182642），因此还需桥接脚本把 DSH 页面内的
 * writeText 转发给扩展宿主（vscode.env.clipboard）执行，才能真正写入系统剪贴板。
 * 桥接启用时注入握手脚本，让顶层 webview 与 DSH 页面 iframe 建立握手并转发跳转/剪贴板消息。
 *
 * ⚠️ `url` 与 CSP 必须同源：DSH ≥0.1.2 鉴权下该 url 是**本地代办代理**的地址（不是 DSH 真实
 * 地址），`allowedOrigin` 由它推导。provider 侧必须用同一个 frameUrl 生成 `ctx.frameHosts`，
 * 否则会出现"iframe src 已换代理地址、CSP 仍放行旧地址"的**不同步白屏**。
 *
 * @param bridge 桥接配置（可选，向后兼容既有调用）：token 为握手凭据，enabled 为是否注入握手脚本
 */
export function readyPage(url: string, ctx: PageCtx, bridge?: { token: string; enabled: boolean }): string {
  // 桥接启用时注入握手脚本；未传入或 enabled=false 时保持向后兼容，不注入
  const extraScripts = bridge?.enabled
    ? `<script nonce="${ctx.nonce}">${bridgeHandshakeScript(bridge.token, new URL(url).origin)}</script>`
    : '';
  return shell(
    ctx,
    'DSH',
    'frame-body',
    `<iframe id="dsh-frame" class="frame" allow="clipboard-write" src="${url}"></iframe>`,
    extraScripts,
  );
}
