// test/panel/panel-ready.test.ts — 面板"就绪"状态与自动打开投递的守卫测试
//
// 为什么单独测它（真机反馈）：面板没打开时 Add to DSH 只弹错误提示。修复方案是
// "自动打开面板 → 等桥接握手 → 再投递"。其中最容易静默出错的是**就绪判定**：
//   - 面板可见 ≠ 就绪（iframe 还在加载，桥接监听尚未装好 → 消息被丢弃）
//   - 同一页握手成功 ≠ 新页就绪（render 会整体替换文档，必须重新握手）
//   - 就绪判定写错的表现是"点了没反应/偶尔成功"，而日志里没有任何错误。
// 因此把 isReady / render 重置 / waitUntilReady 的语义全部钉死在单测里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshPanelProvider, type AuthUiState } from '../../src/panel/provider';
import type { ServiceManager } from '../../src/service/manager';

interface FakeView {
  visible: boolean;
  webview: {
    html: string;
    options?: unknown;
    cspSource: string;
    onDidReceiveMessage: (cb: (m: unknown) => void) => { dispose: () => void };
    postMessage: (m: unknown) => Promise<boolean>;
  };
  onDidDispose: () => { dispose: () => void };
}

function fakeView(visible = true): FakeView {
  return {
    visible,
    webview: {
      html: '',
      options: undefined,
      cspSource: 'vscode-webview://abc',
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/** 假 ServiceManager：provider 只用到 onChange / getSnapshot / getTarget / ensureRunning */
function fakeManager(state: string = 'ready') {
  return {
    onChange: (_cb: () => void) => () => undefined,
    getSnapshot: () => ({ state, url: 'http://127.0.0.1:3080/', error: null, owned: true }),
    getTarget: () => ({ host: '127.0.0.1', port: 3080 }),
    ensureRunning: () => Promise.resolve(undefined),
  };
}

function makeProvider(
  opts: { visible?: boolean; authState?: AuthUiState; serviceState?: string } = {},
): {
  provider: DshPanelProvider;
  view: FakeView;
  /** 模拟 webview 发来消息（bridgeAck 等） */
  send: (m: unknown) => void;
} {
  let handler: ((m: unknown) => void) | null = null;
  const provider = new DshPanelProvider(
    fakeManager(opts.serviceState) as unknown as ServiceManager,
    undefined,
    undefined, // onBridgeAck：本用例不需要
    () => undefined,
    () => false, // 桥接脚本关闭：HTML 内容不干扰断言，握手状态由 send() 直接模拟
    undefined,
    undefined,
    { authState: () => opts.authState },
  );
  const view = fakeView(opts.visible ?? true);
  view.webview.onDidReceiveMessage = (cb) => {
    handler = cb;
    return { dispose: () => undefined };
  };
  provider.resolveWebviewView(view as never);
  return { provider, view, send: (m) => handler?.(m) };
}

test('面板刚创建：可见但未握手 → isReady() = false', () => {
  const { provider } = makeProvider();
  assert.equal(provider.hasView(), true);
  assert.equal(provider.isVisible(), true);
  assert.equal(provider.isReady(), false, '未握手前不得视为就绪（否则消息会落进加载空窗）');
});

test('bridgeAck ok → isReady() = true', () => {
  const { provider, send } = makeProvider();
  send({ type: 'bridgeAck', ok: true, capabilities: ['injectComposer'] });
  assert.equal(provider.isReady(), true);
});

test('bridgeAck ok:false → 仍不就绪（不冒充可投递）', () => {
  const { provider, send } = makeProvider();
  send({ type: 'bridgeAck', ok: false });
  assert.equal(provider.isReady(), false);
});

test('面板不可见时即便握过手也不算就绪（下行为可见面板设计）', () => {
  const { provider, view, send } = makeProvider();
  send({ type: 'bridgeAck', ok: true });
  view.visible = false;
  assert.equal(provider.isReady(), false);
});

test('render 重建页面 → 就绪状态重置（新 iframe 必须重新握手）', () => {
  const { provider, send } = makeProvider();
  send({ type: 'bridgeAck', ok: true });
  assert.equal(provider.isReady(), true);
  provider.refresh(); // 重设 webview.html → 新文档/新 iframe
  assert.equal(provider.isReady(), false, '旧页面的握手不能代表新页面');
});

test('waitUntilReady：握手始终不来 → 超时返回 false（不永久挂起）', async () => {
  const { provider } = makeProvider();
  assert.equal(await provider.waitUntilReady(120), false);
});

test('waitUntilReady：等待期间握手成功 → 提前返回 true', async () => {
  const { provider, send } = makeProvider();
  // 模拟 iframe 慢启动：面板先打开，几百毫秒后桥接才 materialize 并发回握手
  setTimeout(() => send({ type: 'bridgeAck', ok: true }), 60);
  assert.equal(await provider.waitUntilReady(2000), true);
});

test('waitUntilReady：登录引导页（auth=needed）→ 立即失败，不让用户白等', async () => {
  const { provider } = makeProvider({ authState: 'needed' });
  const started = Date.now();
  assert.equal(await provider.waitUntilReady(10_000), false);
  assert.ok(Date.now() - started < 1000, '应在第一次轮询就返回（20 秒白等是无法接受的体验）');
});

test('waitUntilReady：服务启动失败 → 立即失败', async () => {
  const { provider } = makeProvider({ serviceState: 'failed' });
  const started = Date.now();
  assert.equal(await provider.waitUntilReady(10_000), false);
  assert.ok(Date.now() - started < 1000);
});
