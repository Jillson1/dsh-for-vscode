// test/bridge/client-runtime.test.ts — 桥接构建产物的"运行时协议"回归测试
//
// 与 client-build.test.ts 的分工：
// - client-build.test.ts：只做语法与关键内容校验（产物能否被解析、是否残留占位符）；
// - 本文件：把产物真正**执行**在最小 DOM 桩里，验证协议行为——握手回执是否带 capabilities、
//   上行是否按白名单转发、下行是否按 kind 分发且不误投、既有能力是否回归。
//
// 为什么要这样测：桥接是"源码单测绿 ≠ 产物可用"的典型（core.js 要被内联进 client.js 工厂，
// 且 client.js 的事件绑定/分发逻辑只有 core 单测覆盖不到）。历史教训包括
// "decoration 只收集未应用""桥接漏转发 tool"这类只在运行时才暴露的缺陷。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBridgeClient } from '../../scripts/bridge-build.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 一次桥接运行环境：记录 iframe→父页面 / 桥接→插件的消息，并可派发事件 */
interface BridgeEnv {
  /** iframe → 父页面（扩展宿主）的消息 */
  readonly toParent: unknown[];
  /** 桥接 → 同 iframe 的插件（dsh-file-jump）的消息 */
  readonly toPlugin: unknown[];
  /** 派发 window 事件（如握手、上行 CustomEvent） */
  fire(type: string, event: unknown): void;
}

/** 最小 DOM 桩：只实现 client.js 工厂体真正触及的部分 */
function createEnv(loadCode: string): BridgeEnv {
  const toParent: unknown[] = [];
  const toPlugin: unknown[] = [];
  const windowListeners = new Map<string, ((e: unknown) => void)[]>();
  const documentListeners = new Map<string, ((e: unknown) => void)[]>();

  const addTo = (map: Map<string, ((e: unknown) => void)[]>, type: string, fn: (e: unknown) => void) => {
    const list = map.get(type) ?? [];
    list.push(fn);
    map.set(type, list);
  };
  const fakeEl = () => ({
    id: '',
    style: {},
    setAttribute() {},
    append() {},
    addEventListener() {},
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    contains: () => false,
  });
  const windowStub = {
    // 工厂注册：立即执行 factory（等价于 DSH 页面 materialize 桥接 bundle）
    __ModuleLoader__: { load: (m: { factory: (req: unknown) => unknown }) => m.factory(() => ({})) },
    addEventListener: (t: string, fn: (e: unknown) => void) => addTo(windowListeners, t, fn),
    postMessage: (msg: unknown) => toPlugin.push(msg),
    getSelection: () => null,
    innerWidth: 1200,
    innerHeight: 800,
  };
  const documentStub = {
    addEventListener: (t: string, fn: (e: unknown) => void) => addTo(documentListeners, t, fn),
    createElement: () => fakeEl(),
    head: { append() {} },
    body: { append() {} },
    activeElement: null,
    execCommand: () => true,
    getElementById: () => null,
  };
  // navigator 为空对象：installClipboardBridge 直接跳过（不涉及剪贴板接管）
  new Function('window', 'parent', 'document', 'navigator', 'console', loadCode)(
    windowStub,
    { postMessage: (msg: unknown) => toParent.push(msg) },
    documentStub,
    {},
    // 静默桥接的 "client.js executed" 日志，避免污染测试输出
    { log: () => {}, warn: () => {}, error: () => {} },
  );

  return {
    toParent,
    toPlugin,
    fire: (type, event) => {
      for (const fn of windowListeners.get(type) ?? []) fn(event);
    },
  };
}

