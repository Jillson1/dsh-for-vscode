// test/panel/panel-side.test.ts — "面板没打开时自动打开哪一侧"的纯决策测试
// 行为契约（真机反馈：面板没开时 Add to DSH 只报错）：
//   ① 用过右侧 → 沿用右侧（不打扰用户既有习惯）
//   ② 只用过左侧 → 用左侧
//   ③ 都没用过 → 默认右侧（辅助侧边栏，与 Claude Code 的 chat 面板一致，也不遮挡文件树）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPanelSide } from '../../src/panel/panel-side';

test('右侧用过 → 选右侧', () => {
  assert.equal(pickPanelSide({ primary: false, secondary: true }), 'secondary');
});

test('两侧都用过 → 仍选右侧（与"最近使用"无关，规则保持可预期）', () => {
  assert.equal(pickPanelSide({ primary: true, secondary: true }), 'secondary');
});

test('只用过左侧 → 选左侧（沿用用户习惯）', () => {
  assert.equal(pickPanelSide({ primary: true, secondary: false }), 'primary');
});

test('两侧都没用过 → 默认右侧', () => {
  assert.equal(pickPanelSide({ primary: false, secondary: false }), 'secondary');
});
