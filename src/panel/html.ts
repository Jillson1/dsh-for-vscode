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
  | { type: 'bridgeDiffApplied'; path: string; cwd?: string; diffs: { oldText: string; newText: string }[]; callId: string; tool?: string }
  | { type: 'bridgeCopyText'; text: string; requestId: string }
  | { type: 'bridgeReadText'; requestId: string }
  | { type: 'bridgeReadTextAck'; requestId: string; ok: boolean; text?: string }
  | { type: 'bridgeInjectComposer'; text: string }
  | { type: 'bridgeAck'; ok: boolean; capabilities?: string[] }
  // —— 交互增强（bridge 0.4.0）上行消息：T0 只做落点（host 打日志），后续阶段各自接管 ——
  | { type: 'bridgeSessionState'; sessionId: string; running: boolean; turn: number; pending: number }
  | { type: 'bridgeApprovalRequest'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'bridgeQuestionRequest'; sessionId: string; questionId: string; questions: unknown[] }
  | { type: 'bridgeChangesSync'; sessionId: string; records: unknown[] }
  | { type: 'bridgeCheckpointsReady'; ok: boolean; sessionId?: string; error?: string };

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
  | { type: 'bridgeRequestChanges'; sessionId: string };

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
  const iframeSrc = iframeEl.src;
  // 握手 token 与允许的 DSH 页面 origin
  const TOKEN = ${JSON.stringify(token)};
  const ALLOWED_ORIGIN = ${JSON.stringify(allowedOrigin)};
  let bridgeAcked = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    // —— 下行：扩展宿主回执（vscode.webview.postMessage 投递），转发给 iframe ——
    if (d && d.type === 'bridgeCopyTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({ kind: 'copyTextAck', requestId: d.requestId, ok: d.ok }, iframeSrc);
      return;
    }
    // 剪贴板读取回执：转发给 iframe，供其 resolve 粘贴兜底的 readText Promise
    if (d && d.type === 'bridgeReadTextAck' && typeof d.requestId === 'string' && typeof d.ok === 'boolean') {
      iframeEl.contentWindow.postMessage({
        kind: 'readTextAck',
        requestId: d.requestId,
        ok: d.ok,
        text: typeof d.text === 'string' ? d.text : undefined,
      }, iframeSrc);
      return;
    }
    // 下行：扩展把文件引用注入 DSH composer（右键 "Add to DSH"）→ 转发给 iframe
    // 由 bridge client 再转给 dsh-file-jump 插件写输入框草稿。
    if (d && d.type === 'bridgeInjectComposer' && typeof d.text === 'string') {
      iframeEl.contentWindow.postMessage({ kind: 'injectComposer', text: d.text }, iframeSrc);
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
      }, iframeSrc);
      return;
    }
    if (d && d.type === 'bridgeApprovalDecision' && typeof d.sessionId === 'string' && typeof d.approvalId === 'string') {
      iframeEl.contentWindow.postMessage({
        kind: 'approvalDecision',
        sessionId: d.sessionId,
        approvalId: d.approvalId,
        outcome: d.outcome,
      }, iframeSrc);
      return;
    }
    if (d && d.type === 'bridgeQuestionAnswer' && typeof d.sessionId === 'string' && typeof d.questionId === 'string') {
      iframeEl.contentWindow.postMessage({
        kind: 'questionAnswer',
        sessionId: d.sessionId,
        questionId: d.questionId,
        answer: d.answer,
      }, iframeSrc);
      return;
    }
    if (d && d.type === 'bridgeRequestChanges' && typeof d.sessionId === 'string') {
      iframeEl.contentWindow.postMessage({ kind: 'requestChanges', sessionId: d.sessionId }, iframeSrc);
      return;
    }
    // —— 上行：iframe 发来的消息，origin + source 双重校验 ——
    if (e.origin !== ALLOWED_ORIGIN || e.source !== iframeEl.contentWindow) return;
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
    if (d && d.kind === 'checkpointsReady' && typeof d.ok === 'boolean') {
      vscode.postMessage({
        type: 'bridgeCheckpointsReady',
        ok: d.ok,
        sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
        error: typeof d.error === 'string' ? d.error : undefined,
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
  // iframe 加载完成后下发握手消息（携带 token）。
  // DSH 的 client 插件 factory 可能在 load 之后才 materialize（冷启动页面资源加载慢，
  // bridge 插件 materialize 可能晚于 load 数秒），握手消息会丢失，因此收到 bridgeAck 前
  // 每 250ms 重发一次，最多重试 10 秒（与扩展握手超时对齐，避免慢启动误判 degraded）。
  iframeEl.addEventListener('load', () => {
    let helloAttempts = 0;
    const sendHello = () => {
      if (!bridgeAcked && iframeEl.contentWindow) {
        iframeEl.contentWindow.postMessage({ kind: 'bridgeHello', token: TOKEN }, iframeSrc);
      }
    };
    sendHello();
    const helloRetry = setInterval(() => {
      helloAttempts += 1;
      if (bridgeAcked || helloAttempts > 40) { clearInterval(helloRetry); return; }
      sendHello();
    }, 250);
  });
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
 * 就绪页：全屏 iframe 加载真实 DSH 网页（无 sandbox，避免破坏页面自身功能）。
 * iframe 显式声明 allow="clipboard-write" 作为第一层修复；但 VS Code 对 webview 内跨源 iframe 的
 * 原生剪贴板 API 仍存在权限拦截（microsoft/vscode#182642），因此还需桥接脚本把 DSH 页面内的
 * writeText 转发给扩展宿主（vscode.env.clipboard）执行，才能真正写入系统剪贴板。
 * 桥接启用时注入握手脚本，让顶层 webview 与 DSH 页面 iframe 建立握手并转发跳转/剪贴板消息。
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
