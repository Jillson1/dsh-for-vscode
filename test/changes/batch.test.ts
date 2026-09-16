// test/changes/batch.test.ts — F4 批量处置纯逻辑单测
// 覆盖：入口实参归一（右键单选/多选/命令面板回落）、目标去重、结果汇总文案（含原因分布）、
// 作用域计数。批量最怕"笼统报成功"，因此文案断言是这里的重点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNodes,
  targetsFromNodes,
  summarizeOutcomes,
  summarizeKept,
  countForScope,
} from '../../src/changes/batch';
import { ChangeBook, type RevertOutcome } from '../../src/bridge/change-book';

test('normalizeNodes：单选节点 / 多选数组 / 非节点实参回落树选择', () => {
  const change = { kind: 'change', sessionId: 's1', callId: 'c1', absPath: 'D:/w/a.ts' };
  const file = { kind: 'file', sessionId: 's1', absPath: 'D:/w/a.ts' };
  assert.deepEqual(normalizeNodes(change), [change]);
  assert.deepEqual(normalizeNodes([change, file]), [change, file]);
  // 命令面板传 undefined、视图标题按钮传 view 对象 → 回落到 treeView.selection
  assert.deepEqual(normalizeNodes(undefined, [file]), [file]);
  assert.deepEqual(normalizeNodes({ viewId: 'dsh.changes' }, [file]), [file]);
  // 既没有实参也没有选择 → 空（调用方走"没有需要处理的变更"分支）
  assert.deepEqual(normalizeNodes(undefined, []), []);
  // 数组里的杂质被过滤
  assert.deepEqual(normalizeNodes([change, null, 'x', { kind: 'other' }]), [change]);
});

test('targetsFromNodes：按粒度去重，层级顺序稳定（会话 → 文件 → 变更）', () => {
  const targets = targetsFromNodes([
    { kind: 'change', sessionId: 's1', callId: 'c1', absPath: 'D:/w/a.ts' },
    { kind: 'file', sessionId: 's1', absPath: 'D:/w/a.ts' },
    { kind: 'file', sessionId: 's1', absPath: 'D:/w/a.ts' }, // 重复
    { kind: 'session', sessionId: 's1' },
    { kind: 'session', sessionId: 's1' }, // 重复
    { kind: 'session', sessionId: 's2' },
  ]);
  assert.deepEqual(targets, [
    { scope: 'session', sessionId: 's1' },
    { scope: 'session', sessionId: 's2' },
    { scope: 'file', sessionId: 's1', absPath: 'D:/w/a.ts' },
    { scope: 'change', sessionId: 's1', callId: 'c1', absPath: 'D:/w/a.ts' },
  ]);
});

test('targetsFromNodes：缺关键字段的节点被忽略（不产生半个目标）', () => {
  assert.deepEqual(
    targetsFromNodes([
      { kind: 'session' }, // 缺 sessionId
      { kind: 'file', sessionId: 's1' }, // 缺 absPath
      { kind: 'change', sessionId: 's1', absPath: 'D:/w/a.ts' }, // 缺 callId
    ]),
    [],
  );
});

test('summarizeOutcomes：全成功 / 部分失败 / 全失败 / 空集，文案带失败原因分布', () => {
  const ok: RevertOutcome = { status: 'reverted' };
  const anchor: RevertOutcome = { status: 'anchor-missing', reason: 'newText no longer in file' };

  assert.deepEqual(summarizeOutcomes([]), {
    ok: 0,
    failed: 0,
    byStatus: {},
    text: '没有需要处理的变更',
  });
  assert.deepEqual(summarizeOutcomes([ok, ok]).text, '已处理 2 处变更');

  const partial = summarizeOutcomes([ok, anchor, anchor, { status: 'refused', reason: 'unsafe' }]);
  assert.equal(partial.ok, 1);
  assert.equal(partial.failed, 3);
  assert.deepEqual(partial.byStatus, { 'anchor-missing': 2, refused: 1 });
  // 关键：文案必须同时给出成功数、失败数与**原因分布**（不能只说"失败 3 条"）
  assert.match(partial.text, /成功 1，失败 3/);
  assert.match(partial.text, /原内容已找不到（文件被改过） ×2/);
  assert.match(partial.text, /出于安全拒绝执行 ×1/);

  // 已知的兜底状态有中文标签
  assert.match(summarizeOutcomes([{ status: 'failed', reason: 'io' }]).text, /执行失败 ×1/);
  // 真正未知的状态直接透传枚举名（不吞掉信息）
  assert.match(
    summarizeOutcomes([{ status: 'some-future-status', reason: 'x' } as unknown as RevertOutcome]).text,
    /some-future-status ×1/,
  );
});

test('summarizeKept：请求数与实际保留数都给出来', () => {
  assert.equal(summarizeKept(0, 0), '没有需要保留的变更');
  assert.equal(summarizeKept(3, 3), '已保留 3 处变更');
  assert.equal(summarizeKept(3, 1), '已保留 1/3 处（其余记录已不存在）');
});

test('countForScope：三种粒度的记录数（用于"先算再动手"）', () => {
  const book = new ChangeBook();
  book.add({ callId: 'c1', sessionId: 's1', absPath: 'D:/w/a.ts', oldText: 'x', newText: 'y' });
  book.add({ callId: 'c2', sessionId: 's1', absPath: 'D:/w/a.ts', oldText: 'x', newText: 'y' });
  book.add({ callId: 'c3', sessionId: 's1', absPath: 'D:/w/b.ts', oldText: 'x', newText: 'y' });

  assert.equal(countForScope(book, { scope: 'session', sessionId: 's1' }), 3);
  assert.equal(countForScope(book, { scope: 'file', sessionId: 's1', absPath: 'D:/w/a.ts' }), 2);
  assert.equal(countForScope(book, { scope: 'change', sessionId: 's1', callId: 'c3', absPath: 'D:/w/b.ts' }), 1);
  assert.equal(countForScope(book, { scope: 'change', sessionId: 's1', callId: 'nope', absPath: 'D:/w/b.ts' }), 0);
});
