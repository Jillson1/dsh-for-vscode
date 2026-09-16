// test/changes/change-code-lens.test.ts — F5 CodeLens 落点计算单测
// 覆盖：按 newText 定位行、同行合并、定位失败跳过、升序输出、超限截断。
// 这些规则决定了"编辑区顶部会不会被按钮挤满"和"按钮会不会出现在错误的行"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lensSpecs, MAX_LENS_RECORDS } from '../../src/changes/change-code-lens';

test('lensSpecs：按 newText 在文档中的行落点，升序输出', () => {
  const content = 'l1\nl2\nl3\nl4\nl5\n';
  const { specs, skipped, truncated } = lensSpecs(
    [
      { callId: 'c-late', newText: 'l4' },
      { callId: 'c-early', newText: 'l2' },
    ],
    content,
  );
  assert.deepEqual(specs, [
    { line: 1, callId: 'c-early', count: 1 },
    { line: 3, callId: 'c-late', count: 1 },
  ]);
  assert.equal(skipped, 0);
  assert.equal(truncated, 0);
});

test('lensSpecs：同行多处改动合并成一组按钮（count 记录条数）', () => {
  const content = 'a\nb\nc\n';
  const { specs } = lensSpecs(
    [
      { callId: 'c1', newText: 'b' },
      { callId: 'c2', newText: 'b' },
    ],
    content,
  );
  assert.equal(specs.length, 1, '同一行只应出一组按钮');
  assert.equal(specs[0]?.count, 2);
  // 保留第一次出现的 callId 作为按钮参数（丢弃/对比走同一处记录）
  assert.equal(specs[0]?.callId, 'c1');
});

test('lensSpecs：定位不到的记录跳过（用户手改过就不再提示"这里改过"）', () => {
  const content = 'a\nb\n';
  const { specs, skipped } = lensSpecs(
    [
      { callId: 'gone', newText: '已被删掉的内容' },
      { callId: 'alive', newText: 'b' },
    ],
    content,
  );
  assert.equal(skipped, 1);
  assert.deepEqual(specs.map((s) => s.callId), ['alive']);
});

test('lensSpecs：超过 limit 截断，并报出剩余条数（编辑区不被挤满）', () => {
  // 300 行文档，每行一处变更
  const lines = Array.from({ length: 300 }, (_, i) => `line-${i}`)
  const content = lines.join('\n')
  const records = lines.map((l, i) => ({ callId: `c${i}`, newText: l }))
  const { specs, truncated } = lensSpecs(records, content, MAX_LENS_RECORDS)
  assert.equal(specs.length, MAX_LENS_RECORDS)
  assert.equal(truncated, 100);
  // 截断保留的是**前 N 处**（阅读顺序从上往下）
  assert.equal(specs[0]?.line, 0);
  assert.equal(specs[specs.length - 1]?.line, MAX_LENS_RECORDS - 1);
});

test('lensSpecs：空记录 / 空文档不抛异常', () => {
  assert.deepEqual(lensSpecs([], 'a\nb\n'), { specs: [], skipped: 0, truncated: 0 });
  assert.deepEqual(lensSpecs([{ callId: 'c1', newText: 'x' }], ''), { specs: [], skipped: 1, truncated: 0 });
});
