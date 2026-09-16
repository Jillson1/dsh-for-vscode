// src/bridge/approval-router.ts — F6 审批闸门（DSH 请求许可 → VS Code 模态框代答）
//
// 数据流：插件转发 `approvalRequest` → 本模块弹模态框 → 决策经桥接下行 `approvalDecision`
// → 插件调用 `PendingWait.respond(...)` 交回 DSH。**零 DSH 源码改动**。
//
// 三条安全边界（方案 §7.6 / §9，都是"宁可不做也不做错"的一侧）：
//   1. **凭据/密钥类请求不在 IDE 代答**（IDE 弹窗适合"允许一次某操作"，不适合替用户处理凭据）；
//   2. **只有两种结果**：`allowed-once` / `rejected`——载荷不支持"总是允许"，因此文案与按钮都不提"记住"；
//   3. **用户没选（Esc / 关掉）就不代答**：保持沉默，DSH 面板仍可回答，绝不默认放行。
import type { PanelDownlink } from '../panel/html'

/** 一次审批请求（扩展侧视图；字段与 host 的 approval/requested 帧对齐） */
export interface ApprovalRequest {
  readonly sessionId: string
  readonly approvalId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
}

/** 决策（与载荷一致：只有两种） */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/** 模态框按钮文案（与载荷语义严格对齐：不出现"总是允许/记住"） */
export const ALLOW_BUTTON = '允许一次'
export const DENY_BUTTON = '拒绝'

/**
 * 敏感工具名模式。
 * 命中时**不在 IDE 代答**并提示用户回到 DSH 面板——凭据输入、密钥写入这类操作
 * 不该由一个 30 秒内就会消失的模态框来决定。
 */
const SENSITIVE_TOOL_PATTERN =
  /(credential|secret|api[-_]?key|token|password|passwd|private[-_]?key|(^|[-_.])env($|[-_.]))/i

/**
 * 工具名是否属于"不在 IDE 代答"的敏感类。
 * 覆盖带分隔符的写法（`read-credential` / `edit-env` / `.env`），但 `environment` 这类
 * 普通词不会误命中（要求 env 是独立词段）。
 */
export function isSensitiveTool(toolName: string): boolean {
  return SENSITIVE_TOOL_PATTERN.test(toolName)
}

/** 模态框正文（纯函数，便于单测断言：含工具名、含原因、不含"记住"之类承诺） */
export function approvalPrompt(req: ApprovalRequest): string {
  const reason = req.reason !== undefined && req.reason !== '' ? `\n原因：${req.reason}` : ''
  return `DSH 请求运行 ${req.toolName}${reason}\n\n只支持「允许一次」或「拒绝」；如需更细的策略，请在 DSH 面板中处理。`
}

/** 依赖（生产接 vscode 模态框与面板下行；测试注入假实现） */
export interface ApprovalRouterDeps {
  /** 弹模态框并等用户选择（生产 = showWarningMessage(..., { modal: true }, 允许, 拒绝)） */
  ask(prompt: string, allow: string, deny: string): Promise<string | undefined>
  /** 下发给 iframe（生产 = provider.postToPage；返回 false 表示面板当前不可达） */
  send(message: PanelDownlink): boolean
  /** 用户可见提示（敏感工具 / 面板不可达） */
  notify(message: string): void
  log?(message: string): void
}

/**
 * 审批路由器。
 *
 * 状态很轻（两张表），因为审批本身是"一问一答"的短命对象：
 * - `pending`：正在等用户选择的请求（用于诊断与去重）；
 * - `answered`：已由 IDE 答过的 approvalId，防止同一请求被重复弹窗。
 *   （浏览器端先答时，插件侧 respond 会抛 already settled 并静默忽略——这是设计好的竞态处理。）
 */
export class ApprovalRouter {
  private readonly pending = new Map<string, ApprovalRequest>()
  private readonly answered = new Set<string>()

  constructor(private readonly deps: ApprovalRouterDeps) {}

  /**
   * 处理一条审批请求。
   * @returns 'allowed-once' | 'rejected' = 已由 IDE 代答；'skipped' = 未代答（敏感/用户未选/面板不可达）
   */
  async onRequest(req: ApprovalRequest): Promise<ApprovalDecision | 'skipped'> {
    if (this.answered.has(req.approvalId)) {
      this.deps.log?.(`approval ${req.approvalId}: 已在 IDE 回答过，忽略重复请求`)
      return 'skipped'
    }
    this.pending.set(req.approvalId, req)
    try {
      if (isSensitiveTool(req.toolName)) {
        // 边界 1：敏感类不代答
        this.deps.log?.(`approval ${req.approvalId}: 工具 ${req.toolName} 属敏感类，不在 IDE 代答`)
        this.deps.notify(`DSH 请求运行「${req.toolName}」（敏感操作）：请在 DSH 面板中处理`)
        return 'skipped'
      }
      const choice = await this.deps.ask(approvalPrompt(req), ALLOW_BUTTON, DENY_BUTTON)
      if (choice !== ALLOW_BUTTON && choice !== DENY_BUTTON) {
        // 边界 3：用户没选 → 不代答（保持 DSH 面板可回答）；绝不默认放行
        this.deps.log?.(`approval ${req.approvalId}: 用户未作出选择，不代答`)
        return 'skipped'
      }
      const outcome: ApprovalDecision = choice === ALLOW_BUTTON ? 'allowed-once' : 'rejected'
      const sent = this.deps.send({
        type: 'bridgeApprovalDecision',
        sessionId: req.sessionId,
        approvalId: req.approvalId,
        outcome,
      })
      if (!sent) {
        // 面板隐藏/未就绪：决策送不回去，如实告知而不是假装已生效
        this.deps.log?.(`approval ${req.approvalId}: 下行不可达，决策未回传`)
        this.deps.notify('DSH 面板当前不可见，审批结果未能回传，请在 DSH 面板中处理')
        return 'skipped'
      }
      this.answered.add(req.approvalId)
      this.deps.log?.(`approval ${req.approvalId} → ${outcome}（tool=${req.toolName}）`)
      return outcome
    } finally {
      this.pending.delete(req.approvalId)
    }
  }

  /** 等待中的请求数（诊断/测试） */
  pendingCount(): number {
    return this.pending.size
  }

  /** 该 approvalId 是否已由 IDE 答过（诊断/测试） */
  hasAnswered(approvalId: string): boolean {
    return this.answered.has(approvalId)
  }

  /** 请求已在别处解决（会话切换 / 浏览器先答）时清理记账，避免长期占用 */
  forget(approvalId: string): void {
    this.pending.delete(approvalId)
    this.answered.delete(approvalId)
  }
}
