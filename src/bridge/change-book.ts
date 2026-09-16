// src/bridge/change-book.ts — F1：变更账本（持久化 + 去重 + stale 判定 + 变更通知）
//
// 为什么需要它（问题陈述）：A/B 组的修改栈是**扩展进程内存态**，`Developer: Reload Window`
// 后清空 → 历史变更"重载即失忆"（第 12.5 章记录的既有观察）。账本把变更变成**持久对象**：
// 重载、重开会话、切换会话后仍能看到"改过什么、改在哪、能不能撤"。
//
// 职责边界（与 DiffService 的分工，刻意如此）：
//   ChangeBook    = 变更的**持久化权威**：跨 Reload 存活，按「会话 → 文件 → 变更」组织；
//   DiffService   = 变更的**执行者**：高亮 / hover / 撤销 / 丢弃（都要 vscode API）；
//   两者按 callId 对齐：record 时写账本；keep / revert / 清除标记时同步移除账本条目。
//   账本**不自己执行**任何文件操作——撤销经注入的 executor 委托给 DiffService（见构造参数）。
//
// 本模块不 import vscode（Memento 以最小接口注入，撤销以 executor 注入），故可在 node:test 直测。
import { createHash } from 'node:crypto'
import { pathsEqual } from './diff-tracker'

/** 账本持久化键（workspaceState 单键）。改结构必须换版本号——旧数据宁可丢弃也不误读。 */
export const CHANGE_BOOK_KEY = 'dsh.changeBook.v1'

/** 单会话最多保留的变更条数（超出按 time 裁剪最旧者），防止大会话无限膨胀 */
export const MAX_RECORDS_PER_SESSION = 200

/** 变更来源工具（决定"丢弃"语义；未知工具走保守分支） */
export type ChangeTool = 'edit' | 'write' | 'unknown'

/** 变更来源通道：relay = 渲染时实时广播；replay = 历史回放 */
export type ChangeSource = 'relay' | 'replay'

/** 一条变更记录（账本的持久化单元；字段与《交互增强开发方案》§6.1 对齐） */
export interface ChangeRecord {
  /** 稳定工具调用 id（去重 / 单处撤销的定位键） */
  readonly callId: string
  /** 所属会话 id（账本按会话归档；插件未上报时为 'local' 兜底桶） */
  readonly sessionId: string
  /** 所属轮次（0 = 未知） */
  readonly turn: number
  /** 来源工具 */
  readonly tool: ChangeTool
  /** 工作区相对路径（树/显示用；解析不出相对路径时等于 absPath） */
  readonly path: string
  /** 绝对路径（打开/定位用） */
  readonly absPath: string
  /** 改前片段（撤销锚点） */
  readonly oldText: string
  /** 改后片段（当前文件里定位用） */
  readonly newText: string
  /** 记录时间（Unix epoch ms） */
  readonly time: number
  /** 来源通道 */
  readonly source: ChangeSource
  /** 记录时文件内容 sha256 前 16 位（stale 判定基准） */
  readonly fileHashAtRecord: string
}

/** add 的输入（缺省字段由账本归一，便于调用方只传已知信息） */
export interface ChangeRecordInput {
  callId: string
  sessionId?: string
  absPath: string
  /** 相对路径（缺省 = absPath） */
  path?: string
  tool?: string
  oldText?: string
  newText?: string
  turn?: number
  time?: number
  source?: ChangeSource
  fileHashAtRecord?: string
}

/**
 * 撤销结果。前四项与方案 §6.1 一致；后两项是执行层补的兜底（记录不存在 / IO 失败），
 * 使 R4 批量处置能逐条报告失败原因而不是笼统"失败"。
 */
export type RevertOutcome =
  | { status: 'reverted' }
  | { status: 'no-anchor'; reason: string }
  | { status: 'anchor-missing'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'failed'; reason: string }

/** 最小 Memento 接口（VS Code `workspaceState` 的结构子集；测试注入内存实现） */
export interface MementoLike {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): unknown
}

/** 最小 Disposable 形状（避免为了让返回值带 dispose 而 import vscode） */
export interface DisposableLike {
  dispose(): void
}

/** 内容哈希（stale 判定的基准）：sha256 前 16 位十六进制 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 持久化形状（带版本号，便于将来迁移或安全丢弃） */
interface PersistedShape {
  version: 1
  sessions: Record<string, Record<string, ChangeRecord[]>>
}

/** 路径归一为 Map 键：Windows 大小写不敏感（插件路径与 VS Code fsPath 可能大小写不同） */
function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** 把任意工具名归一为账本的三种取值 */
function normalizeTool(tool: string | undefined): ChangeTool {
  return tool === 'edit' || tool === 'write' ? tool : 'unknown'
}

