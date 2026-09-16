// src/checkpoints/checkpoint-store.ts — F9 检查点存储（只读磁盘，零 DSH 改动）
//
// 账本位置：`$DSH_HOME/change-ledger/v1`（`DSH_HOME` 可覆盖，缺省 `~/.dsh`）。
// 只读 —— 本模块**从不写入**账本；恢复动作走 `/turn-rewind`（由插件执行），
// 因此扩展侧永远不会把账本改坏。
//
// fs 全部注入：既能单测（内存 fs），也便于出问题时把 IO 错误精确定位到某一步。
import { join } from 'node:path'
import {
  MAX_CHECKPOINTS,
  sanitizeManifest,
  type CheckpointSummary,
} from './checkpoint-model'

/** 注入的 fs 子集（生产接 node:fs） */
export interface CheckpointFs {
  /** 列目录（不存在 → 空数组，不抛） */
  readdir(path: string): Promise<string[]>
  /** 读文本文件（不存在 → 抛） */
  readFile(path: string): Promise<string>
  /** mtime（毫秒；不存在 → undefined） */
  mtimeMs(path: string): Promise<number | undefined>
}

/** 存储依赖 */
export interface CheckpointStoreDeps {
  /** 账本根目录（`<DSH_HOME>/change-ledger/v1`） */
  root: string
  fs: CheckpointFs
  log?(message: string): void
}

/** 列出检查点的结果（含截断信息：账本可能有上百份 manifest） */
export interface CheckpointList {
  readonly checkpoints: readonly CheckpointSummary[]
  /** 目录里的 manifest 总数 */
  readonly total: number
  /** 因上限未读取的份数 */
  readonly skipped: number
}

/** 一个检查点参与比较的文件（tree 的第二层用） */
export interface CheckpointFileEntry {
  readonly path: string
  readonly blob: string | undefined
  readonly size: number | undefined
}

export class CheckpointStore {
  constructor(private readonly deps: CheckpointStoreDeps) {}

  /** workspace 目录（<root>/workspaces/<hash>） */
  private workspaceDir(hash: string): string {
    return join(this.deps.root, 'workspaces', hash)
  }

  /** 账本里的全部工作区 hash 目录（升序） */
  async workspaces(): Promise<string[]> {
    const dir = join(this.deps.root, 'workspaces')
    const names = await this.deps.fs.readdir(dir).catch(() => [] as string[])
    return names.filter((n) => n !== '' && !n.startsWith('.')).sort()
  }

  /** 某工作区的 manifest 文件名（.json） */
  private async manifestNames(hash: string): Promise<string[]> {
    const names = await this.deps.fs.readdir(join(this.workspaceDir(hash), 'manifests')).catch(() => [] as string[])
    return names.filter((n) => n.endsWith('.json'))
  }

  /**
   * 列出某工作区的检查点（**按 mtime 倒序取最新 N 份**）。
   *
   * 为什么要限流：manifest 里嵌着完整的 entries（数百文件），本机实测单个工作区 149 份。
   * 全读会把树打开变成秒级卡顿；而"最近若干轮"才是用户实际会用的。
   */
  async checkpoints(hash: string, limit: number = MAX_CHECKPOINTS): Promise<CheckpointList> {
    const names = await this.manifestNames(hash)
    if (names.length === 0) return { checkpoints: [], total: 0, skipped: 0 }
    const dir = join(this.workspaceDir(hash), 'manifests')
    const stamped: { name: string; mtime: number }[] = []
    for (const name of names) {
      const mtime = await this.deps.fs.mtimeMs(join(dir, name))
      stamped.push({ name, mtime: mtime ?? 0 })
    }
    // 同一 mtime 时用文件名兜底排序，保证结果稳定（否则同一份账本两次打开顺序可能不同）
    stamped.sort((a, b) => (b.mtime - a.mtime) || b.name.localeCompare(a.name))
    const chosen = stamped.slice(0, Math.max(1, limit))
    const out: CheckpointSummary[] = []
    for (const item of chosen) {
      const raw = await this.deps.fs.readFile(join(dir, item.name)).catch(() => null)
      if (raw === null) {
        this.deps.log?.(`checkpoint: 读取失败 ${item.name}`)
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.deps.log?.(`checkpoint: JSON 解析失败 ${item.name}（账本损坏？已跳过）`)
        continue
      }
      const summary = sanitizeManifest(parsed)
      if (summary === null) {
        this.deps.log?.(`checkpoint: 格式不认（版本闸门）${item.name}，已跳过`)
        continue
      }
      out.push(summary)
    }
    return { checkpoints: out, total: names.length, skipped: names.length - chosen.length }
  }

  /**
   * 找出 cwd 对应的工作区 hash。
   *
   * 实现要点：每个工作区**只读一份** manifest 取 `workspace` 字段做比较，
   * 而不是把全部 manifest 都读一遍（后者要读几十 MB）。比较用大小写不敏感（Windows）。
   */
  async matchWorkspace(cwd: string, workspaces?: readonly string[]): Promise<string | null> {
    const hashes = workspaces ?? (await this.workspaces())
    const target = normalizePath(cwd)
    if (target === '') return null
    for (const hash of hashes) {
      const names = await this.manifestNames(hash)
      // 任一 manifest 都能给出 workspace（同一工作区的 manifest 必然一致）
      const sample = names[0]
      if (sample === undefined) continue
      const raw = await this.deps.fs
        .readFile(join(this.workspaceDir(hash), 'manifests', sample))
        .catch(() => null)
      if (raw === null) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const workspace = (parsed as { workspace?: unknown }).workspace
      if (typeof workspace === 'string' && normalizePath(workspace) === target) return hash
    }
    return null
  }

  /** 读一个 blob（内容寻址；返回文本，二进制文件会得到乱码——UI 侧按需截断显示） */
  async blobText(hash: string, sha: string): Promise<string> {
    return this.deps.fs.readFile(join(this.workspaceDir(hash), 'blobs', sha.slice(0, 2), sha))
  }

  /** 某个检查点的文件条目（已排序、按上限截断） */
  files(checkpoint: CheckpointSummary, limit = 400): { files: CheckpointFileEntry[]; truncated: number } {
    const paths = Object.keys(checkpoint.entries).sort()
    const chosen = paths.slice(0, limit)
    const files: CheckpointFileEntry[] = []
    for (const path of chosen) {
      const entry = checkpoint.entries[path]
      if (entry === undefined) continue
      files.push({ path, blob: entry.blob, size: entry.size })
    }
    return { files, truncated: paths.length - chosen.length }
  }
}

/**
 * 路径归一：去尾部分隔符 → **统一分隔符为 '/'** → Windows 大小写不敏感。
 *
 * 统一分隔符不是洁癖：manifest 里的 `workspace` 由引擎写（Windows 上是反斜杠），
 * 而调用方传进来的可能是 VS Code 的 fsPath 或用户手输的路径，两者混用会让
 * `matchWorkspace` 静默匹配不上——表现为"明明有检查点却显示当前工作区无检查点"。
 */
export function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, '/').replace(/[\/]+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** 账本根目录：`$DSH_HOME/change-ledger/v1`（缺省 `~/.dsh/change-ledger/v1`） */
export function ledgerRoot(dshHome: string): string {
  return join(dshHome, 'change-ledger', 'v1')
}
