// src/changes/batch.ts — F4 批量处置的纯逻辑
//
// 三件事，全部与 vscode 无关（因此可直测）：
//   ① 归一"这次批量要处理哪些目标"（树的多选 / 单击 / 命令面板三种入口形状不同）；
//   ② 把逐条执行的结果汇总成一句人话（方案 §7.4：逐条报告，如"成功 7，失败 2（anchor-missing ×2）"）；
//   ③ 决定失败条目该如何留痕（留在树里并标红）。
//
// 为什么汇总要单独成纯函数：批量失败是最容易被"笼统报成功"掩盖的地方——一次 10 条里有 2 条锚点失效，
// 用户看到"已丢弃"就以为文件干净了。文案必须带**失败条数与原因分布**。
import type { ChangeBook, RevertOutcome } from '../bridge/change-book'

/** 批量目标：三种粒度（会话 / 文件 / 单个变更） */
export type BatchTarget =
  | { readonly scope: 'session'; readonly sessionId: string }
  | { readonly scope: 'file'; readonly sessionId: string; readonly absPath: string }
  | { readonly scope: 'change'; readonly sessionId: string; readonly callId: string; readonly absPath: string }

/**
 * 批量节点的**结构形状**（与 changes-tree 的节点兼容，但本模块不 import vscode，
 * 因此这里只描述"需要读到什么"）。
 */
export interface BatchNodeLike {
  readonly kind: string
  readonly sessionId?: string
  readonly absPath?: string
  readonly callId?: string
}

/**
 * 归一入口实参为节点数组。
 *
 * VS Code 的实参形状随入口而变（实测）：
 * - 树节点右键（单选）：节点对象本身；
 * - 树节点右键（多选）：节点对象数组；
 * - 命令面板 / 视图标题按钮：不是节点（面板调用时是 undefined，标题按钮会给 view 对象）；
 *   此时回落到 `fallbackSelection`（调用方传 treeView.selection）。
 */
export function normalizeNodes(arg: unknown, fallbackSelection: readonly unknown[] = []): BatchNodeLike[] {
  const asNode = (v: unknown): BatchNodeLike | null => {
    if (v === null || typeof v !== 'object') return null
    const kind = (v as { kind?: unknown }).kind
    if (kind !== 'session' && kind !== 'file' && kind !== 'change') return null
    return v as BatchNodeLike
  }
  if (Array.isArray(arg)) {
    return arg.map(asNode).filter((n): n is BatchNodeLike => n !== null)
  }
  const single = asNode(arg)
  if (single !== null) return [single]
  // 非节点实参（undefined / view 对象）→ 回落到树选择
  return fallbackSelection.map(asNode).filter((n): n is BatchNodeLike => n !== null)
}

/**
 * 节点 → 批量目标，并按粒度**去重**（多选里父子节点重叠时不应重复处理）。
 * 顺序保持稳定（会话 → 文件 → 变更，与树的层级一致），便于日志与断言。
 */
export function targetsFromNodes(nodes: readonly BatchNodeLike[]): BatchTarget[] {
  const sessions = new Set<string>()
  const files = new Map<string, { sessionId: string; absPath: string }>()
  const changes = new Map<string, { sessionId: string; callId: string; absPath: string }>()
  for (const node of nodes) {
    if (node.kind === 'session') {
      if (node.sessionId !== undefined && node.sessionId !== '') sessions.add(node.sessionId)
      continue
    }
    if (node.kind === 'file') {
      if (node.sessionId !== undefined && node.absPath !== undefined && node.absPath !== '') {
        files.set(`${node.sessionId}|${node.absPath}`, { sessionId: node.sessionId, absPath: node.absPath })
      }
      continue
    }
    if (node.kind === 'change') {
      if (node.sessionId !== undefined && node.callId !== undefined && node.callId !== '') {
        changes.set(`${node.sessionId}|${node.callId}`, {
          sessionId: node.sessionId,
          callId: node.callId,
          absPath: node.absPath ?? '',
        })
      }
    }
  }
  const out: BatchTarget[] = []
  for (const sessionId of sessions) out.push({ scope: 'session', sessionId })
  for (const file of files.values()) out.push({ scope: 'file', ...file })
  for (const change of changes.values()) out.push({ scope: 'change', ...change })
  return out
}

/** 批量结果汇总 */
export interface BatchSummary {
  /** 成功条数 */
  readonly ok: number
  /** 失败条数 */
  readonly failed: number
  /** 失败原因分布（status → 条数），仅含失败项 */
  readonly byStatus: Readonly<Record<string, number>>
  /** 一次性可展示的文案（成功时也给出条数，便于确认"真的动了 N 处"） */
  readonly text: string
}

/** 失败原因的中文短标签（用户看的是"为什么没成"，不是内部枚举） */
const REASON_LABEL: Readonly<Record<string, string>> = {
  'no-anchor': '无撤销锚点',
  'anchor-missing': '原内容已找不到（文件被改过）',
  refused: '出于安全拒绝执行',
  missing: '记录已不存在',
  failed: '执行失败',
}

/** 把逐条执行结果汇总成一句人话（方案 §7.4 的"逐条报告"） */
export function summarizeOutcomes(outcomes: readonly RevertOutcome[]): BatchSummary {
  let ok = 0
  const byStatus: Record<string, number> = {}
  for (const o of outcomes) {
    if (o.status === 'reverted') {
      ok += 1
      continue
    }
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
  }
  const failed = outcomes.length - ok
  if (outcomes.length === 0) return { ok: 0, failed: 0, byStatus, text: '没有需要处理的变更' }
  if (failed === 0) return { ok, failed, byStatus, text: `已处理 ${ok} 处变更` }
  const detail = Object.entries(byStatus)
    .map(([status, n]) => `${REASON_LABEL[status] ?? status} ×${n}`)
    .join('，')
  return {
    ok,
    failed,
    byStatus,
    text: `成功 ${ok}，失败 ${failed}（${detail}）`,
  }
}

/** 批量保留的汇总（保留没有"失败"分支，但仍要如实报条数） */
export function summarizeKept(requested: number, kept: number): string {
  if (requested === 0) return '没有需要保留的变更'
  if (kept === requested) return `已保留 ${kept} 处变更`
  return `已保留 ${kept}/${requested} 处（其余记录已不存在）`
}

/** 批量作用域的记录数（用于"先算再动手"，避免用户点了个空操作还弹提示） */
export function countForScope(book: ChangeBook, target: BatchTarget): number {
  if (target.scope === 'session') return book.count(target.sessionId)
  if (target.scope === 'file') return book.records(target.sessionId, target.absPath).length
  return book.get(target.sessionId, target.callId) === undefined ? 0 : 1
}
