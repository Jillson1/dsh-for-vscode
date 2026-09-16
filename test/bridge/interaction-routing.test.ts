// test/bridge/interaction-routing.test.ts — F6/F8 投递决策单测
// 这条规则决定"会不会同一件事问两遍"，因此把它钉死：设置关闭一律 IDE；
// 设置打开时只有"面板隐藏"才在 IDE 弹，面板可见则交回面板。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideDelivery,
  deferredLogLine,
  interactionKindOf,
} from '../../src/bridge/interaction-routing';

test('策略 B 默认：面板可见 → 交给面板；面板隐藏 → 在 IDE 弹', () => {
  const base = { kind: 'question' as const, onlyWhenPanelHidden: true };
  assert.equal(decideDelivery({ ...base, panelVisible: true }), 'panel', '用户就在面板那儿，不该再弹一遍');
  assert.equal(decideDelivery({ ...base, panelVisible: false }), 'ide', '面板隐藏时才是 F8 的价值');
});

test('设置关闭 → 一律在 IDE 弹（老行为）', () => {
  const base = { kind: 'approval' as const, onlyWhenPanelHidden: false };
  assert.equal(decideDelivery({ ...base, panelVisible: true }), 'ide');
  assert.equal(decideDelivery({ ...base, panelVisible: false }), 'ide');
});

test('审批与提问共用同一条规则（不因种类而异）', () => {
  const input = { onlyWhenPanelHidden: true, panelVisible: true };
  assert.equal(decideDelivery({ ...input, kind: 'approval' }), decideDelivery({ ...input, kind: 'question' }));
});

test('deferredLogLine：文案带设置名，便于排障时认出"策略 B 生效"', () => {
  assert.match(deferredLogLine('question'), /提问/);
  assert.match(deferredLogLine('approval'), /审批/);
  assert.match(deferredLogLine('question'), /onlyWhenPanelHidden/);
});

test('interactionKindOf：只有审批/提问两类需要决策，其它消息返回 null', () => {
  assert.equal(interactionKindOf({ type: 'bridgeApprovalRequest', sessionId: 's', approvalId: 'a', toolName: 'bash' }), 'approval');
  assert.equal(interactionKindOf({ type: 'bridgeQuestionRequest', sessionId: 's', questionId: 'q', questions: [] }), 'question');
  assert.equal(interactionKindOf({ type: 'bridgeSessionState', sessionId: 's', running: false, turn: 0, pending: 0 }), null);
  assert.equal(interactionKindOf({ type: 'bridgeAck', ok: true }), null);
});
