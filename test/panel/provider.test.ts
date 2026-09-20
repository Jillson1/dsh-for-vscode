// test/panel/provider.test.ts — 面板三态与「iframe / CSP 同源」的守卫测试（DSH ≥0.1.2 鉴权适配）
//
// 为什么单独测它：鉴权适配把 iframe 的 src 从「DSH 真实地址」换成了「本地代办代理地址」。
// CSP 的 frame-src 必须**由同一个最终地址推导**——若不同步，浏览器的表现是 iframe 被
// CSP 直接拒绝，**面板整片白屏**，而日志里往往什么都没有（这是最贵的一类回归，
// 上游 issue #13-2 专门修过一次）。本文件把"两者同源"钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initI18n } from '../../src/i18n';
import { DshPanelProvider, type AuthUiState } from '../../src/panel/provider';
import type { ServiceManager } from '../../src/service/manager';

initI18n('zh-cn');

/** 假 webview view：捕获最后一次 set 的 html */
function fakeView(): { webview: { html: string; options?: unknown; cspSource: string; onDidReceiveMessage: () => unknown; postMessage: () => Promise<boolean> }; onDidDispose: () => unknown } {
  const v = {
    webview: {
      html: '',
      options: undefined as unknown,
      cspSource: 'vscode-webview://abc',
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: () => Promise.resolve(true),
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
  return v;
}

/**
 * 假 ServiceManager：provider 只用到 onChange / getSnapshot / getTarget / ensureRunning，
 * 因此不必构造真实状态机（真实 manager 的行为由 test/manager.test.ts 覆盖）。
 */
function fakeManager(state: 'ready' | 'idle' = 'ready', url: string | null = 'http://127.0.0.1:3080/') {
  const listeners: (() => void)[] = [];
  return {
    onChange: (cb: () => void) => {
      listeners.push(cb);
      return () => undefined;
    },
    getSnapshot: () => ({ state, url, error: null, owned: true }),
    getTarget: () => ({ host: '127.0.0.1', port: 3080 }),
    ensureRunning: () => Promise.resolve(undefined),
    fire: () => {
      for (const cb of listeners) cb();
    },
  };
}

/** 构造 provider（真实构造签名：manager, onFirstOpen?, onBridgeAck?, workspaceRoot?, bridgeEnabled?, diffService?, logBridgeEvent?, ui?） */
function makeProvider(opts: {
  state?: 'ready' | 'idle';
  url?: string | null;
  authState?: AuthUiState;
  frameBaseOverride?: string | null;
  onAuthUrlSubmit?: (url: string) => void;
}) {
  const mgr = fakeManager(opts.state ?? 'ready', opts.url === undefined ? 'http://127.0.0.1:3080/' : opts.url);
  const provider = new DshPanelProvider(
    mgr as unknown as ServiceManager,
    undefined,
    undefined,
    () => undefined,
    () => false, // 桥接关闭：让断言聚焦 iframe/CSP，不受握手脚本内联内容干扰
    undefined,
    undefined,
    {
      authState: () => opts.authState,
      frameBaseOverride: () => opts.frameBaseOverride ?? null,
      onAuthUrlSubmit: opts.onAuthUrlSubmit,
    },
  );
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  return { provider, mgr, view };
}

test('三态 pending → 加载动画页（不含 iframe）', () => {
  const { view } = makeProvider({ authState: 'pending' });
  assert.ok(view.webview.html.includes('spinner'), 'pending 应显示加载动画');
  assert.ok(!view.webview.html.includes('<iframe'), 'pending 不得提前进 iframe');
});

test('三态 needed → 登录引导页（含输入框与提交按钮，不含 iframe）', () => {
  const { view } = makeProvider({ authState: 'needed' });
  assert.ok(view.webview.html.includes('id="auth-url-input"'), 'needed 应显示登录引导页');
  assert.ok(view.webview.html.includes('id="auth-submit"'));
  assert.ok(!view.webview.html.includes('<iframe'), 'needed 不得加载 iframe（否则又是 401 页面）');
});

test('三态 ok + 无基址覆盖 → iframe 用 DSH 真实地址，CSP frame-src 与之同源', () => {
  const { view } = makeProvider({ authState: 'ok' });
  assert.ok(view.webview.html.includes('src="http://127.0.0.1:3080/"'));
  assert.ok(view.webview.html.includes('frame-src http://127.0.0.1:3080'), 'CSP 必须放行实际加载地址');
});

test('三态 ok + 代理基址覆盖 → iframe 与 CSP 同时切到代理地址（白屏防线的核心断言）', () => {
  const proxyBase = 'http://127.0.0.1:51234/';
  const { view } = makeProvider({ authState: 'ok', frameBaseOverride: proxyBase });
  assert.ok(view.webview.html.includes(`src="${proxyBase}"`), 'iframe 应指向代办代理');
  assert.ok(
    view.webview.html.includes('frame-src http://127.0.0.1:51234'),
    'CSP frame-src 必须跟随最终地址——只改 iframe 不改 CSP 会导致面板整片白屏',
  );
  assert.ok(
    !view.webview.html.includes('frame-src http://127.0.0.1:3080'),
    'CSP 不得仍只放行旧地址',
  );
});

test('refresh() 能拾取外部状态变化（onChange 之外的触发源）', () => {
  let state: AuthUiState = 'pending';
  const mgr = fakeManager('ready');
  const provider = new DshPanelProvider(
    mgr as unknown as ServiceManager,
    undefined,
    undefined,
    () => undefined,
    () => false,
    undefined,
    undefined,
    { authState: () => state, frameBaseOverride: () => null },
  );
  const view = fakeView();
  provider.resolveWebviewView(view as never);
  assert.ok(view.webview.html.includes('spinner'), '初始 pending → 加载页');

  // 模拟"会话兑换完成"：这个变化不经过 manager.onChange，只能靠 refresh()
  state = 'ok';
  provider.refresh();
  assert.ok(view.webview.html.includes('<iframe'), 'refresh() 后应进 iframe（否则面板永远停在加载页）');
});

test('登录引导页提交 → 转交扩展的 onAuthUrlSubmit（页面内不做逻辑）', () => {
  const submitted: string[] = [];
  const mgr = fakeManager('ready');
  let onMessage: ((m: unknown) => void) | null = null;
  const provider = new DshPanelProvider(
    mgr as unknown as ServiceManager,
    undefined,
    undefined,
    () => undefined,
    () => false,
    undefined,
    undefined,
    { authState: () => 'needed', frameBaseOverride: () => null, onAuthUrlSubmit: (u) => submitted.push(u) },
  );
  const view = fakeView();
  view.webview.onDidReceiveMessage = (cb?: unknown) => {
    if (typeof cb === 'function') onMessage = cb as (m: unknown) => void;
    return { dispose: () => undefined };
  };
  provider.resolveWebviewView(view as never);
  assert.notEqual(onMessage, null, '应订阅 webview 消息');
  onMessage!({ type: 'authSubmitLaunchUrl', url: 'dsh web: http://127.0.0.1:3080/?token=abc' });
  assert.deepEqual(submitted, ['dsh web: http://127.0.0.1:3080/?token=abc']);
});
