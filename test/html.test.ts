// test/html.test.ts — 面板占位页模板的单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n, t } from '../src/i18n';
import { loadingPage, errorPage, disconnectedPage, stoppedPage, readyPage, authRequiredPage, type PageCtx } from '../src/panel/html';

function ctx(): PageCtx {
  return { nonce: 'abc123', cspSource: 'vscode-webview:', frameHosts: ['http://127.0.0.1:3080'] };
}

test('loadingPage 包含加载动画与本地化文案', () => {
  initI18n('zh-cn');
  const html = loadingPage(t, ctx());
  assert.ok(html.includes('spinner'));
  assert.ok(html.includes(t('panel.loading')));
});

test('errorPage 包含重试按钮并转义消息中的 HTML', () => {
  initI18n('en');
  const html = errorPage(t, ctx(), '<script>alert(1)</script>');
  assert.ok(html.includes('data-action="retry"'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('disconnectedPage 与 stoppedPage 都包含重连按钮', () => {
  const d = disconnectedPage(t, ctx());
  const s = stoppedPage(t, ctx());
  assert.ok(d.includes('data-action="reconnect"'));
  assert.ok(s.includes('data-action="reconnect"'));
});

test('readyPage 包含目标地址 iframe 且无 sandbox 属性', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('id="dsh-frame"'));
  assert.ok(html.includes('class="frame"'));
  assert.ok(html.includes('src="http://127.0.0.1:3080/"'));
  assert.ok(!html.includes('sandbox'));
});

test('readyPage 为跨源 iframe 声明 clipboard-write 权限', () => {
  // VS Code webview 与 DSH 页面跨源：不声明 allow="clipboard-write" 时，
  // DSH 代码块复制按钮的 navigator.clipboard.writeText 会被 Permissions Policy 拦截。
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('allow="clipboard-write"'));
});

test('readyPage 启用桥接时注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 握手脚本标记与 token 均需出现在产物中（脚本会向 iframe 下发 bridgeHello）
  assert.ok(html.includes('dsh-bridge-handshake'));
  assert.ok(html.includes('tok123'));
});

test('readyPage 握手脚本包含上行 bridgeHello 发送', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // iframe load 后向 iframe 发送 bridgeHello 握手消息（携带 token）
  assert.ok(html.includes("kind: 'bridgeHello'"), 'load 后应发送 bridgeHello');
  assert.ok(html.includes('token: TOKEN'), '握手消息应携带 token');
  // 不应再包含下行 syncWorkspace 转发逻辑（工作区同步已移除）
  assert.ok(!html.includes('syncWorkspace'), '脚本不应包含 syncWorkspace 下行转发');
});

test('readyPage 握手脚本包含剪贴板桥接的上下行转发', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 上行：iframe 的 copyText → vscode.postMessage(bridgeCopyText)
  assert.ok(html.includes("kind === 'copyText'"), '应转发 iframe 的 copyText 上行消息');
  assert.ok(html.includes("type: 'bridgeCopyText'"), '应向扩展宿主发送 bridgeCopyText');
  // 下行：扩展宿主 bridgeCopyTextAck → iframe 的 copyTextAck
  assert.ok(html.includes("type === 'bridgeCopyTextAck'"), '应接收扩展宿主的剪贴板回执');
  assert.ok(html.includes("kind: 'copyTextAck'"), '应把回执转发为 iframe 的 copyTextAck');
});

test('readyPage 握手脚本包含剪贴板读取（粘贴兜底）的上下行转发', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 上行：iframe 的 readText → vscode.postMessage(bridgeReadText)
  assert.ok(html.includes("kind === 'readText'"), '应转发 iframe 的 readText 上行消息');
  assert.ok(html.includes("type: 'bridgeReadText'"), '应向扩展宿主发送 bridgeReadText');
  // 下行：扩展宿主 bridgeReadTextAck → iframe 的 readTextAck（携带 text）
  assert.ok(html.includes("type === 'bridgeReadTextAck'"), '应接收扩展宿主的读取回执');
  assert.ok(html.includes("kind: 'readTextAck'"), '应把回执转发为 iframe 的 readTextAck');
  assert.ok(html.includes('typeof d.text === \'string\''), '回执应透传剪贴板文本');
});

test('readyPage 未启用桥接时不注入握手脚本', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  // 未传第三参（或 enabled=false）时保持向后兼容，不注入握手脚本
  assert.ok(!html.includes('dsh-bridge-handshake'));
});

test('CSP 声明 frame-src 与 script-src nonce', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx());
  assert.ok(html.includes('frame-src http://127.0.0.1:3080'));
  assert.ok(html.includes("script-src 'nonce-abc123'"));
});

// —— 交互增强地基（bridge 0.4.0）：握手 capabilities + 五上四下消息分支 ——

test('readyPage 握手回执透传 capabilities（0.4.0 能力表）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // bridgeAck 分支应读取 d.capabilities 并随 bridgeAck 上报给扩展（旧桥接不带字段 → undefined）
  assert.ok(html.includes('d.capabilities'), '握手回执应读取 capabilities');
  assert.ok(html.includes("type: 'bridgeAck'"), '应上报 bridgeAck');
  assert.ok(html.includes('capabilities: caps'), 'bridgeAck 应携带归一后的能力表');
});

