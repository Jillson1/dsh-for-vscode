// test/bridge/approval-router.test.ts — F6 审批闸门单测
// 覆盖三条安全边界（敏感工具不代答 / 只有两种结果 / 用户没选就不代答）+ 面板不可达的如实告知。
// 审批是"点错了就会放行一次真实操作"的路径，因此这里对"不做什么"的断言比"做了什么"更重要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApprovalRouter,
  approvalPrompt,
  isSensitiveTool,
  ALLOW_BUTTON,
  DENY_BUTTON,
} from '../../src/bridge/approval-router';
import type { PanelDownlink } from '../../src/panel/html';

/** 一次审批请求（默认：普通 bash 越界写入） */
function request(over: Partial<Parameters<ApprovalRouter['onRequest']>[0]> = {}) {
  return {
    sessionId: 'sess-1',
    approvalId: 'apr-1',
    toolName: 'bash',
    reason: '越界写入',
    ...over,
  };
}

/** 组装路由器 + 可观察记录 */
function makeRouter(choice: string | undefined, sent = true) {
  const sentMessages: PanelDownlink[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  let asked = 0;
  const router = new ApprovalRouter({
    ask: async () => {
      asked += 1;
      return choice;
    },
    send: (m) => {
      if (sent) sentMessages.push(m);
      return sent;
    },
    notify: (m) => notices.push(m),
    log: (m) => logs.push(m),
  });
  return { router, sentMessages, notices, logs, askedCount: () => asked };
}

test('允许一次 → 下行 approvalDecision(allowed-once)，并记账', async () => {
  const { router, sentMessages, logs } = makeRouter(ALLOW_BUTTON);
  const outcome = await router.onRequest(request());
  assert.equal(outcome, 'allowed-once');
  assert.deepEqual(sentMessages, [
    { type: 'bridgeApprovalDecision', sessionId: 'sess-1', approvalId: 'apr-1', outcome: 'allowed-once' },
  ]);
  assert.equal(router.hasAnswered('apr-1'), true);
  assert.equal(router.pendingCount(), 0);
  assert.ok(logs.some((l) => l.includes('allowed-once')));
});

test('拒绝 → 下行 rejected', async () => {
  const { router, sentMessages } = makeRouter(DENY_BUTTON);
  assert.equal(await router.onRequest(request()), 'rejected');
  assert.equal(sentMessages[0]?.type, 'bridgeApprovalDecision');
  assert.deepEqual(sentMessages[0], {
    type: 'bridgeApprovalDecision',
    sessionId: 'sess-1',
    approvalId: 'apr-1',
    outcome: 'rejected',
  });
});

test('用户没选（Esc / 关掉模态框）→ 不代答、不下行、不记账', async () => {
  const { router, sentMessages, logs } = makeRouter(undefined);
  assert.equal(await router.onRequest(request()), 'skipped');
  assert.deepEqual(sentMessages, [], '未选择时绝不能默认放行');
  assert.equal(router.hasAnswered('apr-1'), false);
  assert.ok(logs.some((l) => l.includes('未作出选择')));
  assert.equal(router.pendingCount(), 0, '处理结束后不留 pending');
});

test('敏感工具不代答：不弹窗、提示回 DSH 面板、不下行', async () => {
  for (const toolName of ['read-credential', 'write-api-key', 'set-password', 'edit-env', 'get-token']) {
    const { router, sentMessages, notices, askedCount } = makeRouter(ALLOW_BUTTON);
    assert.equal(await router.onRequest(request({ toolName })), 'skipped');
    assert.equal(askedCount(), 0, `${toolName} 不应弹模态框`);
    assert.deepEqual(sentMessages, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0] as string, /DSH 面板/);
  }
});

test('isSensitiveTool：命中凭据/密钥类，不误伤普通工具', () => {
  for (const t of ['credential', 'secret-store', 'api_key', 'API-KEY', 'token', 'password', 'private-key', '.env']) {
    assert.equal(isSensitiveTool(t), true, `${t} 应判为敏感`);
  }
  for (const t of ['bash', 'edit', 'write', 'read', 'pwsh', 'glob']) {
    assert.equal(isSensitiveTool(t), false, `${t} 不应判为敏感`);
  }
});

test('面板不可达 → 不记账 + 明确告知"结果未回传"（不假装已生效）', async () => {
  const { router, notices, sentMessages } = makeRouter(ALLOW_BUTTON, false);
  assert.equal(await router.onRequest(request()), 'skipped');
  assert.deepEqual(sentMessages, []);
  assert.equal(router.hasAnswered('apr-1'), false);
  assert.ok(notices.some((n) => n.includes('未能回传')));
});

test('同一 approvalId 已答过 → 不重复弹窗（重放/重连不打扰用户）', async () => {
  const { router, askedCount } = makeRouter(ALLOW_BUTTON);
  await router.onRequest(request());
  assert.equal(askedCount(), 1);
  assert.equal(await router.onRequest(request()), 'skipped');
  assert.equal(askedCount(), 1, '第二次不应再弹');
});

test('forget 清掉记账（会话切换 / 浏览器先答后不再拦截）', async () => {
  const { router, askedCount } = makeRouter(ALLOW_BUTTON);
  await router.onRequest(request());
  router.forget('apr-1');
  assert.equal(router.hasAnswered('apr-1'), false);
  await router.onRequest(request());
  assert.equal(askedCount(), 2);
});

test('approvalPrompt：含工具名与原因；不承诺"总是允许 / 记住"', () => {
  const text = approvalPrompt(request({ toolName: 'bash', reason: '越界写入' }));
  assert.match(text, /bash/);
  assert.match(text, /越界写入/);
  assert.match(text, /允许一次/);
  // 载荷只支持两种结果，文案里不能出现"总是允许/记住"这类做不到的承诺
  assert.doesNotMatch(text, /总是允许|记住|不再询问/);
  // 无原因时不留空标题
  assert.doesNotMatch(approvalPrompt(request({ reason: undefined })), /原因：/);
});
