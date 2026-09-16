// src/bridge/question-router.ts — F8 提问 / plan-review 呈现
//
// 数据流：插件转发 `questionRequest` → 本模块按问题形状选 UI → 回执 `questionAnswer`
// → 插件 `wait.respond({ ok:true, value:{ sessionId, answer } })` 交回 DSH。
//
// 契约要点（与 DSH `user-questions` 一致，实测确认）：
//   - 一次 ask() 可以带**多个问题**，但回答必须是**整批一次**（`{ answers: [...] }`），不能拆；
//   - 每个问题的答案形状是 `{ id, selected: string[], custom?: string }`；
//   - `intent.kind === 'plan-review'` 时 `detail` 是计划正文（markdown），`intent.approve`
//     是**批准选项的标签**——判定只看标签，绝不用"选项顺序"猜意图。
//
// 因此本模块的三条规则：
//   1. 有选项 → QuickPick（multiSelect 时多选）；无选项 → InputBox 收自由文本（custom）；
//   2. 任一问题被取消 → **整批不回答**（部分作答等于替用户决定他没决定的问题）；
//   3. plan-review → 先把计划正文开成只读 Markdown 文档，再让用户批准/打回（打回可附理由）。
import type { PanelDownlink } from '../panel/html'

/** 一个问题（`AskUserQuestionItem` 的扩展侧视图） */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

/** 一个选项 */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** 单个问题的答案 */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** 整批答案（wire 形状：`{ answers: [...] }`） */
export interface QuestionAnswer {
  readonly answers: readonly QuestionAnswerItem[]
}

/** 一次提问请求（扩展侧视图） */
export interface QuestionRequest {
  readonly sessionId: string
  readonly questionId: string
  readonly questions: readonly QuestionItem[]
}

/**
 * 窄化上行传来的问题列表：只保留有 `id` + `question` 的对象，选项只保留有 `label` 的项。
 *
 * 为什么在这里窄化而不是信任上游：问题的**形状由模型生成**（`tool-ask-user` 的入参），
 * 缺失字段是可能的；一个没有 id 的问题无法作答，渲染出来只会让人困惑。
 */
export function normalizeQuestions(raw: readonly unknown[]): QuestionItem[] {
  const out: QuestionItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const q = entry as Record<string, unknown>
    if (typeof q.id !== 'string' || q.id === '') continue
    if (typeof q.question !== 'string' || q.question === '') continue
    const item: {
      id: string
      question: string
      detail?: string
      header?: string
      options?: QuestionOption[]
      multiSelect?: boolean
      intent?: { kind: 'plan-review'; approve: string }
    } = { id: q.id, question: q.question }
    if (typeof q.detail === 'string' && q.detail !== '') item.detail = q.detail
    if (typeof q.header === 'string' && q.header !== '') item.header = q.header
    if (q.multiSelect === true) item.multiSelect = true
    if (Array.isArray(q.options)) {
      const options: QuestionOption[] = []
      for (const raw of q.options) {
        if (raw === null || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        if (typeof o.label !== 'string' || o.label === '') continue
        options.push(
          typeof o.description === 'string' && o.description !== ''
            ? { label: o.label, description: o.description }
            : { label: o.label },
        )
      }
      if (options.length > 0) item.options = options
    }
    const intent = q.intent
    if (intent !== null && typeof intent === 'object') {
      const i = intent as Record<string, unknown>
      if (i.kind === 'plan-review' && typeof i.approve === 'string') {
        item.intent = { kind: 'plan-review', approve: i.approve }
      }
    }
    out.push(item)
  }
  return out
}

/** 是否 plan-review 问题（判定看 intent，不看选项文案） */
export function isPlanReview(item: QuestionItem): boolean {
  return item.intent?.kind === 'plan-review'
}

/** 从一批问题里取出 plan-review 问题（没有则 undefined） */
export function planReviewOf(items: readonly QuestionItem[]): QuestionItem | undefined {
  return items.find(isPlanReview)
}

/** 问题的展示标题（header 优先，回退到问题正文首行） */
export function titleOf(item: QuestionItem): string {
  if (item.header !== undefined && item.header !== '') return item.header
  const firstLine = item.question.split('\n')[0] ?? item.question
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine
}

/**
 * 计划审阅文档正文（markdown）。
 * 组装成"标题 + 问题 + 选项 + 计划正文"的顺序：用户打开文档第一眼要看到
 * "这是在让我批什么"，再往下才是计划内容。
 */