/**
 * 撤销执行器（由 DiffService 注入）：账本只负责"调谁"，不负责"怎么撤"。
 * 返回 R3 形状的结果，账本据此决定是否移除记录（成功才移除）。
 */
export type RevertExecutor = (sessionId: string, callId: string) => Promise<RevertOutcome>

/**
 * 变更账本。
 *
 * 线程模型：扩展主线程单线程，无需锁；所有变更同步更新内存索引，并（可选地）同步持久化。
 */
export class ChangeBook {
  /** sessionId → (pathKey → 记录[]) */
  private readonly index = new Map<string, Map<string, ChangeRecord[]>>()
  private readonly listeners = new Set<() => void>()

  /**
   * @param memento  持久化载体（VS Code workspaceState；缺省 = 纯内存，测试与降级路径）
   * @param executor 撤销执行器（DiffService 注入；缺省 = 账本不能撤销，revert 返回 failed）
   * @param now      时间源（测试可注入固定值）
   */
  constructor(
    private readonly memento?: MementoLike,
    private readonly executor?: RevertExecutor,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.restore()
  }

  /**
   * 新增/覆盖一条变更。
   * 去重规则：**同 sessionId + 同 callId 覆盖**（running 与 settled 两次广播可能带同一 callId，
   * 后到的更权威）；不同 callId 但内容完全相同的情况由 DiffService 侧去重（它能看到文件）。
   * @returns true = 新增；false = 覆盖（调用方据此决定是否记日志）
   */
  add(input: ChangeRecordInput): boolean {
    if (input.callId === '' || input.absPath === '') return false
    const sessionId = input.sessionId !== undefined && input.sessionId !== '' ? input.sessionId : 'local'
    const record: ChangeRecord = {
      callId: input.callId,
      sessionId,
      turn: Number.isFinite(input.turn) ? (input.turn as number) : 0,
      tool: normalizeTool(input.tool),
      path: input.path !== undefined && input.path !== '' ? input.path : input.absPath,
      absPath: input.absPath,
      oldText: input.oldText ?? '',
      newText: input.newText ?? '',
      time: Number.isFinite(input.time) ? (input.time as number) : this.now(),
      source: input.source ?? 'relay',
      fileHashAtRecord: input.fileHashAtRecord ?? '',
    }
    const files = this.ensureSession(sessionId)
    const key = pathKey(record.absPath)
    const list = files.get(key) ?? []
    const at = list.findIndex((r) => r.callId === record.callId)
    const isNew = at === -1
    if (isNew) list.push(record)
    else list[at] = record
    // 必须先挂回 map 再裁剪：trimSession 会按 key 写回**新的**数组，
    // 若顺序颠倒（先裁剪后 set），会把未裁剪的原数组盖回去 → 上限彻底失效
    // （单测"单会话超限按 time 裁剪最旧"就是这么抓到的）。
    files.set(key, list)
    this.trimSession(files)
    this.persist()
    this.emit()
    return isNew
  }

  /** 某会话的全部记录（可按文件过滤），按 time 升序（越新越后） */
  records(sessionId: string, absPath?: string): readonly ChangeRecord[] {
    const files = this.index.get(sessionId)
    if (files === undefined) return []
    const out: ChangeRecord[] = []
    for (const [key, list] of files) {
      if (absPath !== undefined && key !== pathKey(absPath)) continue
      out.push(...list)
    }
    return out.sort((a, b) => a.time - b.time)
  }

  /** 账本里的全部会话 id（升序，便于树渲染稳定） */
  sessions(): readonly string[] {
    return [...this.index.keys()].sort()
  }

  /** 某会话里出现过的全部绝对路径（升序） */
  files(sessionId: string): readonly string[] {
    const files = this.index.get(sessionId)
    if (files === undefined) return []
    const seen = new Map<string, string>()
    for (const list of files.values()) {
      const first = list[0]
      if (first !== undefined) seen.set(pathKey(first.absPath), first.absPath)
    }
    return [...seen.values()].sort()
  }

  /** 最近一条记录（按 time；跨文件取全局最新） */
  latest(sessionId: string): ChangeRecord | undefined {
    const all = this.records(sessionId)
    return all.length === 0 ? undefined : all[all.length - 1]
  }

  /** 精确取一条记录 */
  get(sessionId: string, callId: string): ChangeRecord | undefined {
    return this.records(sessionId).find((r) => r.callId === callId)
  }

  /** 账本总条数（无 sessionId = 全部；便于日志与测试断言） */
  count(sessionId?: string): number {
    if (sessionId === undefined) {
      let n = 0
      for (const id of this.index.keys()) n += this.records(id).length
      return n
    }
    return this.records(sessionId).length
  }

