// src/selection/selection-burst-gate.ts — 选区工具条的「拖选冻结 + 自适应静默触发」时序门
//
// 真机反馈（2026-10-30）：划选一开始「🐳 添加到 DSH / ✨ Quick Edit」就弹出；CodeLens 占
// 一整行高，弹出/移除都会把内容推移 → 拖动中的“那一行”位移 → 选区选错行。
// 旧实现只有 120ms 尾防抖，不是冻结——拖选中途任何一次停顿 ≥120ms 都会触发重挂。
//
// 为什么只能“近似 mouseup”（可行性评估的硬边界）：扩展宿主没有 DOM、没有鼠标事件 API，
// 唯一信号是选区事件流（kind=keyboard/mouse/command，无 down/up 语义）；且 mouseup 时
// 选区不再变化、通常不发事件——没有“结束”标记。因此用**自适应事件流静默窗口**近似：
//   - 等待时长 ≈ 1.5 × 你自己当前的划选节奏（跨行间隔），下限 300ms、上限 1.2s——
//     划得多慢就等多久，慢划中途不再弹出；快划仍 300ms 快速出现；
//   - **节奏记忆**：上一段真实间隔会被记住——新一轮慢划的**第一间隙**也有据可依，
//     否则每个慢划都会在 mousedown 后 300ms（首间隙）提前弹一次；
//   - kind=Command（程序化补发）→ 冻结期忽略（不得在拖选中引发位移）；
//     空闲期沿用旧 120ms 尾防抖——VS Code 拖选收尾常补发 Command，相当于“抬起加速器”。
// 残余边界（诚实）：停顿超过 ~1.5× 自己节奏（封顶 1.2s）仍会弹出——停顿与抬起在事件流上不可区分。

/** 自适应下限：快划/首次事件（无节奏可依）的静默窗 */
export const SELECTION_SETTLE_MS = 300

/** 自适应上限：极端慢划封顶，避免按钮迟迟不出 */
export const SELECTION_SETTLE_MAX_MS = 1200

/** 程序化（Command）事件的尾防抖：沿用旧实现的 120ms，保持该路径行为不变 */
export const SELECTION_COMMAND_DEBOUNCE_MS = 120

/** 等待 = 节奏 × 该系数（留 50% 余量，节奏波动不误弹） */
export const SETTLE_GAP_FACTOR = 1.5

/** 间隔超过它 = 新的一次操作（burst 断开）；节奏沿用上一段的记忆 */
export const BURST_BREAK_MS = 5000

/**
 * 由“最近一次选区间隔”算静默窗：无节奏 → 下限；否则 1.5× 并夹在 [300, 1200]ms。
 * 纯函数，单测直测。
 */
export function adaptiveSettleMs(gapMs: number | undefined): number {
  if (gapMs === undefined || !Number.isFinite(gapMs) || gapMs <= 0) return SELECTION_SETTLE_MS
  return Math.min(SELECTION_SETTLE_MAX_MS, Math.max(SELECTION_SETTLE_MS, Math.round(gapMs * SETTLE_GAP_FACTOR)))
}

/** 定时器注入缝（生产 = setTimeout/clearTimeout；测试 = 假时钟） */
export interface BurstGateTimers {
  now(): number
  set(cb: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const defaultTimers: BurstGateTimers = {
  now: () => Date.now(),
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface BurstGateOptions {
  readonly timers?: BurstGateTimers
  readonly settleMs?: number
  readonly commandDebounceMs?: number
}

/**
 * 选区事件 → “什么时候允许重算工具条/清线程”的时序门。
 *
 * `fire` 是统一重算出口（线程清理 + CodeLens 刷新），三类入口：
 * - {@link onUserSelection}：用户选区（mouse/keyboard，**含 mousedown 的空选区**——
 *   它可能是拖选第一步，立即重算会正好在拖动开始时位移）；
 * - {@link onCommand}：程序化/命令补发；
 * - {@link onEditorSwitch}：活动编辑器切换（离散事件，立即重算并取消挂起）。
 */
export class SelectionBurstGate {
  private settleTimer: unknown
  private commandTimer: unknown
  /** 最近一次用户选区事件时刻（ms）；undefined = 当前无进行中的交互 */
  private lastEventAt: number | undefined
  /** 上一段真实间隔（节奏记忆）：新一轮慢划的第一间隙靠它避免提前弹 */
  private priorGapMs: number | undefined
  private readonly timers: BurstGateTimers
  private readonly settleMs: number
  private readonly commandDebounceMs: number

  constructor(
    /** 统一重算出口：线程清理 + 工具条刷新（由装配方提供） */
    private readonly fire: () => void,
    opts: BurstGateOptions = {},
  ) {
    this.timers = opts.timers ?? defaultTimers
    this.settleMs = opts.settleMs ?? SELECTION_SETTLE_MS
    this.commandDebounceMs = opts.commandDebounceMs ?? SELECTION_COMMAND_DEBOUNCE_MS
  }

  /** 用户选区事件：冻结。按当前节奏（无则用上一段记忆）定静默窗，静默后统一重算 */
  onUserSelection(): void {
    const now = this.timers.now()
    let rhythm = this.priorGapMs
    if (this.lastEventAt !== undefined) {
      const gap = now - this.lastEventAt
      if (gap > 0 && gap <= BURST_BREAK_MS) {
        rhythm = gap // 本次拖选的真实节奏
        this.priorGapMs = gap // 记住它：下一次慢划的第一间隙不再用下限值
      }
      // gap > BURST_BREAK_MS：新的一次操作，沿用 prior（无 prior 则下限）
    }
    this.cancelCommand()
    this.cancelSettle()
    this.settleTimer = this.timers.set(
      () => {
        this.settleTimer = undefined
        this.fire()
      },
      Math.max(this.settleMs, adaptiveSettleMs(rhythm)),
    )
    this.lastEventAt = now
  }

  /**
   * 程序化/命令补发：**冻结期忽略**（拖选中途的补发不得引发位移）；
   * 空闲期走 120ms 尾防抖（与旧行为一致，连续补发合并为一次）。
   */
  onCommand(): void {
    if (this.settleTimer !== undefined) return
    this.cancelCommand()
    this.commandTimer = this.timers.set(() => {
      this.commandTimer = undefined
      this.fire()
    }, this.commandDebounceMs)
  }

  /** 活动编辑器切换：离散事件，取消挂起触发并立即重算（旧编辑器的按钮不该留在新文件上） */
  onEditorSwitch(): void {
    this.cancelSettle()
    this.cancelCommand()
    this.lastEventAt = undefined // 换文件断开本次交互；节奏记忆保留
    this.fire()
  }

  /** 仅取消挂起的触发，不重算（扩展停用等场景） */
  cancelPending(): void {
    this.cancelSettle()
    this.cancelCommand()
  }

  dispose(): void {
    this.cancelPending()
  }

  private cancelSettle(): void {
    if (this.settleTimer !== undefined) {
      this.timers.clear(this.settleTimer)
      this.settleTimer = undefined
    }
  }

  private cancelCommand(): void {
    if (this.commandTimer !== undefined) {
      this.timers.clear(this.commandTimer)
      this.commandTimer = undefined
    }
  }
}
