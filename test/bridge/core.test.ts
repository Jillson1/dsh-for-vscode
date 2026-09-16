// test/bridge/core.test.ts — 桥接纯逻辑单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedExternalUrl,
  buildOpenExternalMessage,
  buildOpenFileMessage,
  buildSyncWorkspaceAck,
  buildCopyTextMessage,
  buildCopyTextAck,
  buildDiffAppliedMessage,
  isBridgeMessage,
  HANDSHAKE_TOKEN_KEY,
  getShortcutCommand,
  isEditableElement,
  computeInsertedValue,
  buildReadTextMessage,
  buildReadTextAck,
  BRIDGE_CAPABILITIES,
  UPLINK_EVENT,
  buildSessionStateMessage,
  buildApprovalRequestMessage,
  buildQuestionRequestMessage,
  buildChangesSyncMessage,
  buildCheckpointsReadyMessage,
  buildBridgeUplinkMessage,
  parseQuickEditSubmit,
  parseApprovalDecision,
  parseQuestionAnswer,
  parseRequestChanges,
  parseInjectComposer,
  parseDownlinkMessage,
} from '../../bridge-client/lib/core.js';

test('isAllowedExternalUrl 仅放行 http/https', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/a'), true);
  assert.equal(isAllowedExternalUrl('http://127.0.0.1:3080/x'), true);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl(''), false);
});

test('buildOpenExternalMessage 构造消息', () => {
  assert.deepEqual(buildOpenExternalMessage('https://a.b/c'), { kind: 'openExternal', url: 'https://a.b/c' });
});

test('buildOpenFileMessage 携带可选 cwd', () => {
  assert.deepEqual(buildOpenFileMessage('src/main.ts', '/proj'), { kind: 'openFile', path: 'src/main.ts', cwd: '/proj' });
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined), { kind: 'openFile', path: '/abs/a.ts' });
});

test('buildOpenFileMessage 携带可选 oldText（仅非空字符串）', () => {
  // 合法 oldText → 消息带 oldText 字段（edit 场景跳行依据）
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined, 'const x = 1'), { kind: 'openFile', path: '/abs/a.ts', oldText: 'const x = 1' });
  // cwd 与 oldText 并存
  assert.deepEqual(buildOpenFileMessage('a.ts', '/proj', 'old'), { kind: 'openFile', path: 'a.ts', cwd: '/proj', oldText: 'old' });
  // 空字符串 / undefined → 省略 oldText 字段，消息形状不变
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined, ''), { kind: 'openFile', path: '/abs/a.ts' });
  assert.deepEqual(buildOpenFileMessage('/abs/a.ts', undefined), { kind: 'openFile', path: '/abs/a.ts' });
});

test('buildSyncWorkspaceAck 构造回执', () => {
  assert.deepEqual(buildSyncWorkspaceAck(true), { kind: 'bridgeAck', ok: true });
  assert.deepEqual(buildSyncWorkspaceAck(false, '/proj'), { kind: 'bridgeAck', ok: false, path: '/proj' });
});

test('buildCopyTextMessage / buildCopyTextAck 构造剪贴板桥接消息', () => {
  assert.deepEqual(buildCopyTextMessage('hello', 'req-1'), { kind: 'copyText', text: 'hello', requestId: 'req-1' });
  assert.deepEqual(buildCopyTextAck('req-1', true), { kind: 'copyTextAck', requestId: 'req-1', ok: true });
  assert.deepEqual(buildCopyTextAck('req-2', false), { kind: 'copyTextAck', requestId: 'req-2', ok: false });
});

test('isBridgeMessage 校验 token', () => {
  assert.equal(isBridgeMessage({ token: 't1' }, 't1'), true);
  assert.equal(isBridgeMessage({ token: 't2' }, 't1'), false);
  assert.equal(isBridgeMessage(null, 't1'), false);
});

test('常量取值正确', () => {
  assert.equal(HANDSHAKE_TOKEN_KEY, 'token');
});

// —— 标准编辑快捷键仿真（VS Code 吞掉 iframe 内 Cmd+C/V/A/X/Z 的修复） ——

