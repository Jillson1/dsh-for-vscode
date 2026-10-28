// test/addToDsh.test.ts — Add to DSH 命令的纯逻辑单元测试
// 覆盖 selectionRangeText 的行号拼接（1-based）与 dispatch 的"投递 → 结局"。
//
// 面板状态（可见 / 自动打开 / 握手等待）**不在这里测**：那属于 extension.ts 的 postToPanelDsh。
// 本模块只接收一个注入器，策略可被完全替换——这正是把"文本构造"与"面板投递"分开的理由。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionRangeText, dispatch } from '../src/addToDsh';

/** 最小 TextDocument 桩（selectionRangeText 只用 uri.fsPath） */
function doc(path: string): { uri: { fsPath: string } } {
  return { uri: { fsPath: path } };
}

/** 构造一个 0-based 选区桩 */
function sel(startLine: number, endLine: number): { start: { line: number }; end: { line: number } } {
  return { start: { line: startLine }, end: { line: endLine } };
}

test('selectionRangeText 单行选区 → @路径（无行号）', () => {
  const text = selectionRangeText(doc('C:\\proj\\a.ts') as never, sel(4, 4) as never);
  assert.equal(text, '@C:\\proj\\a.ts');
});

test('selectionRangeText 多行选区 → @路径:起始-结束（1-based）', () => {
  // 0-based 行 149..155 → 1-based 150..156
  const text = selectionRangeText(doc('C:\\proj\\PagePreviewOverlay.vue') as never, sel(149, 155) as never);
  assert.equal(text, '@C:\\proj\\PagePreviewOverlay.vue:150-156');
});

test('selectionRangeText 反向选区（光标在上）仍取最小-最大', () => {
  // 0-based 155..149 → 1-based 150..156（与正向一致）
  const text = selectionRangeText(doc('C:\\proj\\b.ts') as never, sel(155, 149) as never);
  assert.equal(text, '@C:\\proj\\b.ts:150-156');
});

test('dispatch 注入成功 → 返回 true，注入器收到原文', async () => {
  const seen: string[] = [];
  const ok = await dispatch(async (text) => {
    seen.push(text);
    return true;
  }, '@a.ts:12-14');
  assert.equal(ok, true);
  assert.deepEqual(seen, ['@a.ts:12-14']);
});

test('dispatch 注入器返回 false（面板打不开/未就绪）→ 返回 false，且不自行重试', async () => {
  let calls = 0;
  const ok = await dispatch(async () => {
    calls += 1;
    return false;
  }, '@a.ts');
  assert.equal(ok, false);
  // 打开与等待失败后的重试语义属于 postToPanelDsh；这里只负责如实反映结局
  assert.equal(calls, 1, '失败后不应在 dispatch 层重复投递');
});
