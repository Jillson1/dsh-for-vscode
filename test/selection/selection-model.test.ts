// test/selection/selection-model.test.ts — F10/F11 纯模型单测
// 覆盖：选区归一（1-based 闭区间、整行选中的末行处理）、零长度选区不打扰、引用文本、
// 线程正文/预览、打扰控制开关、Quick Edit 下行形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionInfo,
  pathRefFor,
  threadBody,
  threadPreview,
  quickEditPlaceholder,
  quickEditConfirmText,
  shouldOfferThread,
  quickEditDownlink,
} from '../../src/selection/selection-model';

test('selectionInfo：1-based 闭区间，单行与多行都正确', () => {
  // 第 2 行（0-based 1）第 0 列到第 4 列：单行选区
  const one = selectionInfo('D:/w/a.ts', 1, 0, 1, 4, 'abcd');
  assert.ok(one !== null);
  assert.equal(one.startLine, 2);
  assert.equal(one.endLine, 2);
  assert.equal(one.lineCount, 1);
  assert.equal(one.pathRef, '@D:/w/a.ts:2');

  // 第 2-4 行（0-based 1..3），末列 0 表示"整行选中"→ 末行取 3（= 显示第 4 行）
  const many = selectionInfo('D:/w/a.ts', 1, 0, 4, 0, 'b\nc\nd\n');
  assert.ok(many !== null);
  assert.equal(many.startLine, 2);
  assert.equal(many.endLine, 4);
  assert.equal(many.lineCount, 3);
  assert.equal(many.pathRef, '@D:/w/a.ts:2-4');
});

test('selectionInfo：零长度选区与非法输入返回 null（不打扰）', () => {
  // 只点了一下 / 光标移动
  assert.equal(selectionInfo('D:/w/a.ts', 3, 5, 3, 5, ''), null);
  // 空路径
  assert.equal(selectionInfo('', 1, 0, 2, 0, 'x'), null);
  // 行号非法（end < start / 负数 / 非数字）
  assert.equal(selectionInfo('D:/w/a.ts', 3, 0, 1, 0, 'x'), null);
  assert.equal(selectionInfo('D:/w/a.ts', -1, 0, 2, 0, 'x'), null);
  assert.equal(selectionInfo('D:/w/a.ts', Number.NaN, 0, 2, 0, 'x'), null);
});

test('pathRefFor：单行不写区间（与 Add to DSH 的既有写法一致）', () => {
  assert.equal(pathRefFor('a.ts', 5, 5), '@a.ts:5');
  assert.equal(pathRefFor('a.ts', 5, 9), '@a.ts:5-9');
});

test('threadBody / threadPreview：摘要与折叠预览', () => {
  const info = selectionInfo('D:/w/a.ts', 11, 0, 14, 0, 'const a = 1\nconst b = 2\nconst c = 3\n')!;
  assert.equal(threadBody(info), '选中 3 行 · @D:/w/a.ts:12-14');
  assert.match(threadPreview(info), /^选中 3 行 .*· const a = 1$/);
  // 首行过长 → 截断（Comments 的 preview 只有一行）
  const long = selectionInfo('D:/w/a.ts', 0, 0, 1, 0, 'x'.repeat(200) + '\ny')!;
  assert.match(threadPreview(long), /…$/);
  assert.ok(threadPreview(long).length < 120);
  // 文本为空但选区有效（例如选中空白）→ 退回摘要
  const blank = selectionInfo('D:/w/a.ts', 0, 0, 2, 0, '\n  \n')!;
  assert.match(threadPreview(blank), /^选中 2 行/);
});

test('shouldOfferThread：空选区/空白文本/开关关闭都不挂线程', () => {
  const info = selectionInfo('D:/w/a.ts', 1, 0, 2, 0, 'x\ny')!;
  assert.equal(shouldOfferThread(info, true), true);
  assert.equal(shouldOfferThread(info, false), false, '设置关闭时整体不生效');
  assert.equal(shouldOfferThread(null, true), false);
  const blank = selectionInfo('D:/w/a.ts', 1, 0, 2, 0, '   \n\t')!;
  assert.equal(shouldOfferThread(blank, true), false, '纯空白选区不值得冒出一个线程');
});

test('quickEditPlaceholder / quickEditConfirmText：文案含行数与引用，且点明会消耗一轮调用', () => {
  const info = selectionInfo('D:/w/a.ts', 11, 0, 14, 0, 'x\ny\nz\n')!;
  assert.match(quickEditPlaceholder(info), /3 行/);
  assert.match(quickEditPlaceholder(info), /@D:\/w\/a\.ts:12-14/);
  const text = quickEditConfirmText(info, '  改成防抖  ');
  assert.match(text, /@D:\/w\/a\.ts:12-14 改成防抖/);
  assert.match(text, /真实触发一轮模型调用/);
  // 空指令时只给引用（不出现多余空格）
  assert.match(quickEditConfirmText(info, '   '), /：\n\n@D:\/w\/a\.ts:12-14\n/);
});

test('quickEditDownlink：形状与桥接下行的白名单一致', () => {
  const info = selectionInfo('D:/w/a.ts', 11, 0, 14, 0, 'x\ny\nz\n')!;
  assert.deepEqual(quickEditDownlink(info, '改成防抖'), {
    type: 'bridgeQuickEditSubmit',
    path: 'D:/w/a.ts',
    startLine: 12,
    endLine: 14,
    instruction: '改成防抖',
  });
});
