// test/addToDsh.test.ts — Add to DSH 命令的纯逻辑单元测试
// 覆盖 selectionRangeText 的行号拼接规则（1-based）与 dispatch 的面板可见性选择。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionRangeText, dispatch, type AddToDshTargets } from '../src/addToDsh';
import type { DshPanelProvider } from '../src/panel/provider';

/** 最小 TextDocument 桩（selectionRangeText 只用 uri.fsPath） */
function doc(path: string): { uri: { fsPath: string } } {
  return { uri: { fsPath: path } };
}

/** 构造一个 0-based 选区桩 */
function sel(startLine: number, endLine: number): { start: { line: number }; end: { line: number } } {
  return { start: { line: startLine }, end: { line: endLine } };
}

/** 用注入替身构造 targets（primary/secondary 的 injectComposer 行为可配） */
function targets(p: boolean, s: boolean): AddToDshTargets {
  const mk = (ok: boolean): DshPanelProvider => ({ injectComposer: () => ok } as unknown as DshPanelProvider);
  return { providers: [mk(p), mk(s)] };
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

test('dispatch 主面板可见 → 只投递主面板并返回 true', () => {
  let primaryCalled = false;
  let secondaryCalled = false;
  const primary = { injectComposer: () => { primaryCalled = true; return true; } } as unknown as DshPanelProvider;
  const secondary = { injectComposer: () => { secondaryCalled = true; return false; } } as unknown as DshPanelProvider;
  const ok = dispatch({ providers: [primary, secondary] }, '@x');
  assert.equal(ok, true);
  assert.equal(primaryCalled, true);
  assert.equal(secondaryCalled, false); // 主面板已成功，不再试副面板
});

test('dispatch 主面板不可见、副面板可见 → 投递副面板', () => {
  let primaryCalled = false;
  let secondaryCalled = false;
  const primary = { injectComposer: () => { primaryCalled = true; return false; } } as unknown as DshPanelProvider;
  const secondary = { injectComposer: () => { secondaryCalled = true; return true; } } as unknown as DshPanelProvider;
  const ok = dispatch({ providers: [primary, secondary] }, '@x');
  assert.equal(ok, true);
  assert.equal(primaryCalled, true);
  assert.equal(secondaryCalled, true);
});

test('dispatch 两面板都不可见 → 返回 false（调用方提示未就绪）', () => {
  const ok = dispatch(targets(false, false), '@x');
  assert.equal(ok, false);
});
