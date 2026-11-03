// test/selection/burst-gate.test.ts — 选区工具条「拖选冻结 + 自适应静默触发」时序门的单测
//
// 背景（真机反馈 2026-10-30）：划选一开始工具条就弹出，CodeLens 占行导致拖选中途行位移、
// 选区选错。修复 = 方案 A + 方向一：Mouse/Keyboard 事件冻结（只记 pending），事件流静默
// **自适应窗**（≈1.5×当前划选节奏，[300, 1200]ms，带上一轮节奏记忆）才统一重算；
// Command 补发冻结期忽略、空闲期走旧 120ms 防抖。
// 时序全部用假时钟驱动（不 sleep），把“冻结/触发/合并/取消/自适应”逐条钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SelectionBurstGate,
  adaptiveSettleMs,
  BURST_BREAK_MS,
  SELECTION_COMMAND_DEBOUNCE_MS,
  SELECTION_SETTLE_MAX_MS,
  SELECTION_SETTLE_MS,
} from '../../src/selection/selection-burst-gate';

/** 假时钟：记录挂起任务，可按毫秒推进（到期任务按时间序执行） */
function makeClock() {
  let now = 0;
  const jobs: { at: number; cb: () => void }[] = [];
  const timers = {
    now: () => now,
    set: (cb: () => void, ms: number): unknown => {
      const job = { at: now + ms, cb };
      jobs.push(job);
      return job;
    },
    clear: (handle: unknown): void => {
      const i = jobs.indexOf(handle as { at: number; cb: () => void });
      if (i >= 0) jobs.splice(i, 1);
    },
  };
  const advance = (ms: number): void => {
    // 语义：时间推进到“起点 + ms”，中途到期的任务按时间序触发（任务内部可能再排新任务）
    const target = now + ms;
    for (;;) {
      const next = jobs.slice().sort((a, b) => a.at - b.at)[0];
      if (next === undefined || next.at > target) break;
      now = next.at;
      jobs.splice(jobs.indexOf(next), 1);
      next.cb();
    }
    now = target;
  };
  return { timers, advance };
}

function makeGate(
  settleMs = SELECTION_SETTLE_MS,
  commandDebounceMs = SELECTION_COMMAND_DEBOUNCE_MS,
) {
  const clock = makeClock();
  let fired = 0;
  const gate = new SelectionBurstGate(() => {
    fired += 1;
  }, { timers: clock.timers, settleMs, commandDebounceMs });
  return { gate, clock, fired: () => fired };
}

// —— adaptiveSettleMs 纯函数 ——

test('adaptiveSettleMs：无节奏/非法 → 下限 300；间隔 600 → 900；极端慢划封顶 1200', () => {
  assert.equal(adaptiveSettleMs(undefined), SELECTION_SETTLE_MS);
  assert.equal(adaptiveSettleMs(0), SELECTION_SETTLE_MS);
  assert.equal(adaptiveSettleMs(-5), SELECTION_SETTLE_MS);
  assert.equal(adaptiveSettleMs(100), SELECTION_SETTLE_MS, '快划（1.5×100=150）按下限');
  assert.equal(adaptiveSettleMs(600), 900, '慢划按 1.5× 节奏');
  assert.equal(adaptiveSettleMs(2000), SELECTION_SETTLE_MAX_MS, '极端慢划封顶');
});

// —— 冻结与静默触发 ——

test('拖选开始（Mouse 事件）→ 冻结：不立即重算，静默期满才触发一次', () => {
  const { gate, clock, fired } = makeGate();
  gate.onUserSelection();
  assert.equal(fired(), 0, '拖选开始不得立即重挂工具条');
  clock.advance(SELECTION_SETTLE_MS - 1);
  assert.equal(fired(), 0);
  clock.advance(1);
  assert.equal(fired(), 1, '静默到期（≈抬起后）应触发');
  clock.advance(1000);
  assert.equal(fired(), 1, '触发是一次性的，不得重复');
});

test('快划拖选（间隔 250ms < 静默窗）事件流不停就不弹', () => {
  const { gate, clock, fired } = makeGate();
  // 模拟快划跨 10 行：每 250ms 一次选区事件。节奏 250 → 静默窗 375ms > 间隔 → 持续冻结
  for (let i = 0; i < 10; i += 1) {
    gate.onUserSelection();
    clock.advance(SELECTION_SETTLE_MS - 50);
  }
  assert.equal(fired(), 0, '快划进行中不得弹出');
  gate.onUserSelection();
  clock.advance(Math.round((SELECTION_SETTLE_MS - 50) * 1.5));
  assert.equal(fired(), 1, '抬起（事件流停止）后按节奏触发一次');
});

