// src/bridge/interaction-routing.ts — F6/F8 的"在哪应答"决策（纯逻辑）
//
// 背景（真机反馈）：F8 上线后，DSH 每提一个问题都会在 VS Code 弹 QuickPick——
// 即使你正盯着 DSH 面板（那里已经有同一个问题的原生界面）。审批同理：DSH 面板有审批条，
// IDE 再弹一个模态框就是"同一件事问两遍"，而且模态框会抢焦点。
//
// 因此规则收敛为一处决策：
//   面板可见（用户就在那儿）→ 交给 DSH 面板；面板隐藏（用户在看代码）→ 在 IDE 弹。
// 后一种才是 F6/F8 的价值：不切窗口也能应答。
//
// 抽成纯函数的原因：这条规则决定"会不会重复打扰"，是最该被单测钉住的判断；
// 放在 extension.ts 里就只能靠人眼 review。
import type { PanelMessage } from '../panel/html'

/** 交互在哪一侧呈现 */
export type InteractionDelivery = 'ide' | 'panel'

/** 需要决策的交互种类（与 DSH 的 pending 交互一致） */
export type InteractionKind = 'approval' | 'question'

/** 决策输入 */
export interface DeliveryDecisionInput {
  readonly kind: InteractionKind
  /** 设置 dsh.interaction.onlyWhenPanelHidden（默认 true = 策略 B） */
  readonly onlyWhenPanelHidden: boolean
  /** 左/右任一面板当前可见 */
  readonly panelVisible: boolean
}

/**
 * 决定这次交互由谁呈现。
 *
 * - 设置关闭（false）→ 一律在 IDE 呈现（老行为：总是弹）；
 * - 设置打开且面板可见 → 交给面板（避免同一问题问两遍）；
 * - 设置打开且面板隐藏 → 在 IDE 呈现（F6/F8 的核心价值）。
 */
export function decideDelivery(input: DeliveryDecisionInput): InteractionDelivery {
  if (!input.onlyWhenPanelHidden) return 'ide'
  return input.panelVisible ? 'panel' : 'ide'
}

/** 交给面板时写进日志的说明（统一文案，便于排障时一眼认出"这是策略 B 生效"） */
export function deferredLogLine(kind: InteractionKind): string {
  const label = kind === 'approval' ? '审批' : '提问'
  return `DSH 面板可见，${label}交由面板处理（dsh.interaction.onlyWhenPanelHidden=true；如需始终在 IDE 弹，把该设置关掉）`
}

/** 便于测试与断言：这条消息是否属于"需要决策"的交互 */
export function interactionKindOf(msg: PanelMessage): InteractionKind | null {
  if (msg.type === 'bridgeApprovalRequest') return 'approval'
  if (msg.type === 'bridgeQuestionRequest') return 'question'
  return null
}