test('getShortcutCommand 识别 mac/win 标准编辑快捷键', () => {
  // mac: metaKey
  assert.equal(getShortcutCommand({ key: 'c', metaKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'v', metaKey: true }), 'paste');
  assert.equal(getShortcutCommand({ key: 'x', metaKey: true }), 'cut');
  assert.equal(getShortcutCommand({ key: 'a', metaKey: true }), 'selectAll');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true }), 'undo');
  assert.equal(getShortcutCommand({ key: 'z', metaKey: true, shiftKey: true }), 'redo');
  // win/linux: ctrlKey
  assert.equal(getShortcutCommand({ key: 'C', ctrlKey: true }), 'copy');
  assert.equal(getShortcutCommand({ key: 'V', ctrlKey: true }), 'paste');
  // Shift+Insert（Windows 粘贴惯例）
  assert.equal(getShortcutCommand({ key: 'Insert', shiftKey: true }), 'paste');
  // 大小写不敏感
  assert.equal(getShortcutCommand({ key: 'C', metaKey: true }), 'copy');
  // 未命中：无修饰键、非编辑键、非法输入
  assert.equal(getShortcutCommand({ key: 'c' }), null);
  assert.equal(getShortcutCommand({ key: 'Enter', metaKey: true }), null);
  assert.equal(getShortcutCommand({ key: 'k', ctrlKey: true }), null);
  assert.equal(getShortcutCommand(null), null);
  assert.equal(getShortcutCommand(undefined), null);
  assert.equal(getShortcutCommand({}), null);
});

test('isEditableElement 只认可接收文本编辑的元素', () => {
  // textarea / text input / contenteditable 为可编辑
  assert.equal(isEditableElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: '' }), true); // type 缺省即 text
  assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  // 非文本输入型 input 不可编辑
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isEditableElement({ tagName: 'INPUT', type: 'button' }), false);
  // 普通元素 / 空值 / 非对象
  assert.equal(isEditableElement({ tagName: 'DIV' }), false);
  assert.equal(isEditableElement(null), false);
  assert.equal(isEditableElement(undefined), false);
  assert.equal(isEditableElement('textarea'), false);
});

test('computeInsertedValue 在选区插入文本', () => {
  // 正常插入（前不着后不着）
  assert.equal(computeInsertedValue('hello world', 6, 11, 'VS Code'), 'hello VS Code');
  // 全选替换
  assert.equal(computeInsertedValue('hello', 0, 5, 'hi'), 'hi');
  // 空选区 = 光标处插入
  assert.equal(computeInsertedValue('ab', 1, 1, 'X'), 'aXb');
  // 选区顺序/越界归一
  assert.equal(computeInsertedValue('abc', 5, 2, 'X'), 'abcX');
  assert.equal(computeInsertedValue('abc', -1, 2, 'X'), 'Xc');
  // 非字符串值兜底
  assert.equal(computeInsertedValue(undefined, 0, 0, 'x'), 'x');
  assert.equal(computeInsertedValue(null, 0, 0, 'x'), 'x');
});

test('buildReadTextMessage / buildReadTextAck 构造剪贴板读取消息', () => {
  assert.deepEqual(buildReadTextMessage('req-1'), { kind: 'readText', requestId: 'req-1' });
  assert.deepEqual(buildReadTextAck('req-1', true, 'abc'), { kind: 'readTextAck', requestId: 'req-1', ok: true, text: 'abc' });
  // 读取失败：不带 text 字段
  assert.deepEqual(buildReadTextAck('req-2', false), { kind: 'readTextAck', requestId: 'req-2', ok: false });
  assert.deepEqual(buildReadTextAck('req-3', true, ''), { kind: 'readTextAck', requestId: 'req-3', ok: false });
});

test('buildDiffAppliedMessage 透传 tool（write 新建丢弃语义依赖它）', () => {
  const msg = buildDiffAppliedMessage({
    path: 'E:\p\n.md',
    diffs: [{ oldText: '', newText: 'hi' }],
    callId: 'c-1',
    tool: 'write',
  });
  assert.ok(msg !== null);
  assert.equal(msg.tool, 'write');
  assert.deepEqual(msg.diffs, [{ oldText: '', newText: 'hi' }]);
  // 空 oldText 必须保留（write 新建 → 全绿高亮 + 丢弃删除文件）
  const noTool = buildDiffAppliedMessage({ path: 'a.ts', diffs: [{ oldText: 'x', newText: 'y' }], callId: 'c-2' });
  assert.ok(noTool !== null);
  assert.equal(noTool.tool, undefined);
});

// —— 交互增强地基（bridge 0.4.0）：能力表 + 新消息构造/校验 ——

