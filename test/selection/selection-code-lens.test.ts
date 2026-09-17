// test/selection/selection-code-lens.test.ts — F10 选区工具条（CodeLens 版）落点单测
// 覆盖：有选区出两个按钮、程序化选区不出、零长度选区不出、开关关闭不出、选区属于别的文档不出。
// 这些规则决定"点一下光标会不会冒工具条""跳行定位时会不会与变更行按钮挤在一起"
// 以及"按钮会不会出现在不相干的文件上"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionLensSpecs,
  ADD_COMMAND,
  QUICK_EDIT_COMMAND,
  ADD_TITLE,
  QUICK_EDIT_TITLE,
  type ActiveSelection,
} from '../../src/selection/selection-code-lens';

const DOC = 'E:\\codee\\document\\demo.ts';

/** 用户鼠标划选（正常场景） */
function userSel(startLine: number): ActiveSelection {
  return { fsPath: DOC, startLine, isEmpty: false, userInitiated: true };
}

test('用户划选：在选区首行出两个并排按钮（添加到 DSH + Quick Edit）', () => {
  const specs = selectionLensSpecs(DOC, userSel(4), true);
  assert.equal(specs.length, 2, '必须两个按钮并排');
  assert.deepEqual(specs, [
    { line: 4, command: ADD_COMMAND, title: ADD_TITLE },
    { line: 4, command: QUICK_EDIT_COMMAND, title: QUICK_EDIT_TITLE },
  ]);
});

test('两个按钮落在同一行（并排，而不是上下两行）', () => {
  const specs = selectionLensSpecs(DOC, userSel(9), true);
  assert.equal(new Set(specs.map((s) => s.line)).size, 1);
});

test('按钮挂在选区首行，而不是末行（多行选区）', () => {
  const specs = selectionLensSpecs(DOC, userSel(2), true);
  assert.equal(specs[0]?.line, 2);
});

test('程序化选区（跳行定位把整行设为选区）→ 不出工具条', () => {
  // 真机反馈：点工具卡片路径跳行后，工具条会与变更行的「保留/丢弃/对比」挤在一起
  const programmatic: ActiveSelection = { fsPath: DOC, startLine: 12, isEmpty: false, userInitiated: false };
  assert.deepEqual(selectionLensSpecs(DOC, programmatic, true), []);
});

test('零长度选区（只点了一下光标）→ 不出工具条', () => {
  assert.deepEqual(
    selectionLensSpecs(DOC, { fsPath: DOC, startLine: 3, isEmpty: true, userInitiated: true }, true),
    [],
  );
});

test('没有活动编辑器/选区 → 不出工具条', () => {
  assert.deepEqual(selectionLensSpecs(DOC, undefined, true), []);
});

test('开关关闭 → 不出工具条（即便有用户选区）', () => {
  assert.deepEqual(selectionLensSpecs(DOC, userSel(1), false), []);
});

test('选区属于别的文档 → 在该文档上不出按钮（VS Code 会逐文档询问）', () => {
  const other = 'E:\\codee\\document\\other.ts';
  assert.deepEqual(selectionLensSpecs(other, userSel(1), true), []);
  assert.equal(selectionLensSpecs(DOC, userSel(1), true).length, 2);
});

test('异常负行号 → 归一到第 0 行（不产生非法 Range）', () => {
  assert.equal(selectionLensSpecs(DOC, userSel(-5), true)[0]?.line, 0);
});

test('两个按钮的命令 id 与既有选区命令一致（否则点了没反应）', () => {
  assert.equal(ADD_COMMAND, 'dsh.selection.addToDsh');
  assert.equal(QUICK_EDIT_COMMAND, 'dsh.selection.quickEdit');
});
