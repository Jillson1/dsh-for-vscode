// src/changes/tree-model.ts — F3 `DSH Changes` 树的纯模型
//
// 树的形状与文案在纯逻辑里定死（会话 → 文件 → 变更），vscode 层只把它翻译成 TreeItem。
// 这样"分组是否正确、排序是否稳定、stale 是否标注"都可以单测，而 vscode 层薄到不需要测。
//
// 与账本的关系：数据源永远是 ChangeBook（F1 的持久化权威），此处只做**投影 + 文案**，
// 不持有状态、不读文件（当前哈希由调用方传入，见 `hashes`）。
import { summarizeDiff, diffNature, type DiffNature } from '../bridge/diff-tracker'
import { isStale, type ChangeBook, type ChangeRecord, type ChangeTool } from '../bridge/change-book'

/** 一条变更在树里的展示模型 */
export interface ChangeNodeView {
  readonly kind: 'change'
  readonly callId: string
  /** 变更性质（新增 / 删除 / 修改） */
  readonly nature: DiffNature
  /** 主标签，如 `修改 +2 −1` */
  readonly label: string
  /** 次标签，如 `14:22`（stale 时追加 `· 文件已被外部修改`） */
  readonly description: string
  /** 记录时间（Unix epoch ms） */
  readonly time: number
  readonly tool: ChangeTool
  /** 文件内容与记录时不一致（外部改动过） */
  readonly stale: boolean
}

/** 一个文件在树里的展示模型 */
export interface FileNodeView {
  readonly kind: 'file'
  readonly absPath: string
  /** 工作区相对路径（树标签用；解析不出相对路径时等于 absPath） */
  readonly path: string
  /** 变更列表（按 time 升序：越新越靠下，与导航顺序一致） */
  readonly changes: readonly ChangeNodeView[]
  /** 其中 stale 的条数（文件级提示） */
  readonly staleCount: number
}

/** 一个会话在树里的展示模型 */
export interface SessionNodeView {
  readonly kind: 'session'
  readonly sessionId: string
  /** 主标签（会话 id 截断显示） */
  readonly label: string
  /** 次标签，如 `3 文件 · 7 处变更` */
  readonly description: string
  readonly files: readonly FileNodeView[]
  /** 该会话的变更总数（含各文件） */
  readonly changeCount: number
}

/** 变更性质 → 中文动词（labels 保持一致，避免树里中英混排） */
export function natureVerb(nature: DiffNature): string {
  return nature === 'add' ? '新增' : nature === 'del' ? '删除' : '修改'
}

/** 时间 → `HH:MM`（本地时区；纯函数便于断言） */
export function formatClock(time: number): string {
  const d = new Date(time)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 会话 id 截断显示（DSH 的 session id 形如 session-xxxx-…-yyyy，取首尾便于辨认） */
export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
}

/** 一条记录的展示模型（纯函数：入参齐了就完全确定） */
export function changeNodeView(record: ChangeRecord, currentHash: string | undefined): ChangeNodeView {
  const nature = diffNature(record.oldText, record.newText)
  const { added, deleted } = summarizeDiff(record.oldText, record.newText)
  // 计数只在有意义时才出现：纯新增不显示 −0，纯删除不显示 +0
  const delta = [added > 0 ? `+${added}` : '', deleted > 0 ? `−${deleted}` : ''].filter((s) => s !== '').join(' ')
  const stale = currentHash !== undefined && isStale(record, currentHash)
  const meta = [formatClock(record.time), stale ? '文件已被外部修改' : ''].filter((s) => s !== '').join(' · ')
  return {
    kind: 'change',
    callId: record.callId,
    nature,
    label: delta === '' ? natureVerb(nature) : `${natureVerb(nature)} ${delta}`,
    description: meta,
    time: record.time,
    tool: record.tool,
    stale,
  }
}

/**
 * 把一个会话的记录投影成树模型。
 *
 * 排序规则（稳定、可预期）：
 * - 文件按相对路径升序；
 * - 文件内变更按 time 升序（越新越靠下）。
 * @param records    该会话的全部记录（通常来自 book.records(sessionId)）
 * @param hashes     绝对路径 → 当前文件内容哈希（缺省 = 不做 stale 判定）
 */
export function fileViews(records: readonly ChangeRecord[], hashes?: ReadonlyMap<string, string>): FileNodeView[] {
  const byPath = new Map<string, ChangeRecord[]>()
  for (const rec of records) {
    const list = byPath.get(rec.absPath) ?? []
    list.push(rec)
    byPath.set(rec.absPath, list)
  }
  const views: FileNodeView[] = []
  for (const [absPath, list] of byPath) {
    const sorted = [...list].sort((a, b) => a.time - b.time)
    const hash = hashes?.get(absPath)
    const changes = sorted.map((r) => changeNodeView(r, hash))
    views.push({
      kind: 'file',
      absPath,
      path: sorted[0]?.path ?? absPath,
      changes,
      staleCount: changes.filter((c) => c.stale).length,
    })
  }
  return views.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 把账本投影成整棵树（会话 → 文件 → 变更）。
 * @param book   变更账本（唯一数据源）
 * @param hashes 绝对路径 → 当前内容哈希（缺省 = 不做 stale 判定）
 */
export function buildTree(book: ChangeBook, hashes?: ReadonlyMap<string, string>): SessionNodeView[] {
  const out: SessionNodeView[] = []
  for (const sessionId of book.sessions()) {
    const records = book.records(sessionId)
    if (records.length === 0) continue
    const files = fileViews(records, hashes)
    out.push({
      kind: 'session',
      sessionId,
      label: shortSessionId(sessionId),
      description: `${files.length} 文件 · ${records.length} 处变更`,
      files,
      changeCount: records.length,
    })
  }
  return out
}
