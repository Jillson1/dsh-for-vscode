// test/changes/change-navigation.test.ts — F2 导航装配层单测（依赖全部注入假实现）
// 覆盖：无活动文件 / 无变更 / 正常推进与环绕 / 计数与状态栏 / 换文件后游标作废 / 锚点失效。
// 这一层的价值在于"决策 + 交互顺序"：先 reveal 再写计数、换文件重置游标、找不到锚点时不乱跳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeBook } from '../../src/bridge/change-book';
import { ChangeNavigator } from '../../src/changes/change-navigation';

/** 构造一个已记录两处变更的账本：文件内容里含 "b" 与 "d"（= 第 2、4 行） */
function bookWithTwoChanges(): ChangeBook {
  const book = new ChangeBook();
  book.add({
    callId: 'c1',
    sessionId: 's1',
    absPath: 'D:/w/a.ts',
    oldText: 'x',
    newText: 'b',
    tool: 'edit',
    time: 1000,
  });
  book.add({
    callId: 'c2',
    sessionId: 's1',
    absPath: 'D:/w/a.ts',
    oldText: 'y',
    newText: 'd',
    tool: 'edit',
    time: 2000,
  });
  return book;
}

/** 组装导航器 + 可观察的行为记录 */
function makeNav(book: ChangeBook, options: { content?: string; noEditor?: boolean; enabled?: boolean } = {}) {
  const revealed: { path: string; line: number }[] = [];
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const content = options.content ?? 'a\nb\nc\nd\n';
  const nav = new ChangeNavigator({
    book,
    activeEditor: () =>
      options.noEditor === true ? undefined : { fsPath: 'D:/w/a.ts', getText: () => content },
    reveal: async (path, line) => {
      revealed.push({ path, line });
    },
    readFileText: async () => content,
    status: (text) => statuses.push(text),
    notify: (m) => notices.push(m),
    log: (m) => logs.push(m),
    enabled: () => options.enabled ?? true,
  });
  return { nav, revealed, statuses, notices, logs };
}

test('无活动编辑器 → 提示用户，不写状态栏', async () => {  const { nav, revealed, statuses, notices } = makeNav(bookWithTwoChanges(), { noEditor: true });
  await nav.next();
  assert.deepEqual(revealed, []);
  assert.deepEqual(statuses, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0] as string, /先打开一个文件/);
});

test('当前文件没有 DSH 变更 → 清除状态栏并提示', async () => {
  const { nav, revealed, statuses, notices } = makeNav(new ChangeBook());
  await nav.next();
  assert.deepEqual(revealed, []);
  assert.deepEqual(statuses, [undefined]);
  assert.match(notices[0] as string, /没有 DSH 变更/);
});

test('next 依次停在每一处变更行并给出 1/N … N/N 计数', async () => {
  const { nav, revealed, statuses } = makeNav(bookWithTwoChanges());
  await nav.next();
  await nav.next();
  await nav.next(); // 环绕
  assert.deepEqual(revealed, [
    { path: 'D:/w/a.ts', line: 2 },
    { path: 'D:/w/a.ts', line: 4 },
    { path: 'D:/w/a.ts', line: 2 },
  ]);
  assert.deepEqual(statuses, ['1/2', '2/2', '1/2']);
});

test('prev 从最后一处往上游走，并在开头环绕到末处', async () => {
  const { nav, revealed, statuses } = makeNav(bookWithTwoChanges());
  await nav.prev();
  await nav.prev();
  await nav.prev();
  assert.deepEqual(revealed, [
    { path: 'D:/w/a.ts', line: 4 },
    { path: 'D:/w/a.ts', line: 2 },
    { path: 'D:/w/a.ts', line: 4 },
  ]);
  assert.deepEqual(statuses, ['2/2', '1/2', '2/2']);
});

test('锚点失效（newText 已不在文件里）→ 不跳转、提示原因、清状态栏', async () => {
  const book = bookWithTwoChanges();
  const { nav, revealed, statuses, notices } = makeNav(book, { content: 'zzz\n' });
  await nav.next();
  assert.deepEqual(revealed, []);
  assert.deepEqual(statuses, [undefined]);
  assert.match(notices[0] as string, /已不在当前内容里/);
});

test('游标跨文件作废：换文件后从头开始（不是延续上一个文件的位置）', async () => {
  const book = bookWithTwoChanges();
  const revealed: { path: string; line: number }[] = [];
  const statuses: (string | undefined)[] = [];
  let current = { fsPath: 'D:/w/a.ts', getText: () => 'a\nb\nc\nd\n' };
  const nav = new ChangeNavigator({
    book,
    activeEditor: () => current,
    reveal: async (path, line) => {
      revealed.push({ path, line });
    },
    readFileText: async () => current.getText(),
    status: (t) => statuses.push(t),
    notify: () => {},
  });
  await nav.next(); // a.ts:2
  // 切到另一个也有记录的文件
  book.add({ callId: 'c3', sessionId: 's1', absPath: 'D:/w/b.ts', oldText: 'p', newText: 'q', tool: 'edit' });
  current = { fsPath: 'D:/w/b.ts', getText: () => 'p\nq\n' };
  await nav.next();
  await nav.next();
  assert.deepEqual(revealed, [
    { path: 'D:/w/a.ts', line: 2 },
    { path: 'D:/w/b.ts', line: 2 },
    { path: 'D:/w/b.ts', line: 2 },
  ]);
  assert.deepEqual(statuses, ['1/2', '1/1', '1/1']);
});

test('clearCursor 清除状态栏；linesForActiveFile 暴露当前文件的可游走行号', async () => {
  const { nav, statuses } = makeNav(bookWithTwoChanges());
  const info = await nav.linesForActiveFile();
  assert.deepEqual(info, { path: 'D:/w/a.ts', lines: [2, 4] });
  nav.clearCursor();
  assert.deepEqual(statuses, [undefined]);
});

test('变更集总开关关闭：next/prev 静默 no-op（不跳转、不写状态栏、不弹提示）', async () => {
  const { nav, revealed, statuses, notices } = makeNav(bookWithTwoChanges(), { enabled: false });
  await nav.next();
  await nav.prev();
  assert.deepEqual(revealed, [], '关闭后不应跳转');
  assert.deepEqual(statuses, [], '关闭后不应写状态栏（包括清除）');
  assert.deepEqual(notices, [], '关闭后不应弹"没有 DSH 变更"这类提示——用户已经明确关掉了');
});

test('变更集总开关开启：行为不受影响（对照组，防止门控写反）', async () => {
  const { nav, revealed } = makeNav(bookWithTwoChanges(), { enabled: true });
  await nav.next();
  assert.equal(revealed.length, 1);
});