export function planDocumentText(item: QuestionItem): string {
  const lines: string[] = []
  lines.push(`# ${titleOf(item)}`)
  lines.push('')
  lines.push(item.question)
  lines.push('')
  const options = item.options ?? []
  if (options.length > 0) {
    lines.push('## 可选决定')
    lines.push('')
    for (const option of options) {
      const mark = isPlanReview(item) && option.label === item.intent?.approve ? '（批准）' : ''
      lines.push(`- **${option.label}**${mark}${option.description === undefined ? '' : ` — ${option.description}`}`)
    }
    lines.push('')
  }
  if (item.detail !== undefined && item.detail !== '') {
    lines.push('## 计划内容')
    lines.push('')
    lines.push(item.detail)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push('_只读文档：决定请回到 VS Code 的选择框（批准 / 打回）。_')
  return lines.join('\n')
}

/** 把逐问的选择组装成 wire 形状的答案 */
export function buildAnswer(
  picks: readonly { item: QuestionItem; selected: readonly string[]; custom?: string }[],
): QuestionAnswer {
  return {
    answers: picks.map((p) => {
      const answer: { id: string; selected: string[]; custom?: string } = {
        id: p.item.id,
        selected: [...p.selected],
      }
      if (p.custom !== undefined && p.custom !== '') answer.custom = p.custom
      return answer
    }),
  }
}

/**
 * 选项排序：把**批准项提到最前**（用户最常选它），但不改变语义——
 * 判定仍只看标签是否等于 `intent.approve`。排序只影响观感，不影响判定。
 */
export function orderPlanOptions(item: QuestionItem): QuestionOption[] {
  const options = [...(item.options ?? [])]
  const approve = item.intent?.approve
  if (approve === undefined) return options
  return options.sort((a, b) => (a.label === approve ? -1 : b.label === approve ? 1 : 0))
}

/** 路由器依赖（生产接 vscode 的 QuickPick/InputBox/文档；测试注入假实现） */
export interface QuestionRouterDeps {
  /** 单选（QuickPick） */
  pickOne(title: string, options: readonly QuestionOption[], placeHolder: string): Promise<string | undefined>
  /** 多选（QuickPick canPickMany） */
  pickMany(title: string, options: readonly QuestionOption[], placeHolder: string): Promise<string[] | undefined>
  /** 自由文本（InputBox） */
  input(title: string, placeHolder: string): Promise<string | undefined>
  /** 把计划正文开成只读文档 */
  openPlan(title: string, markdown: string): Promise<void>
  /** 下发给 iframe（生产 = provider.postToPage） */
  send(message: PanelDownlink): boolean
  /** 用户可见提示（面板不可达等） */
  notify(message: string): void
  log?(message: string): void
}

/**
 * 提问路由器。
 *
 * @returns 'answered' = 已作答并回传；'skipped' = 未作答（用户取消 / 面板不可达 / 重复请求）
 */
export class QuestionRouter {
  private readonly answered = new Set<string>()
  private readonly pending = new Set<string>()

  constructor(private readonly deps: QuestionRouterDeps) {}

  async onRequest(req: QuestionRequest): Promise<'answered' | 'skipped'> {
    if (this.answered.has(req.questionId)) {
      this.deps.log?.(`question ${req.questionId}: 已作答过，忽略重复请求`)
      return 'skipped'
    }
    this.pending.add(req.questionId)
    try {
      const picks: { item: QuestionItem; selected: readonly string[]; custom?: string }[] = []
      for (const item of req.questions) {
        const pick = isPlanReview(item)
          ? await this.askPlanReview(item)
          : await this.askGeneric(item)
        if (pick === undefined) {
          // 规则 2：任一问题被取消 → 整批不回答
          this.deps.log?.(`question ${req.questionId}: 问题「${item.id}」未作答，整批放弃`)
          return 'skipped'
        }
        picks.push(pick)
      }
      const answer = buildAnswer(picks)
      const sent = this.deps.send({
        type: 'bridgeQuestionAnswer',
        sessionId: req.sessionId,
        questionId: req.questionId,
        answer,
      })
      if (!sent) {
        this.deps.log?.(`question ${req.questionId}: 下行不可达，答案未回传`)
        this.deps.notify('DSH 面板当前不可见，回答未能回传，请在 DSH 面板中作答')
        return 'skipped'
      }
      this.answered.add(req.questionId)
      this.deps.log?.(`question ${req.questionId} → 已回答 ${answer.answers.length} 个问题`)
      return 'answered'
    } finally {
      this.pending.delete(req.questionId)
    }
  }

  /** 是否已作答过（诊断/测试） */
  hasAnswered(questionId: string): boolean {
    return this.answered.has(questionId)
  }

  /** 等待中的提问数（诊断/测试） */
  pendingCount(): number {
    return this.pending.size
  }

  /** 忘记记账（会话切换 / 浏览器端先答） */
  forget(questionId: string): void {
    this.answered.delete(questionId)
    this.pending.delete(questionId)
  }

  // —— 两种问法的具体呈现 ——

  /** plan-review：先开只读计划文档，再让用户批准或打回（打回可附理由） */
  private async askPlanReview(
    item: QuestionItem,
  ): Promise<{ item: QuestionItem; selected: readonly string[]; custom?: string } | undefined> {
    await this.deps.openPlan(titleOf(item), planDocumentText(item))
    const approve = item.intent?.approve ?? ''
    const choice = await this.deps.pickOne(titleOf(item), orderPlanOptions(item), '批准或打回该计划')
    if (choice === undefined) return undefined
    if (choice === approve) return { item, selected: [choice] }
    // 打回：理由可选（用户取消理由输入 ≠ 取消打回——打回本身已经决定了）
    const reason = await this.deps.input('打回理由（可留空）', '例如：第 3 步的迁移顺序会锁表')
    return reason === undefined || reason === ''
      ? { item, selected: [choice] }
      : { item, selected: [choice], custom: reason }
  }

  /** 普通问题：有选项 → 单选/多选；无选项 → 自由文本 */
  private async askGeneric(
    item: QuestionItem,
  ): Promise<{ item: QuestionItem; selected: readonly string[]; custom?: string } | undefined> {
    const options = item.options ?? []
    if (options.length === 0) {
      const text = await this.deps.input(titleOf(item), item.detail ?? '请输入你的回答')
      if (text === undefined) return undefined
      return { item, selected: [], custom: text }
    }
    if (item.multiSelect === true) {
      const picked = await this.deps.pickMany(titleOf(item), options, '可多选')
      if (picked === undefined) return undefined
      return { item, selected: picked }
    }
    const one = await this.deps.pickOne(titleOf(item), options, '选择一个选项')
    if (one === undefined) return undefined
    return { item, selected: [one] }
  }
}
