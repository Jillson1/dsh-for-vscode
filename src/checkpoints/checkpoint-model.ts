// src/checkpoints/checkpoint-model.ts — F9 检查点的纯模型
//
// 数据源是 turn-rewind 插件写在磁盘上的账本（`$DSH_HOME/change-ledger/v1`）：
//   workspaces/<hash>/manifests/*.json  每个检查点一份 manifest（含 checkpoints 的全部元信息 + entries）
//   workspaces/<hash>/blobs/<2hex>/<sha256>  内容寻址的文件快照
//
// 本模块只做"把 manifest 变成可展示的模型"，不碰 IO、不 import vscode，因此可直测。
// 版本闸门（`LEDGER_FORMAT_VERSION`）在这里：不认识的格式一律不认，宁可不显示也不误读。
import { createHash } from 'node:crypto'

/** 认识的账本格式版本（turn-rewind 的 LEDGER_FORMAT_VERSION） */
export const LEDGER_FORMAT_VERSION = 1

/** 单次列出的检查点上限（manifest 可能上百份，每次都全读会把树拖慢） */
export const MAX_CHECKPOINTS = 50

/** 单个检查点参与"漂移比较"的文件上限（一个检查点可能含数百文件） */
export const MAX_COMPARE_FILES = 400

/** manifest 里一条文件条目 */
export interface ManifestEntry {
  readonly kind: string
  readonly blob?: string
  readonly size?: number
  readonly mode?: number
}

/** 一个检查点（manifest 的窄化视图） */
export interface CheckpointSummary {
  readonly id: string
  /** 'turn' | 'user' | 'rescue'（未知值原样保留） */
  readonly kind: string
  readonly workspace: string
  readonly sessionId?: string
  readonly label?: string
  readonly turn?: number
  /** 该轮起始消息 seq（POST /turn-rewind 需要它当 messageSeq） */
  readonly turnStartSeq?: number
  readonly createdAt: number
  readonly fileCount: number
  readonly totalBytes: number
  readonly entries: Readonly<Record<string, ManifestEntry>>
}

/** 与当前磁盘对比后的一处漂移 */
export interface CheckpointDrift {
  /** 工作区相对路径（manifest 的 key 就是相对路径） */
  readonly path: string
  /** 'modified' = 内容与检查点不同；'deleted' = 检查点里有、现在没了 */
  readonly kind: 'modified' | 'deleted'
  /** 检查点里的 blob（diff 的旧侧） */
  readonly blob: string | undefined
  readonly size: number | undefined
}