test('bridgeAck 携带能力表（capabilities 可选，缺省不破坏旧形状）', () => {
  // 旧调用（无 capabilities）形状不变：向后兼容（旧扩展按 { kind, ok } 解析）
  assert.deepEqual(buildSyncWorkspaceAck(true), { kind: 'bridgeAck', ok: true });
  // 新调用：capabilities 归一为字符串数组
  assert.deepEqual(buildSyncWorkspaceAck(true, undefined, ['openFile', 'approval']), {
    kind: 'bridgeAck',
    ok: true,
    capabilities: ['openFile', 'approval'],
  });
  // 空数组 / 全非法项 → 省略字段（不产生 capabilities: [] 这种半成品形状）
  assert.deepEqual(buildSyncWorkspaceAck(true, undefined, []), { kind: 'bridgeAck', ok: true });
  assert.deepEqual(buildSyncWorkspaceAck(true, undefined, [1, '', null] as unknown as string[]), {
    kind: 'bridgeAck',
    ok: true,
  });
  // capabilities 与 path 并存
  assert.deepEqual(buildSyncWorkspaceAck(false, '/proj', ['openFile']), {
    kind: 'bridgeAck',
    ok: false,
    path: '/proj',
    capabilities: ['openFile'],
  });
});

test('BRIDGE_CAPABILITIES / UPLINK_EVENT 内容固定（扩展门控与插件投递依赖它）', () => {
  // 能力表覆盖全部已实现与新地基能力；扩展用它与 when 子句做门控
  for (const cap of ['openFile', 'diffApplied', 'injectComposer', 'quickEdit', 'approval', 'question', 'changes', 'checkpoint', 'sessionState']) {
    assert.ok(BRIDGE_CAPABILITIES.includes(cap), `能力表应包含 ${cap}`);
  }
  // 事件名是插件与桥接的硬契约，改名等于破坏兼容
  assert.equal(UPLINK_EVENT, 'dsh-file-jump:bridgeUp');
});

test('buildSessionStateMessage 严格布尔化并兜底计数', () => {
  assert.deepEqual(buildSessionStateMessage({ sessionId: 's1', running: true, turn: 3, pending: 2 }), {
    kind: 'sessionState',
    sessionId: 's1',
    running: true,
    pending: 2,
    turn: 3,
  });
  // running 非 true → false；turn/pending 非法 → 0
  assert.deepEqual(buildSessionStateMessage({ sessionId: 's1', running: 'yes', turn: NaN, pending: undefined }), {
    kind: 'sessionState',
    sessionId: 's1',
    running: false,
    pending: 0,
    turn: 0,
  });
  // 缺 sessionId / 非对象 → null（无法归属会话的消息一律丢弃）
  assert.equal(buildSessionStateMessage({ running: false }), null);
  assert.equal(buildSessionStateMessage(null), null);
});

test('buildApprovalRequestMessage 必填三字段，可选字段仅非空才带上', () => {
  assert.deepEqual(
    buildApprovalRequestMessage({ sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'c1', reason: '越界写入' }),
    { kind: 'approvalRequest', sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'c1', reason: '越界写入' },
  );
  // 可选字段缺省 / 空串 → 省略
  assert.deepEqual(buildApprovalRequestMessage({ sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: '', reason: '' }), {
    kind: 'approvalRequest',
    sessionId: 's1',
    approvalId: 'a1',
    toolName: 'bash',
  });
  // 任一必填缺失 → null
  assert.equal(buildApprovalRequestMessage({ approvalId: 'a1', toolName: 'bash' }), null);
  assert.equal(buildApprovalRequestMessage({ sessionId: 's1', toolName: 'bash' }), null);
  assert.equal(buildApprovalRequestMessage({ sessionId: 's1', approvalId: 'a1' }), null);
});

test('buildQuestionRequestMessage 保留对象项、丢弃非法项', () => {
  assert.deepEqual(
    buildQuestionRequestMessage({ sessionId: 's1', questionId: 'q1', questions: [{ id: 'x' }, null, 'raw', 7] }),
    { kind: 'questionRequest', sessionId: 's1', questionId: 'q1', questions: [{ id: 'x' }] },
  );
  // questions 非数组 → 归一为空数组（提问仍可呈现，只是没有可选项）
  assert.deepEqual(buildQuestionRequestMessage({ sessionId: 's1', questionId: 'q1', questions: 'oops' }), {
    kind: 'questionRequest',
    sessionId: 's1',
    questionId: 'q1',
    questions: [],
  });
  assert.equal(buildQuestionRequestMessage({ sessionId: 's1' }), null);
});

