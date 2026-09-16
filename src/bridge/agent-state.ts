// src/bridge/agent-state.ts — F7 会话状态机（状态栏 + 完成通知的纯逻辑）
//
// 输入是插件上报的 `sessionState`（running / turn / pending）+ 账本的当前计数；
// 输出是"状态栏该显示什么"与"该不该弹完成通知"。全部是纯函数，因此可以逐个边界钉死：
//   运行中 → 空闲的**那一次跃迁**才是"本轮完成"；会话切换与重连造成的状态抖动不该弹通知。
//
// 为什么把"本轮改了几个文件"也算进来：一条"DSH 本轮完成：7 个文件被修改"的通知，
// 只有在真的改了东西时才有价值；空轮次通知等于噪音（方案 §9 明确反对过度弹窗）。
import type { SessionStateMsg } from '../panel/html'

/** 状态机快照（扩展侧持有的唯一 agent 状态） */
export interface AgentState {
  readonly sessionId: string | undefined
  readonly running: boolean
  readonly turn: number
  readonly pending: number
  /** 本轮开始时的变更计数（用于算"本轮改了多少"；undefined = 尚未见到 running=true） */
  readonly turnStartChanges: number | undefined
  /** 本轮开始时的文件数 */
  readonly turnStartFiles: number | undefined
}

/** 初始状态（未连接任何会话） */
export const IDLE_AGENT_STATE: AgentState = {
  sessionId: undefined,
  running: false,
  turn: 0,
  pending: 0,
  turnStartChanges: undefined,
  turnStartFiles: undefined,
}

/** 一次状态上行 + 账本当前计数（changeCount / fileCount 由调用方从账本读出） */
export interface AgentStateEvent extends SessionStateMsg {
  /** 账本当前总条数 */
  readonly changeCount: number
  /** 账本当前涉及的文件数 */
  readonly fileCount: number
}

/** 本轮完成通知的内容 */
export interface TurnCompleteNotice {
  readonly sessionId: string
  readonly turn: number
  readonly changes: number
  readonly files: number
}

/** 状态栏展示（图标 + 文案 + 颜色主题） */
export interface AgentStatusView {
  readonly text: string
  readonly tooltip: string
  readonly color: 'charts.green' | 'charts.yellow' | 'descriptionForeground'
}

/**
 * 应用一次状态上行。
 *
 * 关键判定（按优先级）：
 * 1. **会话切换** → 重置本轮基线，且不把切换当成"本轮完成"（否则切换会话会误报完成）；
 * 2. `running: true` 且上一状态非运行 → **本轮开始**，记下变更数基线；
 * 3. `running: false` 且上一状态运行 → **本轮结束**；仅当"本轮确有变更且没有待决交互"时才给通知；
 * 4. 其余情况只更新状态，不产生通知。
 */
export function applySessionState(
  prev: AgentState,
  event: AgentStateEvent,
  opts: { notifyOnTurnComplete: boolean },
): { next: AgentState; notice: TurnCompleteNotice | null } {
  const sessionChanged = prev.sessionId !== event.sessionId
  const baseline = sessionChanged
    ? { turnStartChanges: undefined, turnStartFiles: undefined }
    : { turnStartChanges: prev.turnStartChanges, turnStartFiles: prev.turnStartFiles }

  const startedRunning = event.running && (!prev.running || sessionChanged)
  const stoppedRunning = !event.running && prev.running && !sessionChanged

  const next: AgentState = {
    sessionId: event.sessionId,
    running: event.running,
    turn: event.turn,
    pending: event.pending,
    // 本轮开始时把"此刻的账本计数"记为基线；本轮结束时清掉，避免下一次误算
    turnStartChanges: startedRunning ? event.changeCount : stoppedRunning ? undefined : baseline.turnStartChanges,
    turnStartFiles: startedRunning ? event.fileCount : stoppedRunning ? undefined : baseline.turnStartFiles,
  }

  let notice: TurnCompleteNotice | null = null
  if (stoppedRunning && opts.notifyOnTurnComplete && event.pending === 0) {
    const changes = Math.max(0, event.changeCount - (baseline.turnStartChanges ?? event.changeCount))
    const files = Math.max(0, event.fileCount - (baseline.turnStartFiles ?? event.fileCount))
    if (changes > 0) {
      notice = { sessionId: event.sessionId, turn: prev.turn, changes, files }
    }
  }
  return { next, notice }
}

/** 完成通知文案（纯函数便于断言：没有变更时不该走到这里） */
export function turnCompleteMessage(notice: TurnCompleteNotice): string {
  const target = notice.files > 0 ? `${notice.files} 个文件被修改` : `${notice.changes} 处变更`
  return notice.turn > 0 ? `DSH 第 ${notice.turn} 轮完成：${target}` : `DSH 本轮完成：${target}`
}

/**
 * 状态栏视图。三态优先级：**待决交互 > 运行中 > 空闲**——
 * "等你回答"比"它还活着"更需要被看见（用户可能正卡在一个没人回答的审批上）。
 */
export function agentStatusView(state: AgentState): AgentStatusView {
  if (state.sessionId === undefined) {
    return { text: '$(circle-outline) DSH · 未连接', tooltip: '尚未收到会话状态', color: 'descriptionForeground' }
  }
  if (state.pending > 0) {
    return {
      text: '$(bell) DSH · 等待审批',
      tooltip: `有 ${state.pending} 项待决交互（审批 / 提问）`,
      color: 'charts.yellow',
    }
  }
  if (state.running) {
    return {
      text: state.turn > 0 ? `$(sync~spin) DSH · 运行中 · 第 ${state.turn} 轮` : '$(sync~spin) DSH · 运行中',
      tooltip: 'DSH 正在执行本轮的模型调用与工具',
      color: 'charts.yellow',
    }
  }
  return {
    text: state.turn > 0 ? `$(check) DSH · 空闲 · 第 ${state.turn} 轮结束` : '$(check) DSH · 空闲',
    tooltip: 'DSH 空闲，可以发送新消息',
    color: 'charts.green',
  }
}