/** 构建一次桥接产物并返回可执行的环境（构建到临时目录，用后删除） */
function withBuiltBridge(run: (env: BridgeEnv) => void): void {
  const outDir = join(tmpdir(), `dsh-bridge-runtime-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const built = buildBridgeClient({
    coreSource: join(process.cwd(), 'bridge-client', 'lib', 'core.js'),
    clientTemplate: join(process.cwd(), 'bridge-client', 'lib', 'client.js'),
    outDir,
  });
  try {
    run(createEnv(readFileSync(built, 'utf8')));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const HANDSHAKE = { data: { kind: 'bridgeHello', token: 'tok-test' } };

test('握手回执携带 capabilities（0.4.0 能力表）', () => {
  withBuiltBridge((env) => {
    // 握手前：无任何回执
    assert.deepEqual(env.toParent, []);
    env.fire('message', HANDSHAKE);
    const ack = env.toParent.find((m) => (m as { kind?: string }).kind === 'bridgeAck') as
      | { ok: boolean; capabilities?: string[] }
      | undefined;
    assert.ok(ack !== undefined, '握手后应回执 bridgeAck');
    assert.equal(ack.ok, true);
    // 能力表必须齐备：扩展靠它门控后续阶段（F6/F8/F9/F11）的命令显隐
    for (const cap of ['approval', 'question', 'changes', 'checkpoint', 'quickEdit', 'sessionState']) {
      assert.ok(ack.capabilities?.includes(cap), `capabilities 应包含 ${cap}`);
    }
  });
});

test('上行：白名单消息转发到父页面，非法/未知消息静默丢弃', () => {
  withBuiltBridge((env) => {
    env.fire('message', HANDSHAKE);
    env.toParent.length = 0;

    env.fire('dsh-file-jump:bridgeUp', {
      detail: { kind: 'sessionState', payload: { sessionId: 's1', running: true, turn: 3, pending: 2 } },
    });
    assert.deepEqual(env.toParent, [{ kind: 'sessionState', sessionId: 's1', running: true, turn: 3, pending: 2 }]);

    env.toParent.length = 0;
    env.fire('dsh-file-jump:bridgeUp', {
      detail: { kind: 'approvalRequest', payload: { sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: '越界写入' } },
    });
    assert.equal((env.toParent[0] as { kind: string }).kind, 'approvalRequest');
    assert.equal((env.toParent[0] as { reason?: string }).reason, '越界写入');

    // 未知 kind 与形状非法（缺 sessionId）都不应产生任何上行消息
    env.toParent.length = 0;
    env.fire('dsh-file-jump:bridgeUp', { detail: { kind: 'unknownKind', payload: { x: 1 } } });
    env.fire('dsh-file-jump:bridgeUp', { detail: { kind: 'sessionState', payload: {} } });
    assert.deepEqual(env.toParent, []);
  });
});

test('下行：按 kind 统一分发并加 dsh-file-jump 前缀，非法消息不误投', () => {
  withBuiltBridge((env) => {
    env.fire('message', HANDSHAKE);
    env.toPlugin.length = 0;

    env.fire('message', { data: { kind: 'quickEditSubmit', path: 'E:/a.ts', startLine: 12, endLine: 14, instruction: '改成防抖' } });
    assert.deepEqual(env.toPlugin[0], {
      kind: 'dsh-file-jump:quickEditSubmit',
      path: 'E:/a.ts',
      startLine: 12,
      endLine: 14,
      instruction: '改成防抖',
    });

    // 回归：非法 outcome 的审批决策必须整体丢弃（曾因"逐条尝试"分支链被 requestChanges 分支误收转发）
    env.toPlugin.length = 0;
    env.fire('message', { data: { kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'always' } });
    assert.deepEqual(env.toPlugin, []);

    // 合法审批决策正常转发
    env.fire('message', { data: { kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' } });
    assert.deepEqual(env.toPlugin, [
      { kind: 'dsh-file-jump:approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' },
    ]);

    // 未知下行 kind 静默丢弃
    env.toPlugin.length = 0;
    env.fire('message', { data: { kind: 'nope', sessionId: 's1' } });
    assert.deepEqual(env.toPlugin, []);
  });
});

test('既有能力不回归：diffApplied 中继与 injectComposer 下行仍工作', () => {
  withBuiltBridge((env) => {
    env.fire('message', HANDSHAKE);

    // A/B 组：applied diff → 父页面（扩展高亮/丢弃栈依赖它）
    env.toParent.length = 0;
    env.fire('dsh-file-jump:diffApplied', {
      detail: { path: 'E:/a.ts', diffs: [{ oldText: 'x', newText: 'y' }], callId: 'c1', tool: 'edit' },
    });
    const diff = env.toParent[0] as { kind: string; callId: string; tool?: string };
    assert.equal(diff.kind, 'diffApplied');
    assert.equal(diff.callId, 'c1');
    assert.equal(diff.tool, 'edit');

    // Add to DSH：下行 injectComposer → 插件
    env.toPlugin.length = 0;
    env.fire('message', { data: { kind: 'injectComposer', text: '@E:/a.ts' } });
    assert.deepEqual(env.toPlugin, [{ kind: 'dsh-file-jump:injectComposer', text: '@E:/a.ts' }]);
  });
});

test('未握手时不转发任何消息（普通浏览器打开 DSH 页面不应外泄）', () => {
  withBuiltBridge((env) => {
    // 不发送 bridgeHello：上行（含 diff 与交互增强消息）全部不转发
    env.fire('dsh-file-jump:bridgeUp', { detail: { kind: 'sessionState', payload: { sessionId: 's1' } } });
    env.fire('dsh-file-jump:diffApplied', {
      detail: { path: 'E:/a.ts', diffs: [{ oldText: 'x', newText: 'y' }], callId: 'c1' },
    });
    assert.deepEqual(env.toParent, []);
  });
});