test('readyPage 握手脚本包含交互增强上行分支（5 条）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 上行：iframe → 扩展；kind 为桥接 core.js 的构造产物，type 为扩展侧 PanelMessage
  for (const [kind, type] of [
    ['sessionState', 'bridgeSessionState'],
    ['approvalRequest', 'bridgeApprovalRequest'],
    ['questionRequest', 'bridgeQuestionRequest'],
    ['changesSync', 'bridgeChangesSync'],
    ['checkpointsReady', 'bridgeCheckpointsReady'],
  ]) {
    assert.ok(html.includes(`kind === '${kind}'`), `应转发行 ${kind} 上行消息`);
    assert.ok(html.includes(`type: '${type}'`), `应向扩展宿主发送 ${type}`);
  }
});

test('readyPage 握手脚本包含交互增强下行分支（4 条）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok123', enabled: true });
  // 下行：扩展 → iframe；type 为扩展侧 PanelDownlink，kind 为桥接转发给插件的形状
  for (const [type, kind] of [
    ['bridgeQuickEditSubmit', 'quickEditSubmit'],
    ['bridgeApprovalDecision', 'approvalDecision'],
    ['bridgeQuestionAnswer', 'questionAnswer'],
    ['bridgeRequestChanges', 'requestChanges'],
  ]) {
    assert.ok(html.includes(`type === '${type}'`), `应接收扩展宿主的 ${type}`);
    assert.ok(html.includes(`kind: '${kind}'`), `应把下行消息转发为 iframe 的 ${kind}`);
  }
});

// —— DSH ≥0.1.2 鉴权适配（S4）——
test('authRequiredPage：含说明、输入框、提交按钮与提交脚本（复用公共段 vscode）', () => {
  initI18n('zh-cn');
  const html = authRequiredPage(t, ctx());
  assert.ok(html.includes('id="auth-url-input"'), '应有启动网址输入框');
  assert.ok(html.includes('id="auth-submit"'), '应有提交按钮');
  assert.ok(html.includes(t('panel.authTitle')));
  assert.ok(html.includes(t('panel.authExplain')));
  assert.ok(html.includes("type: 'authSubmitLaunchUrl'"), '提交脚本应 postMessage authSubmitLaunchUrl');
  // 提交内容是用户粘贴的原文，扩展侧负责抠 URL 与校 authority
  assert.ok(html.includes('url: url'));
});

test('防回归：acquireVsCodeApi 每页恰好一次（重复声明会让整段脚本失效）', () => {
  initI18n('zh-cn');
  const pages = [
    loadingPage(t, ctx()),
    errorPage(t, ctx(), 'x'),
    disconnectedPage(t, ctx()),
    stoppedPage(t, ctx()),
    authRequiredPage(t, ctx()),
    readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok', enabled: true }),
  ];
  for (const html of pages) {
    const n = html.split('acquireVsCodeApi()').length - 1;
    assert.equal(n, 1, `每个页面必须恰好声明一次 vscode 实例，实际 ${n} 次`);
  }
});

test('握手脚本四件套（3f23898）：下行 targetOrigin 统一为通配，不再缓存 iframeSrc', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok', enabled: true });
  // 下行一律 '*'：接收窗口已由 iframeEl.contentWindow 锁定，hello 自带 token 防伪；
  // 用 iframe.src 推导的 origin 作 targetOrigin 会在 webview SW 重写 origin 时直接抛错
  assert.ok(!html.includes('iframeSrc'), '不得再缓存 iframeEl.src 作为 targetOrigin');
  assert.ok(html.includes("}, '*')"), "下行 postMessage 应使用 '*'");
});

test('握手脚本四件套：上行用 isAllowedBridgeOrigin 兼容 SW 重写与 loopback 互换', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok', enabled: true });
  assert.ok(html.includes('isAllowedBridgeOrigin'), '应引入来源判定函数');
  assert.ok(html.includes("o.startsWith('vscode-webview://')"), '应放行 webview SW 重写后的载体 origin');
  assert.ok(html.includes("h === 'localhost'"), '应兼容 127.0.0.1 ↔ localhost 等价写法');
  // 上行改为「source 限定 + 来源判定」，不再是严格相等
  assert.ok(html.includes('if (e.source !== iframeEl.contentWindow || !isAllowedBridgeOrigin(e.origin)) return;'));
  assert.ok(!html.includes('if (e.origin !== ALLOWED_ORIGIN'), '不再用严格 origin 相等（会静默拒掉全部上行）');
});

test('握手脚本四件套：hello 不挂 load 事件且重试 15 秒（60 次 × 250ms）', () => {
  const html = readyPage('http://127.0.0.1:3080/', ctx(), { token: 'tok', enabled: true });
  assert.ok(!html.includes("addEventListener('load'"), 'hello 不得挂在 load 事件上（本机直连会错过事件）');
  assert.ok(html.includes('helloAttempts > 60'), '重试上限应为 60 次（15 秒）');
});

test('readyPage 的握手 allowedOrigin 跟随传入 url（鉴权下即代理地址）', () => {
  // 这是「CSP / iframe src / allowedOrigin 单一推导」的关键一半：
  // provider 把 frameUrl（可能是代理地址）传进来，握手脚本必须按它推导 origin。
  const proxyUrl = 'http://127.0.0.1:51234/';
  const html = readyPage(proxyUrl, ctx(), { token: 'tok', enabled: true });
  assert.ok(html.includes('"http://127.0.0.1:51234"'), 'allowedOrigin 应为代理地址的 origin');
});