test('慢划拖选（间隔 600ms）：中途不弹，抬起后 ~900ms 才弹', () => {
  const { gate, clock, fired } = makeGate();
  // 首间隙无节奏记忆 → 默认 300ms（已知首隙边界，见节奏记忆用例）
  gate.onUserSelection();
  clock.advance(600); // t=600：t=300 处已弹一次（首隙边界）
  assert.equal(fired(), 1);
  // 之后节奏被记住（gap 600 → 静默窗 900）：拖选继续就不再弹
  gate.onUserSelection();
  clock.advance(600);
  gate.onUserSelection();
  clock.advance(600);
  assert.equal(fired(), 1, '慢划进行中（事件间隔 600ms < 900ms 窗口）不得再弹');
  // 抬起：事件流停止 → ~900ms 后触发
  clock.advance(900);
  assert.equal(fired(), 2);
});

test('节奏记忆：上一轮慢划后，新一轮慢划的第一间隙不再提前弹', () => {
  const { gate, clock, fired } = makeGate();
  // 热身：一轮 600ms 间隔的慢划（首隙用默认 300ms 弹一次——无记忆时的已知边界）
  gate.onUserSelection();
  clock.advance(600);
  assert.equal(fired(), 1);
  gate.onUserSelection(); // gap=600 → 记住节奏
  clock.advance(600);
  assert.equal(fired(), 1);
  clock.advance(BURST_BREAK_MS); // 静默触发一次 + 间隔断开（进入新一轮）
  const afterWarmup = fired();
  // —— 新一轮慢划：第一间隙按上一轮节奏（600 → 900ms 窗口），不再在 +300ms 提前弹 ——
  gate.onUserSelection();
  clock.advance(300);
  assert.equal(fired(), afterWarmup, '慢划第一间隙不得在 300ms 就弹');
  clock.advance(600);
  assert.equal(fired(), afterWarmup + 1, '按节奏（~900ms）触发');
});

test('节奏间隔超过断开阈值 → 按新操作处理（沿用记忆节奏而非把超大间隔当节奏）', () => {
  const { gate, clock, fired } = makeGate();
  gate.onUserSelection();
  clock.advance(600); // 热身：节奏 600（首隙在 t=300 弹一次）
  gate.onUserSelection(); // gap=600 → prior=600
  clock.advance(BURST_BREAK_MS * 2); // 静默触发 + 断开
  const base = fired();
  gate.onUserSelection(); // gap 巨大 → 不把 10s 当节奏，沿用 prior=600 → 窗口 900ms
  clock.advance(SELECTION_SETTLE_MS + 1);
  assert.equal(fired(), base, '不得用超大间隔的 1.5× 在 300ms 出头就弹……');
  clock.advance(900 - SELECTION_SETTLE_MS - 1);
  assert.equal(fired(), base + 1, '……而是在 ~900ms（节奏窗）触发');
});

// —— Command 路径 ——

test('冻结期的 Command 补发被忽略（不得绕过冻结在拖选中重算）', () => {
  const { gate, clock, fired } = makeGate();
  gate.onUserSelection();
  gate.onCommand(); // VS Code 拖选收尾/渲染补发
  clock.advance(SELECTION_COMMAND_DEBOUNCE_MS);
  assert.equal(fired(), 0, 'Command 不得在冻结期触发重算');
  clock.advance(SELECTION_SETTLE_MS);
  assert.equal(fired(), 1, '仍由静默到期统一触发');
});

test('空闲期 Command 事件走 120ms 尾防抖并合并连续补发', () => {
  const { gate, clock, fired } = makeGate();
  gate.onCommand();
  clock.advance(SELECTION_COMMAND_DEBOUNCE_MS - 1);
  gate.onCommand(); // 重置防抖
  clock.advance(SELECTION_COMMAND_DEBOUNCE_MS - 1);
  assert.equal(fired(), 0);
  clock.advance(1);
  assert.equal(fired(), 1, '连续补发合并为一次');
});

test('用户事件会取消挂起的 Command 防抖（120ms 内开始拖选即冻结）', () => {
  const { gate, clock, fired } = makeGate();
  gate.onCommand();
  gate.onUserSelection();
  clock.advance(SELECTION_COMMAND_DEBOUNCE_MS + 50);
  assert.equal(fired(), 0, 'Command 防抖已被拖选冻结取消');
  clock.advance(SELECTION_SETTLE_MS);
  assert.equal(fired(), 1, '由静默到期触发');
});

// —— 离散事件与生命周期 ——

test('编辑器切换：立即重算并取消挂起的静默触发', () => {
  const { gate, clock, fired } = makeGate();
  gate.onUserSelection();
  gate.onEditorSwitch();
  assert.equal(fired(), 1, '切换立即重算（旧编辑器的按钮不留在新文件上）');
  clock.advance(SELECTION_SETTLE_MAX_MS * 2);
  assert.equal(fired(), 1, '挂起的静默触发已取消');
});

test('dispose 取消全部挂起触发（停用不泄露定时器）', () => {
  const { gate, clock, fired } = makeGate();
  gate.onUserSelection();
  gate.dispose();
  clock.advance(10_000);
  assert.equal(fired(), 0);
});