  /**
   * 保留一处（keep）：只从账本移除该条，**不动文件**。
   * @returns 是否命中并移除
   */
  keep(sessionId: string, callId: string): boolean {
    return this.remove(sessionId, callId)
  }

  /** 批量保留（keepAll）：按文件或整会话；@returns 移除条数 */
  keepAll(sessionId: string, absPath?: string): number {
    let removed = 0
    for (const rec of this.records(sessionId, absPath)) {
      if (this.remove(sessionId, rec.callId)) removed += 1
    }
    return removed
  }

  /**
   * 刷新一条记录的"记录时哈希"（其余字段不动）。
   *
   * 为什么需要：running 与 settled 两次广播同一处改动时，宿主按内容去重会**跳过第二条**，
   * 于是账本里留下的是 running 那一刻读到的哈希（文件尚未落盘）→ 之后文件已是新内容，
   * `staleFor` 会把"DSH 自己刚改完的文件"误报成"被外部修改"。settled 广播带来的才是落盘后的
   * 权威内容，用本方法把哈希补正即可（保持"一处改动一条记录"）。
   *
   * @param callId           目标记录
   * @param fileHashAtRecord 新的哈希（空串 = 未知，stale 判定将不再报警）
   * @param time             新的记录时间（缺省保持原值）
   * @returns 是否命中并更新
   */
  refreshHash(callId: string, fileHashAtRecord: string, time?: number): boolean {
    for (const files of this.index.values()) {
      for (const [key, list] of files) {
        const at = list.findIndex((r) => r.callId === callId)
        if (at === -1) continue
        const prev = list[at] as ChangeRecord
        list[at] = { ...prev, fileHashAtRecord, time: typeof time === 'number' ? time : prev.time }
        files.set(key, list)
        this.persist()
        this.emit()
        return true
      }
    }
    return false
  }

  /**
   * 按 callId 跨会话移除（调用方只知道 callId 时的便捷入口）。
   * 存在意义：DiffService 的 keep / revert / 清除标记路径手上只有 callId（sessionId 在记账时才用到），
   * 让它自己去猜会话会把耦合推给调用方；这里扫一遍（条数上限 200/会话，代价可忽略）。
   * @returns 是否命中并移除
   */
  removeByCallId(callId: string): boolean {
    for (const sessionId of this.index.keys()) {
      if (this.remove(sessionId, callId)) return true
    }
    return false
  }

  /** 清除某文件的全部记录（等同对该文件逐条 keep）；@returns 移除条数 */
  clearFile(sessionId: string, absPath: string): number {
    return this.keepAll(sessionId, absPath)
  }

  /** 某文件里"文件已被外部修改"的记录（与当前内容哈希不一致）；不删除，供 UI 置灰提示 */
  staleFor(absPath: string, currentHash: string, sessionId?: string): readonly ChangeRecord[] {
    const targets = sessionId === undefined ? this.sessions() : [sessionId]
    const out: ChangeRecord[] = []
    for (const id of targets) {
      for (const rec of this.records(id, absPath)) {
        if (isStale(rec, currentHash)) out.push(rec)
      }
    }
    return out
  }

