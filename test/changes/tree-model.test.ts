// test/changes/tree-model.test.ts — F3 `DSH Changes` 树的纯模型单测
// 覆盖：会话 → 文件 → 变更的分组与排序、文案（新增/删除/修改 + 增删计数 + 时间）、
// stale 标注（含"哈希未知不误标"）、会话 id 截断、空账本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeBook, contentHash } from '../../src/bridge/change-book';
import {
  buildTree,
  fileViews,
  changeNodeView,
  natureVerb,
  formatClock,
  shortSessionId,
} from '../../src/changes/tree-model';
import type { ChangeRecord } from '../../src/bridge/change-book';

/** 造一条记录（默认：修改一处） */
function rec(over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    callId: 'c1',
    sessionId: 's1',
    turn: 0,
    tool: 'edit',
    path: 'src/a.ts',
    absPath: 'D:/w/src/a.ts',
    oldText: 'old',
    newText: 'new',
    time: 1700000000000,
    source: 'relay',
    fileHashAtRecord: '',
    ...over,
  };
}

test('natureVerb / formatClock / shortSessionId', () => {
  assert.equal(natureVerb('add'), '新增');
  assert.equal(natureVerb('del'), '删除');
  assert.equal(natureVerb('modify'), '修改');

  const t = new Date(2026, 0, 2, 9, 5).getTime();
  assert.equal(formatClock(t), '09:05');

  assert.equal(shortSessionId('short'), 'short');
  const long = 'session-6207b153-9bc6-4caf-a7ae-1a8fe739ae8b';
  assert.equal(shortSessionId(long), 'session-…ae8b');
});

test('changeNodeView：修改 / 新增 / 删除的标签与计数', () => {
  // 替换一行 → 修改 +1 −1
  const modify = changeNodeView(rec({ oldText: 'a', newText: 'b' }), undefined);
  assert.equal(modify.nature, 'modify');
  assert.equal(modify.label, '修改 +1 −1');
  assert.equal(modify.description, formatClock(1700000000000));

  // 纯新增：不显示 −0
  const add = changeNodeView(rec({ oldText: '', newText: 'b' }), undefined);
  assert.equal(add.nature, 'add');
  assert.equal(add.label, '新增 +1');

  // 纯删除：不显示 +0
  const del = changeNodeView(rec({ oldText: 'a\nb', newText: '' }), undefined);
  assert.equal(del.nature, 'del');
  assert.equal(del.label, '删除 −2');
});

test('changeNodeView：stale 只在"记录时哈希 ≠ 当前哈希"时标注，哈希未知不误标', () => {
  const withHash = rec({ fileHashAtRecord: contentHash('hello') });
  assert.equal(changeNodeView(withHash, contentHash('hello')).stale, false);
  const stale = changeNodeView(withHash, contentHash('changed'));
  assert.equal(stale.stale, true);
  assert.match(stale.description, /文件已被外部修改/);
  // 记录时哈希未知（旧记录 / 读盘失败）→ 不标
  assert.equal(changeNodeView(rec({ fileHashAtRecord: '' }), contentHash('x')).stale, false);
  // 当前哈希未知（文件读不到）→ 不标
  assert.equal(changeNodeView(withHash, undefined).stale, false);
});

test('fileViews：按路径分组、按时间升序、stale 计数', () => {
  const hashA = contentHash('now-a');
  const views = fileViews(
    [
      rec({ callId: 'c2', time: 200, absPath: 'D:/w/src/a.ts', path: 'src/a.ts', fileHashAtRecord: contentHash('old-a') }),
      rec({ callId: 'c1', time: 100, absPath: 'D:/w/src/a.ts', path: 'src/a.ts', fileHashAtRecord: hashA }),
      rec({ callId: 'c3', time: 300, absPath: 'D:/w/src/b.ts', path: 'src/b.ts', fileHashAtRecord: 'x' }),
    ],
    new Map([
      ['D:/w/src/a.ts', hashA],
      ['D:/w/src/b.ts', hashA],
    ]),
  );
  assert.deepEqual(
    views.map((v) => v.path),
    ['src/a.ts', 'src/b.ts'],
  );
  // 文件内按 time 升序：c1(100) 在前
  assert.deepEqual(
    views[0]?.changes.map((c) => c.callId),
    ['c1', 'c2'],
  );
  // a.ts 里 c2 的哈希对不上 → 1 处 stale
  assert.equal(views[0]?.staleCount, 1);
  assert.equal(views[1]?.staleCount, 1);
});

test('buildTree：会话分组 + 计数描述 + 稳定排序', () => {
  const book = new ChangeBook();
  book.add({ callId: 'c1', sessionId: 'session-long-id-aaaa', absPath: 'D:/w/src/a.ts', path: 'src/a.ts', oldText: 'x', newText: 'y', time: 100 });
  book.add({ callId: 'c2', sessionId: 'session-long-id-aaaa', absPath: 'D:/w/src/b.ts', path: 'src/b.ts', oldText: 'x', newText: 'y', time: 200 });
  book.add({ callId: 'c3', sessionId: 'other', absPath: 'D:/w/src/c.ts', path: 'src/c.ts', oldText: 'x', newText: 'y', time: 300 });

  const tree = buildTree(book);
  assert.equal(tree.length, 2);
  // 会话升序（'other' < 'session-…'）
  assert.equal(tree[0]?.sessionId, 'other');
  assert.equal(tree[1]?.sessionId, 'session-long-id-aaaa');
  assert.equal(tree[1]?.label, 'session-…aaaa');
  assert.equal(tree[1]?.description, '2 文件 · 2 处变更');
  assert.equal(tree[1]?.changeCount, 2);
  assert.deepEqual(
    tree[1]?.files.map((f) => f.path),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('buildTree：空账本 → 空树（视图显示空态，而不是一个空会话节点）', () => {
  assert.deepEqual(buildTree(new ChangeBook()), []);
});

test('buildTree：一个会话里同一文件多处变更只产生一个文件节点', () => {
  const book = new ChangeBook();
  for (let i = 0; i < 3; i += 1) {
    book.add({
      callId: `c${i}`,
      sessionId: 's1',
      absPath: 'D:/w/src/a.ts',
      path: 'src/a.ts',
      oldText: `old${i}`,
      newText: `new${i}`,
      time: 100 + i,
    });
  }
  const tree = buildTree(book);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.files.length, 1);
  assert.equal(tree[0]?.files[0]?.changes.length, 3);
});
