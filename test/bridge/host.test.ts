// test/bridge/host.test.ts — 桥接消息处理与路径解析单测
// 覆盖：resolveBridgePath 的绝对/相对/危险协议分支；handleBridgeMessage 的外链白名单
// 转发、危险协议拒绝、文件跳转路径解析、打开失败与路径无法解析的用户提示。
// 生产侧接 vscode API，这里注入假实现验证纯逻辑（showWarning 一并注入以断言提示文案）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBridgePath, computeLineByText, handleBridgeMessage } from '../../src/bridge/host';
test('resolveBridgePath 处理绝对/相对/危险协议', () => {
  // 绝对路径直接采用（忽略 cwd 与工作区根）
  assert.deepEqual(resolveBridgePath('/a/b.ts', undefined, '/proj'), { kind: 'abs', path: '/a/b.ts' });
  // 相对路径优先按会话 cwd 解析（工作区根不同也不影响）
  assert.deepEqual(resolveBridgePath('src/main.ts', '/proj', '/other'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 会话 cwd 缺失时回退工作区根
  assert.deepEqual(resolveBridgePath('src/main.ts', undefined, '/proj'), { kind: 'abs', path: '/proj/src/main.ts' });
  // 无任何基准的相对路径：无法解析
  assert.deepEqual(resolveBridgePath('..\\evil.ts', undefined, undefined), { kind: 'invalid' });
  // 协议串（URL）：一律拒绝
  assert.deepEqual(resolveBridgePath('https://x.com/a', undefined, '/proj'), { kind: 'invalid' });
});

test('handleBridgeMessage 转发 openExternal 到外部浏览器', async () => {
  // 记录被转发的 URL，验证 http/https 外链原样透传
  const calls: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b' }, {
    openExternal: async (u) => { calls.push(u); return true; },
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: () => {},
  });
  assert.deepEqual(calls, ['https://a.b']);
});

test('handleBridgeMessage 拒绝危险协议的 openExternal', async () => {
  // javascript: 协议不允许走 openExternal（纵深防御，即使桥接侧已过滤）
  let called = false;
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'javascript:alert(1)' }, {
    openExternal: async () => { called = true; return true; },
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: () => {},
  });
  assert.equal(called, false);
});

test('handleBridgeMessage openExternal 抛错时提示用户', async () => {
  // 假 openExternal 抛错 → 应调用 showWarning（文案含 URL 与错误摘要），且不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenExternal', url: 'https://a.b/c' }, {
    openExternal: async () => { throw new Error('no default browser'); },
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: (m) => { warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://a.b/c'), `提示应含链接，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('no default browser'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 调用打开文档', async () => {
  // 相对路径 + cwd → 解析为绝对路径后交给 openTextDocument
  const opened: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'src/main.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: () => {},
    workspaceRoot: '/proj',
  });
  assert.deepEqual(opened, ['/proj/src/main.ts']);
});

test('handleBridgeMessage openFile 带 line 时打开后跳行', async () => {
  // edit 场景：line 存在 → 打开文档后调用 revealLine 定位到 1-based 行
  const opened: string[] = [];
  const revealed: { p: string; line: number }[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/proj/a.ts', line: 42 }, {
    openExternal: async () => true,
    openTextDocument: async (p) => { opened.push(p); },
    readFileText: async () => '',
    revealLine: async (p, line) => { revealed.push({ p, line }); },
    showWarning: () => {},
  });
  assert.deepEqual(opened, ['/proj/a.ts']);
  assert.deepEqual(revealed, [{ p: '/proj/a.ts', line: 42 }]);
});

test('handleBridgeMessage openFile 带非法 line 时不跳行', async () => {
  // line 为 0 或负数：不应调用 revealLine（只打开文件）
  let revealed = 0;
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/proj/a.ts', line: 0 }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => { revealed += 1; },
    showWarning: () => {},
  });
  assert.equal(revealed, 0);
});

test('handleBridgeMessage openFile 跳行失败时提示用户', async () => {
  // 文件能打开但 revealLine 抛错 → 提示定位失败，不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/proj/a.ts', line: 999 }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => { throw new Error('out of range'); },
    showWarning: (m) => { warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('999'), `提示应含行号，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('out of range'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 打开失败时提示用户', async () => {
  // 假 openTextDocument 抛错（非"文件不存在"类）→ 应调用 showWarning，文案含解析后的路径与错误摘要
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'missing.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async () => { throw new Error('EACCES: permission denied'); },
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('/proj/missing.ts'), `提示应含路径，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('EACCES'), `提示应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 文件不存在时提示"未创建/未落盘"而非路径错误', async () => {
  // write 新建场景文件可能未落盘：错误指向文件不存在 → 应提示"文件不存在（可能尚未创建或未落盘）"
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'new-script.cjs', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async () => { throw new Error('Unable to resolve nonexistent file \'e:\\proj\\new-script.cjs\''); },
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('文件不存在'), `应提示文件不存在，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('可能尚未创建或未落盘'), `应提示未落盘原因，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 非"文件不存在"错误仍提示原始摘要', async () => {
  // 权限等非缺失错误 → 保留"无法打开文件 + 错误摘要"文案
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'locked.ts', cwd: '/proj' }, {
    openExternal: async () => true,
    openTextDocument: async () => { throw new Error('EACCES: permission denied'); },
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('无法打开文件'), `应保留打开失败文案，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('EACCES'), `应含错误摘要，实际：${warnings[0]}`);
});

