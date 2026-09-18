// test/selection/selection-origin.test.ts — "选区来源"判定单测（工具条闪烁缺陷的守卫）
//
// 真机缺陷（2026-09-18）：编辑区划选后，「添加到 DSH / Quick Edit」两个按钮**闪一下就消失**。
// 根因：来源被记成"最后一次事件是什么"，而选区事件流里夹着大量 VS Code 的**程序化补发**
// （kind=3 Command：渲染 CodeLens、拖选收尾、视图变化都会发）。任何一次补发都会把
// 刚记下的"用户选区"冲掉，120ms 防抖后的重算就把工具条收掉。
//
// 修复后的契约（本文件锁住）：
//   Mouse/Keyboard 且不在静音窗 → true（用户发起）
//   Command 不在静音窗           → null（**不提供信息**，调用方必须保持原值 —— 这是修复的关键）
//   Command 在静音窗             → false（我们自己的跳行定位）
//   其它/undefined               → null
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySelectionOrigin, muteSelectionThreads, selectionThreadsMuted } from '../../src/editorReveal';

const KEYBOARD = 1;
const MOUSE = 2;
const COMMAND = 3;

test('Mouse / Keyboard 视为用户发起', () => {
  assert.equal(classifySelectionOrigin(MOUSE, false), true);
  assert.equal(classifySelectionOrigin(KEYBOARD, false), true);
});

test('静音窗内的用户事件视为程序化（跳行定位后就该收掉按钮）', () => {
  assert.equal(classifySelectionOrigin(MOUSE, true), false);
  assert.equal(classifySelectionOrigin(KEYBOARD, true), false);
});

test('静音窗外的 Command 返回 null —— 不提供信息，调用方不得覆盖已知来源', () => {
  assert.equal(
    classifySelectionOrigin(COMMAND, false),
    null,
    '这正是闪烁缺陷的修复点：VS Code 的良性补发不能把"用户选区"冲掉',
  );
});

test('静音窗内的 Command 视为程序化（我们自己的 editor.selection 赋值）', () => {
  assert.equal(classifySelectionOrigin(COMMAND, true), false);
});

test('undefined / 未知 kind 一律 null（宁可保留按钮，也不误收）', () => {
  assert.equal(classifySelectionOrigin(undefined, false), null);
  assert.equal(classifySelectionOrigin(undefined, true), null);
  assert.equal(classifySelectionOrigin(99, false), null);
});

test('模拟真实事件序列：拖选 -> VS Code 补发 Command -> 按钮必须保持', () => {
  // 这就是真机上的失败序列：若把 Command 当真值记录，userInitiated 会从 true 变 false
  let userInitiated: boolean | null = null;
  const apply = (kind: number | undefined) => {
    const o = classifySelectionOrigin(kind, selectionThreadsMuted());
    if (o !== null) userInitiated = o;
    return userInitiated;
  };
  assert.equal(apply(MOUSE), true, '拖选 -> 用户发起');
  assert.equal(apply(COMMAND), true, '补发 Command -> **保持**用户发起（不再被冲掉）');
  assert.equal(apply(COMMAND), true, '连续补发也保持');
});

test('静音窗生命周期：开窗后判定为程序化，窗口过期后恢复', () => {
  muteSelectionThreads(30);
  assert.equal(selectionThreadsMuted(), true);
  assert.equal(classifySelectionOrigin(MOUSE, selectionThreadsMuted()), false, '窗内 -> 程序化');
  // 等窗口过期（30ms，测试里用真实时钟，短到不影响用例时长）
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(selectionThreadsMuted(), false);
      assert.equal(classifySelectionOrigin(MOUSE, selectionThreadsMuted()), true, '窗外 -> 用户发起');
      resolve();
    }, 60);
  });
});