  /** 订阅变更（树 / 导航 / CodeLens 重绘） */
  onChange(listener: () => void): DisposableLike {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  /**
   * 撤销一处（委托注入的 executor）。
   * 只有执行成功（reverted）才移除记录；失败保留记录，便于用户重试或看清原因。
   */
  async revert(sessionId: string, callId: string): Promise<RevertOutcome> {
    const rec = this.get(sessionId, callId)
    if (rec === undefined) return { status: 'missing', reason: 'record not found' }
    if (this.executor === undefined) return { status: 'failed', reason: 'no revert executor' }
    const outcome = await this.executor(sessionId, callId)
    if (outcome.status === 'reverted') this.remove(sessionId, callId)
    return outcome
  }

  /** 批量撤销（按文件或整会话）；逐条执行、逐条报告（F4 的批量语义） */
  async revertAll(sessionId: string, absPath?: string): Promise<RevertOutcome[]> {
    const targets = this.records(sessionId, absPath)
    const out: RevertOutcome[] = []
    for (const rec of targets) out.push(await this.revert(sessionId, rec.callId))
    return out
  }

  /** 清空（测试与"重置账本"用） */
  clear(): void {
    this.index.clear()
    this.persist()
    this.emit()
  }

  // —— 内部 ——

  private ensureSession(sessionId: string): Map<string, ChangeRecord[]> {
    let files = this.index.get(sessionId)
    if (files === undefined) {
      files = new Map()
      this.index.set(sessionId, files)
    }
    return files
  }

  private remove(sessionId: string, callId: string): boolean {
    const files = this.index.get(sessionId)
    if (files === undefined) return false
    for (const [key, list] of files) {
      const at = list.findIndex((r) => r.callId === callId)
      if (at === -1) continue
      list.splice(at, 1)
      if (list.length === 0) files.delete(key)
      if (files.size === 0) this.index.delete(sessionId)
      this.persist()
      this.emit()
      return true
    }
    return false
  }

  /** 单会话超限时裁掉最旧的记录；@returns 是否发生了裁剪 */
  private trimSession(files: Map<string, ChangeRecord[]>): boolean {
    let total = 0
    for (const list of files.values()) total += list.length
    if (total <= MAX_RECORDS_PER_SESSION) return false
    const flat: ChangeRecord[] = []
    for (const list of files.values()) flat.push(...list)
    flat.sort((a, b) => a.time - b.time)
    const drop = new Set(flat.slice(0, total - MAX_RECORDS_PER_SESSION).map((r) => `${pathKey(r.absPath)}|${r.callId}`))
    for (const [key, list] of files) {
      const kept = list.filter((r) => !drop.has(`${key}|${r.callId}`))
      if (kept.length === 0) files.delete(key)
      else files.set(key, kept)
    }
    return true
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // 订阅者异常不影响账本自身（重绘失败不该让写入失败）
      }
    }
  }

  /** 落盘（失败静默：账本是增强能力，不能因为持久化失败影响主流程） */
  private persist(): void {
    if (this.memento === undefined) return
    try {
      this.memento.update(CHANGE_BOOK_KEY, this.serialize())
    } catch {
      /* 忽略：下次写入会再试 */
    }
  }

  /** 序列化为持久化形状（跳过空会话/空文件，控制体积） */
  serialize(): PersistedShape {
    const sessions: Record<string, Record<string, ChangeRecord[]>> = {}
    for (const [sessionId, files] of this.index) {
      const out: Record<string, ChangeRecord[]> = {}
      for (const [key, list] of files) {
        if (list.length > 0) out[key] = list
      }
      if (Object.keys(out).length > 0) sessions[sessionId] = out
    }
    return { version: 1, sessions }
  }

  /** 从 memento 恢复；结构不认识（版本不符 / 形状异常）时**整块丢弃**，绝不半信半疑地读 */
  private restore(): void {
    if (this.memento === undefined) return
    let raw: unknown
    try {
      raw = this.memento.get<unknown>(CHANGE_BOOK_KEY)
    } catch {
      return
    }
    if (raw === null || typeof raw !== 'object') return
    const shape = raw as Partial<PersistedShape>
    if (shape.version !== 1 || shape.sessions === null || typeof shape.sessions !== 'object') return
    for (const [sessionId, files] of Object.entries(shape.sessions as Record<string, unknown>)) {
      if (files === null || typeof files !== 'object') continue
      for (const list of Object.values(files as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue
        for (const item of list) {
          const rec = this.sanitize(item)
          if (rec === null) continue
          const bucket = this.ensureSession(sessionId)
          const key = pathKey(rec.absPath)
          bucket.set(key, [...(bucket.get(key) ?? []), rec])
        }
      }
    }
  }

  /** 逐字段校验一条持久化记录；任一必填缺失 → null（宁可少一条也不带着坏数据跑） */
  private sanitize(item: unknown): ChangeRecord | null {
    if (item === null || typeof item !== 'object') return null
    const r = item as Partial<ChangeRecord>
    if (typeof r.callId !== 'string' || r.callId === '') return null
    if (typeof r.absPath !== 'string' || r.absPath === '') return null
    return {
      callId: r.callId,
      sessionId: typeof r.sessionId === 'string' && r.sessionId !== '' ? r.sessionId : 'local',
      turn: typeof r.turn === 'number' && Number.isFinite(r.turn) ? r.turn : 0,
      tool: normalizeTool(r.tool),
      path: typeof r.path === 'string' && r.path !== '' ? r.path : r.absPath,
      absPath: r.absPath,
      oldText: typeof r.oldText === 'string' ? r.oldText : '',
      newText: typeof r.newText === 'string' ? r.newText : '',
      time: typeof r.time === 'number' && Number.isFinite(r.time) ? r.time : this.now(),
      source: r.source === 'replay' ? 'replay' : 'relay',
      fileHashAtRecord: typeof r.fileHashAtRecord === 'string' ? r.fileHashAtRecord : '',
    }
  }
}

/** 记录是否已 stale（文件内容与记录时不一致）。哈希未知（空串）一律视为非 stale。 */
export function isStale(record: ChangeRecord, currentHash: string): boolean {
  if (record.fileHashAtRecord === '' || currentHash === '') return false
  return record.fileHashAtRecord !== currentHash
}

/** 供调用方按路径查记录时的路径比较（复用 diff-tracker 的 Windows 大小写规则） */
export { pathsEqual }