test('buildChangesSyncMessage 白名单归一记录，空列表是合法语义', () => {
  const msg = buildChangesSyncMessage({
    sessionId: 's1',
    records: [
      {
        callId: 'c1',
        path: 'src/a.ts',
        absPath: 'D:/proj/src/a.ts',
        sessionId: 's1',
        turn: 2,
        tool: 'edit',
        oldText: 'old',
        newText: 'new',
        time: 123,
        source: 'replay',
        fileHashAtRecord: 'abc',
        junk: '不该被透传',
      },
      null,
      { callId: 'c2' }, // 缺 path/absPath → 丢弃
      { path: 'only-rel.ts' }, // 缺 callId → 丢弃
    ],
  });
  assert.ok(msg !== null);
  assert.equal(msg.kind, 'changesSync');
  assert.equal(msg.records.length, 1);
  assert.deepEqual(msg.records[0], {
    callId: 'c1',
    path: 'src/a.ts',
    absPath: 'D:/proj/src/a.ts',
    sessionId: 's1',
    turn: 2,
    tool: 'edit',
    oldText: 'old',
    newText: 'new',
    time: 123,
    source: 'replay',
    fileHashAtRecord: 'abc',
  });
  // 空 records：合法（"当前没有变更"），不应被丢弃
  assert.deepEqual(buildChangesSyncMessage({ sessionId: 's1', records: [] }), {
    kind: 'changesSync',
    sessionId: 's1',
    records: [],
  });
  // records 非数组 / 缺 sessionId → null
  assert.equal(buildChangesSyncMessage({ sessionId: 's1', records: 'x' }), null);
  assert.equal(buildChangesSyncMessage({ records: [] }), null);
});

test('buildChangesSyncMessage 仅 path 或仅 absPath 时互相兜底', () => {
  const onlyPath = buildChangesSyncMessage({ sessionId: 's1', records: [{ callId: 'c1', path: 'a.ts' }] });
  assert.ok(onlyPath !== null);
  assert.equal(onlyPath.records[0].path, 'a.ts');
  assert.equal(onlyPath.records[0].absPath, 'a.ts');
  const onlyAbs = buildChangesSyncMessage({ sessionId: 's1', records: [{ callId: 'c1', absPath: 'D:/a.ts' }] });
  assert.ok(onlyAbs !== null);
  assert.equal(onlyAbs.records[0].path, 'D:/a.ts');
});

test('buildCheckpointsReadyMessage 要求 ok 为布尔', () => {
  assert.deepEqual(buildCheckpointsReadyMessage({ ok: true, sessionId: 's1' }), {
    kind: 'checkpointsReady',
    ok: true,
    sessionId: 's1',
  });
  assert.deepEqual(buildCheckpointsReadyMessage({ ok: false, error: 'WORKSPACE_IN_USE' }), {
    kind: 'checkpointsReady',
    ok: false,
    error: 'WORKSPACE_IN_USE',
  });
  assert.equal(buildCheckpointsReadyMessage({ sessionId: 's1' }), null);
  assert.equal(buildCheckpointsReadyMessage({ ok: 'yes' }), null);
});

test('buildBridgeUplinkMessage 只放行白名单 kind', () => {
  // 白名单内：分发到对应构造器
  assert.deepEqual(buildBridgeUplinkMessage({ kind: 'sessionState', payload: { sessionId: 's1', running: true } }), {
    kind: 'sessionState',
    sessionId: 's1',
    running: true,
    pending: 0,
    turn: 0,
  });
  assert.equal(buildBridgeUplinkMessage({ kind: 'checkpointsReady', payload: { ok: true } })?.kind, 'checkpointsReady');
  // 白名单外 / 形状非法 → null（静默丢弃，不抛）
  assert.equal(buildBridgeUplinkMessage({ kind: 'diffApplied', payload: { path: 'a.ts' } }), null);
  assert.equal(buildBridgeUplinkMessage({ kind: 'unknownKind', payload: {} }), null);
  assert.equal(buildBridgeUplinkMessage(null), null);
  assert.equal(buildBridgeUplinkMessage({ kind: 'sessionState' }), null); // 缺 payload
});