/** 内容哈希（与 diff-service 的判定同一算法：sha256 前 16 位仅用于比较，完整 sha 用于 blob 路径） */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 检查点的时间文案（`MM-DD HH:mm`，本地时区） */
export function formatStamp(createdAt: number): string {
  const d = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 树节点标签：`第 3 轮 · 08-26 14:22 · 283 文件`（非 turn 类检查点退回 kind + 时间） */
export function checkpointLabel(cp: CheckpointSummary): string {
  const when = formatStamp(cp.createdAt)
  const head = cp.turn !== undefined && cp.turn > 0 ? `第 ${cp.turn} 轮 · ${when}` : `${cp.kind} · ${when}`
  return `${head} · ${cp.fileCount} 文件`
}

/** 把 manifest 的 entries 归一为白名单（非对象项丢弃） */
function normalizeEntries(raw: unknown): Record<string, ManifestEntry> {
  const out: Record<string, ManifestEntry> = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (path === '' || value === null || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const normalized: { kind: string; blob?: string; size?: number; mode?: number } = {
      kind: typeof entry.kind === 'string' ? entry.kind : 'file',
    }
    if (typeof entry.blob === 'string' && entry.blob !== '') normalized.blob = entry.blob
    if (typeof entry.size === 'number' && Number.isFinite(entry.size)) normalized.size = entry.size
    if (typeof entry.mode === 'number' && Number.isFinite(entry.mode)) normalized.mode = entry.mode
    out[path] = normalized
  }
  return out
}

/**
 * 窄化一份 manifest。
 *
 * 返回 null 的情况（**宁可整条丢弃**）：版本不认识、缺 id/workspace、entries 不是对象。
 * 带着半个检查点去显示，比"这个检查点看不到"更危险——用户会以为那就是全部内容。
 */
export function sanitizeManifest(raw: unknown): CheckpointSummary | null {
  if (raw === null || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.version !== LEDGER_FORMAT_VERSION) return null
  if (typeof m.id !== 'string' || m.id === '') return null
  if (typeof m.workspace !== 'string' || m.workspace === '') return null
  if (m.entries === null || typeof m.entries !== 'object') return null
  const summary: {
    id: string
    kind: string
    workspace: string
    sessionId?: string
    label?: string
    turn?: number
    turnStartSeq?: number
    createdAt: number
    fileCount: number
    totalBytes: number
    entries: Record<string, ManifestEntry>
  } = {
    id: m.id,
    kind: typeof m.kind === 'string' ? m.kind : 'unknown',
    workspace: m.workspace,
    createdAt: typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0,
    fileCount: typeof m.fileCount === 'number' && Number.isFinite(m.fileCount) ? m.fileCount : 0,
    totalBytes: typeof m.totalBytes === 'number' && Number.isFinite(m.totalBytes) ? m.totalBytes : 0,
    entries: normalizeEntries(m.entries),
  }
  if (typeof m.sessionId === 'string' && m.sessionId !== '') summary.sessionId = m.sessionId
  if (typeof m.label === 'string' && m.label !== '') summary.label = m.label
  if (typeof m.turn === 'number' && Number.isFinite(m.turn)) summary.turn = m.turn
  if (typeof m.turnStartSeq === 'number' && Number.isFinite(m.turnStartSeq)) summary.turnStartSeq = m.turnStartSeq
  return summary
}

/**
 * 把检查点的 entries 与"当前文件哈希"对比，得出漂移列表（近似 `inspect`）。
 *
 * 为什么是"近似"：没有 host 半边时无法枚举"检查点之后新增的文件"（manifest 只记录了当时存在的文件），
 * 所以只报两类：内容不同（modified）与已不存在（deleted）。**宁可少报也不猜**。
 *
 * @param entries      检查点的文件表
 * @param currentHash  相对路径 → 当前内容 sha256（缺失 = 文件不存在）
 * @param limit        参与比较的文件上限（超出按路径截断并报 truncated）
 */
export function compareToCurrent(
  entries: Readonly<Record<string, ManifestEntry>>,
  currentHash: ReadonlyMap<string, string>,
  limit: number = MAX_COMPARE_FILES,
): { drifts: CheckpointDrift[]; compared: number; truncated: number } {
  const paths = Object.keys(entries).sort()
  const considered = paths.slice(0, limit)
  const drifts: CheckpointDrift[] = []
  for (const path of considered) {
    const entry = entries[path]
    if (entry === undefined) continue
    // **先判 blob 再判存在性**：没有 blob 的条目（目录 / 特殊文件）本就无法比较，
    // 若先判"当前不存在"就会把目录报成"已删除"（单测抓到的误报）。
    if (entry.blob === undefined) continue
    const current = currentHash.get(path)
    if (current === undefined) {
      drifts.push({ path, kind: 'deleted', blob: entry.blob, size: entry.size })
      continue
    }
    // 只比内容
    if (entry.blob !== current) drifts.push({ path, kind: 'modified', blob: entry.blob, size: entry.size })
  }
  return { drifts, compared: considered.length, truncated: paths.length - considered.length }
}

/** blob 的磁盘相对路径（`<2hex 前缀>/<sha>`） */
export function blobRelativePath(sha: string): string {
  return `${sha.slice(0, 2)}/${sha}`
}

/** 检查点的 diff 标题（VS Code diff 编辑器左/右标题） */
export function diffTitles(cp: CheckpointSummary, path: string): { left: string; right: string } {
  const when = cp.turn !== undefined && cp.turn > 0 ? `第 ${cp.turn} 轮前` : cp.kind
  return { left: `${path} (${when})`, right: `${path} (现在)` }
}
