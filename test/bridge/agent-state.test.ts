// test/bridge/agent-state.test.ts — F7 会话状态机单测
// 覆盖：四态状态栏优先级、完成通知的触发条件（只有"运行中 → 空闲的那一次跃迁"且本轮确有变更）、
// 会话切换不误报、空轮次不打扰。通知是最容易变成噪音的东西，因此边界断言很密。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySessionState,
  agentStatusView,
  turnCompleteMessage,
  IDLE_AGENT_STATE,
  type AgentState,
  type AgentStateEvent,
} from '../../src/bridge/agent-state';

/** 一次状态事件（默认：sess-1 空闲） */
function event(over: Partial<AgentStateEvent> = {}): AgentStateEvent {
  return { sessionId: 'sess-1', running: false, turn: 0, pending: 0, changeCount: 0, fileCount: 0, ...over };
}

const NOTIFY = { notifyOnTurnComplete: true };

test('初始状态：未连接（信息栏不给绿色，避免"看起来一切正常"的误导）', () => {
  const view = agentStatusView(IDLE_AGENT_STATE);
  assert.equal(view.text, '$(circle-outline) DSH · 未连接');
  assert.equal(view.color, 'descriptionForeground');
});

test('运行中 → 状态栏带轮次；pending>0 时"等待审批"优先于"运行中"', () => {
  const running: AgentState = { ...IDLE_AGENT_STATE, sessionId: 'sess-1', running: true, turn: 3 };
  assert.equal(agentStatusView(running).text, '$(sync~spin) DSH · 运行中 · 第 3 轮');
  assert.equal(agentStatusView({ ...running, pending: 1 }).text, '$(bell) DSH · 等待审批');
  // 轮次未知（0）时不显示"第 0 轮"
  assert.equal(agentStatusView({ ...running, turn: 0 }).text, '$(sync~spin) DSH · 运行中');
});

test('本轮开始记基线；运行中 → 空闲且有变更 → 给出完成通知（含文件数）', () => {
  const start = applySessionState(IDLE_AGENT_STATE, event({ running: true, turn: 2, changeCount: 5, fileCount: 2 }), NOTIFY);
  assert.equal(start.notice, null, '开始运行不该通知');
  assert.equal(start.next.turnStartChanges, 5);
  assert.equal(start.next.turnStartFiles, 2);

  const end = applySessionState(start.next, event({ running: false, turn: 2, changeCount: 8, fileCount: 5 }), NOTIFY);
  assert.deepEqual(end.notice, { sessionId: 'sess-1', turn: 2, changes: 3, files: 3 });
  assert.equal(turnCompleteMessage(end.notice!), 'DSH 第 2 轮完成：3 个文件被修改');
  // 结束后基线清空，避免下一轮误算
  assert.equal(end.next.turnStartChanges, undefined);
});

test('本轮没有变更 → 不通知（空轮次通知等于噪音）', () => {
  const start = applySessionState(IDLE_AGENT_STATE, event({ running: true, changeCount: 5, fileCount: 2 }), NOTIFY);
  const end = applySessionState(start.next, event({ running: false, changeCount: 5, fileCount: 2 }), NOTIFY);
  assert.equal(end.notice, null);
});

test('轮次结束时仍有待决交互 → 不通知（用户正忙着应答，别再弹一个）', () => {
  const start = applySessionState(IDLE_AGENT_STATE, event({ running: true, changeCount: 0 }), NOTIFY);
  const end = applySessionState(start.next, event({ running: false, pending: 1, changeCount: 4, fileCount: 3 }), NOTIFY);
  assert.equal(end.notice, null);
});

test('会话切换 → 不把切换当成本轮完成，且基线重置', () => {
  const first = applySessionState(IDLE_AGENT_STATE, event({ running: true, turn: 1, changeCount: 3 }), NOTIFY);
  // 切到另一个会话的"空闲"状态：不应产生通知
  const switched = applySessionState(first.next, event({ sessionId: 'sess-2', running: false, changeCount: 9, fileCount: 4 }), NOTIFY);
  assert.equal(switched.notice, null, '会话切换不应误报本轮完成');
  assert.equal(switched.next.sessionId, 'sess-2');
  assert.equal(switched.next.turnStartChanges, undefined);
});

test('设置关闭时不通知（dsh.notify.onTurnComplete=false）', () => {
  const start = applySessionState(IDLE_AGENT_STATE, event({ running: true, changeCount: 0 }), { notifyOnTurnComplete: false });
  const end = applySessionState(start.next, event({ running: false, changeCount: 3, fileCount: 2 }), {
    notifyOnTurnComplete: false,
  });
  assert.equal(end.notice, null);
});

test('轮次未知（turn=0）时文案不带轮次；只有变更数时退化为"处变更"', () => {
  assert.equal(turnCompleteMessage({ sessionId: 's', turn: 0, changes: 2, files: 0 }), 'DSH 本轮完成：2 处变更');
});

test('重复的相同状态 → 状态不变、不重复通知（幂等）', () => {
  const a = applySessionState(IDLE_AGENT_STATE, event({ running: false, turn: 1 }), NOTIFY);
  const b = applySessionState(a.next, event({ running: false, turn: 1 }), NOTIFY);
  assert.equal(b.notice, null);
  assert.deepEqual(b.next, a.next);
});

test('多轮连续：第二轮基线按第二轮开始时的账本计数算', () => {
  const s1 = applySessionState(IDLE_AGENT_STATE, event({ running: true, turn: 1, changeCount: 0 }), NOTIFY);
  const e1 = applySessionState(s1.next, event({ running: false, turn: 1, changeCount: 2, fileCount: 1 }), NOTIFY);
  assert.equal(e1.notice?.changes, 2);
  const s2 = applySessionState(e1.next, event({ running: true, turn: 2, changeCount: 2, fileCount: 1 }), NOTIFY);
  const e2 = applySessionState(s2.next, event({ running: false, turn: 2, changeCount: 5, fileCount: 2 }), NOTIFY);
  assert.deepEqual(e2.notice, { sessionId: 'sess-1', turn: 2, changes: 3, files: 1 });
});