test('handleBridgeMessage openFile 路径无法解析时提示用户', async () => {
  // 危险协议（无基准可解析）→ invalid 分支应调用 showWarning（替代原 vscode 硬编码告警）
  const warnings: string[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: 'https://x.com/a' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    showWarning: (m) => { warnings.push(m); },
    workspaceRoot: '/proj',
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('https://x.com/a'), `提示应含原始路径，实际：${warnings[0]}`);
});

test('computeLineByText 在内容中定位改前片段起始行', () => {
  // 多行内容：片段在第 2 行 → 返回 2（1-based）
  const content = 'line one\nline two\nline three\n';
  assert.equal(computeLineByText(content, 'line two'), 2);
  // 片段跨行
  assert.equal(computeLineByText('a\nb\nc\nd\n', 'b\nc'), 2);
  // 片段不在内容中（文件已被后续修改）→ undefined
  assert.equal(computeLineByText(content, 'missing'), undefined);
  // 空片段 / 非字符串 → undefined
  assert.equal(computeLineByText(content, ''), undefined);
  assert.equal(computeLineByText(content, '' as string), undefined);
});

test('handleBridgeMessage openFile 带 oldText 时读文件定位行号并跳行', async () => {
  // edit 场景：无 line 但有 oldText → 读文件内容 indexOf 定位，revealLine 跳到对应行
  const revealed: { p: string; line: number }[] = [];
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/proj/a.ts', oldText: 'const x = 1' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => 'line1\nline2\nconst x = 1\nline4\n',
    revealLine: async (p, line) => { revealed.push({ p, line }); },
    showWarning: () => {},
  });
  assert.deepEqual(revealed, [{ p: '/proj/a.ts', line: 3 }]);
});

test('handleBridgeMessage openFile 带 oldText 但内容不匹配时不跳行', async () => {
  // oldText 在文件里找不到（文件已被后续修改）→ 只打开文件，不跳行、不提示
  let revealed = 0;
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/proj/a.ts', oldText: 'gone' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => 'new content\n',
    revealLine: async () => { revealed += 1; },
    showWarning: () => {},
  });
  assert.equal(revealed, 0);
});

test('handleBridgeMessage openFile 带 oldText 但读文件失败时只打开不跳行', async () => {
  // 读文件失败（权限/IO）→ 不跳行，不弹错误（文件已成功打开）
  let revealed = 0;
  await handleBridgeMessage({ type: 'bridgeOpenFile', path: '/proj/a.ts', oldText: 'x' }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => { throw new Error('EACCES'); },
    revealLine: async () => { revealed += 1; },
    showWarning: () => {},
  });
  assert.equal(revealed, 0);
});

test('handleBridgeMessage diffApplied 转发给 recordDiff', async () => {
  // A 组：edit/write 落盘后广播 applied diff → 调用 recordDiff（含解析后的路径与 hunks）
  const recorded: unknown[] = [];
  await handleBridgeMessage({
    type: 'bridgeDiffApplied',
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [{ oldText: 'const x = 1', newText: 'const x = 2' }],
    callId: 'c-1',
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    recordDiff: async (d) => { recorded.push(d); },
    showWarning: () => {},
    workspaceRoot: '/proj',
  });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [{ oldText: 'const x = 1', newText: 'const x = 2' }],
    callId: 'c-1',
  });
});

test('handleBridgeMessage diffApplied 过滤畸形 hunk', async () => {
  // oldText 为空 / newText 缺失的 hunk 应被过滤：全部畸形 → 不调用 recordDiff
  let recorded = 0;
  await handleBridgeMessage({
    type: 'bridgeDiffApplied',
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [
      { oldText: '', newText: 'x' },
      { oldText: 'y', newText: '' },
      null as unknown as { oldText: string; newText: string },
    ],
    callId: 'c-2',
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    recordDiff: async () => { recorded += 1; },
    showWarning: () => {},
    workspaceRoot: '/proj',
  });
  assert.equal(recorded, 0);
});

test('handleBridgeMessage diffApplied 空 diffs 时不调用 recordDiff', async () => {
  let recorded = 0;
  await handleBridgeMessage({
    type: 'bridgeDiffApplied',
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [],
    callId: 'c-3',
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    recordDiff: async () => { recorded += 1; },
    showWarning: () => {},
  });
  assert.equal(recorded, 0);
});

test('handleBridgeMessage diffApplied recordDiff 抛错时提示用户', async () => {
  // 读文件 IO 失败等：提示"无法记录修改"，不抛未处理异常
  const warnings: string[] = [];
  await handleBridgeMessage({
    type: 'bridgeDiffApplied',
    path: '/proj/a.ts',
    diffs: [{ oldText: 'x', newText: 'y' }],
    callId: 'c-4',
  }, {
    openExternal: async () => true,
    openTextDocument: async () => {},
    readFileText: async () => '',
    revealLine: async () => {},
    recordDiff: async () => { throw new Error('EIO'); },
    showWarning: (m) => { warnings.push(m); },
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('/proj/a.ts'), `提示应含路径，实际：${warnings[0]}`);
  assert.ok(warnings[0].includes('EIO'), `提示应含错误摘要，实际：${warnings[0]}`);
});
