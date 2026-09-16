// test/selection/quick-edit.test.ts — F11 发送侧单测
// 覆盖：空指令不发、确认策略（默认开/关掉、用户取消）、面板不可达如实告知、成功路径。
// 这里的重点不是"发出去了"，而是**不该发的时候别发**——自动发送会真实消耗一轮模型调用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendQuickEdit, type QuickEditSenderDeps } from '../../src/selection/quick-edit';
import { selectionInfo } from '../../src/selection/selection-model';
import type { PanelDownlink } from '../../src/panel/html';

/** 一处选区（第 12-14 行） */
const INFO = selectionInfo('D:/w/a.ts', 11, 0, 14, 0, 'a\nb\nc\n')!;

/** 组装发送依赖 + 可观察记录 */
function makeDeps(over: Partial<QuickEditSenderDeps> = {}) {
  const sent: PanelDownlink[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const deps: QuickEditSenderDeps = {
    confirmBeforeSend: () => true,
    confirm: async () => true,
    send: (m) => {
      sent.push(m);
      return true;
    },
    notify: (m) => notices.push(m),
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, sent, notices, logs };
}

test('空指令不发送：不弹确认、不下行、给出取消提示', async () => {
  let confirmed = 0;
  const { deps, sent, notices } = makeDeps({
    confirm: async () => {
      confirmed += 1;
      return true;
    },
  });
  assert.equal(await sendQuickEdit(INFO, '   ', deps), 'empty');
  assert.equal(confirmed, 0, '空指令连确认框都不该弹');
  assert.deepEqual(sent, []);
  assert.ok(notices.some((n) => n.includes('没有填写修改指令')));
});

test('确认开启且用户确认 → 下发 quickEditSubmit', async () => {
  const { deps, sent } = makeDeps();
  assert.equal(await sendQuickEdit(INFO, '改成防抖', deps), 'sent');
  assert.deepEqual(sent, [
    { type: 'bridgeQuickEditSubmit', path: 'D:/w/a.ts', startLine: 12, endLine: 14, instruction: '改成防抖' },
  ]);
});

test('确认框被取消 → 不下发（用户明确说不要）', async () => {
  const { deps, sent, logs } = makeDeps({ confirm: async () => false });
  assert.equal(await sendQuickEdit(INFO, '改成防抖', deps), 'cancelled');
  assert.deepEqual(sent, []);
  assert.ok(logs.some((l) => l.includes('取消')));
});

test('设置关闭确认 → 直接发送（不再打扰）', async () => {
  let confirmed = 0;
  const { deps, sent } = makeDeps({
    confirmBeforeSend: () => false,
    confirm: async () => {
      confirmed += 1;
      return true;
    },
  });
  assert.equal(await sendQuickEdit(INFO, '改成防抖', deps), 'sent');
  assert.equal(confirmed, 0);
  assert.equal(sent.length, 1);
});

test('面板不可达 → 不假装已发送，如实告知', async () => {
  const { deps, notices, logs } = makeDeps({ send: () => false });
  assert.equal(await sendQuickEdit(INFO, '改成防抖', deps), 'unreachable');
  assert.ok(notices.some((n) => n.includes('未能发送')));
  assert.ok(logs.some((l) => l.includes('不可达')));
});

test('指令两侧空白会被裁掉（避免把空白带进 composer）', async () => {
  const { deps, sent } = makeDeps();
  await sendQuickEdit(INFO, '  改成防抖  ', deps);
  assert.equal((sent[0] as unknown as { instruction: string }).instruction, '改成防抖');
});