test('parseQuickEditSubmit 校验路径与行号（F11 下行）', () => {
  assert.deepEqual(
    parseQuickEditSubmit({ kind: 'quickEditSubmit', path: 'D:/a.ts', startLine: 12, endLine: 14, instruction: '改成防抖' }),
    {
      kind: 'quickEditSubmit',
      path: 'D:/a.ts',
      startLine: 12,
      endLine: 14,
      instruction: '改成防抖',
    },
  );
  // 空指令合法（是否拦截由扩展侧决定）
  assert.ok(parseQuickEditSubmit({ kind: 'quickEditSubmit', path: 'a.ts', startLine: 1, endLine: 1, instruction: '' }) !== null);
  // 缺行号 / 行号非数字 / 缺 path → null
  assert.equal(parseQuickEditSubmit({ kind: 'quickEditSubmit', path: 'a.ts', instruction: 'x' }), null);
  assert.equal(parseQuickEditSubmit({ kind: 'quickEditSubmit', path: 'a.ts', startLine: '1', endLine: 2, instruction: 'x' }), null);
  assert.equal(parseQuickEditSubmit({ kind: 'quickEditSubmit', startLine: 1, endLine: 2, instruction: 'x' }), null);
  // kind 不符 → null（防止被其它下行消息误收）
  assert.equal(parseQuickEditSubmit({ path: 'a.ts', startLine: 1, endLine: 2, instruction: 'x' }), null);
});

test('parseApprovalDecision 只接受两种结果（不支持"总是允许"）', () => {
  assert.deepEqual(parseApprovalDecision({ kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' }), {
    kind: 'approvalDecision',
    sessionId: 's1',
    approvalId: 'a1',
    outcome: 'allowed-once',
  });
  assert.equal(
    parseApprovalDecision({ kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'rejected' })?.outcome,
    'rejected',
  );
  // 载荷不支持的 outcome / 缺字段 / kind 不符 → null
  assert.equal(parseApprovalDecision({ kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'always' }), null);
  assert.equal(parseApprovalDecision({ kind: 'approvalDecision', approvalId: 'a1', outcome: 'rejected' }), null);
  assert.equal(parseApprovalDecision({ sessionId: 's1', approvalId: 'a1', outcome: 'rejected' }), null);
});

test('parseQuestionAnswer / parseRequestChanges / parseInjectComposer 校验', () => {
  assert.deepEqual(parseQuestionAnswer({ kind: 'questionAnswer', sessionId: 's1', questionId: 'q1', answer: { id: 'x' } }), {
    kind: 'questionAnswer',
    sessionId: 's1',
    questionId: 'q1',
    answer: { id: 'x' },
  });
  // answer 为空视为未答（载荷里必须是对象/数组）
  assert.equal(parseQuestionAnswer({ kind: 'questionAnswer', sessionId: 's1', questionId: 'q1', answer: null }), null);
  assert.equal(parseQuestionAnswer({ kind: 'questionAnswer', sessionId: 's1', answer: 'x' }), null);
  // requestChanges：只取 sessionId，多余字段不透传
  assert.deepEqual(parseRequestChanges({ kind: 'requestChanges', sessionId: 's1', extra: 'ignored' }), {
    kind: 'requestChanges',
    sessionId: 's1',
  });
  assert.equal(parseRequestChanges({}), null);
  // injectComposer：Add to DSH 既有通道纳入统一分发
  assert.deepEqual(parseInjectComposer({ kind: 'injectComposer', text: '@E:/a.ts' }), {
    kind: 'injectComposer',
    text: '@E:/a.ts',
  });
  assert.equal(parseInjectComposer({ kind: 'injectComposer' }), null);
});

test('parseDownlinkMessage 统一分发，且不把非法消息错投给其它分支（bug 回归）', () => {
  // 各 kind 正确归位
  assert.equal(parseDownlinkMessage({ kind: 'injectComposer', text: 'x' })?.kind, 'injectComposer');
  assert.equal(parseDownlinkMessage({ kind: 'quickEditSubmit', path: 'a.ts', startLine: 1, endLine: 2, instruction: 'x' })?.kind, 'quickEditSubmit');
  assert.equal(parseDownlinkMessage({ kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' })?.kind, 'approvalDecision');
  assert.equal(parseDownlinkMessage({ kind: 'questionAnswer', sessionId: 's1', questionId: 'q1', answer: {} })?.kind, 'questionAnswer');
  assert.equal(parseDownlinkMessage({ kind: 'requestChanges', sessionId: 's1' })?.kind, 'requestChanges');
  // 回归：非法 outcome 的审批决策必须整体丢弃，绝不能落进 requestChanges（只校验 sessionId 时的真实缺陷）
  assert.equal(parseDownlinkMessage({ kind: 'approvalDecision', sessionId: 's1', approvalId: 'a1', outcome: 'always' }), null);
  // 未知 kind / 非对象 → null
  assert.equal(parseDownlinkMessage({ kind: 'nope', sessionId: 's1' }), null);
  assert.equal(parseDownlinkMessage(null), null);
});
