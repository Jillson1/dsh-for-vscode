// src/checkpoints/checkpoint-content.ts — F9 检查点内容提供者 + 原生 diff
//
// 只读虚拟文档（scheme `dsh-checkpoint`）：VS Code 的 diff 编辑器天然是**按需读取**的，
// 因此这里也按需从 blob 读内容并缓存（一个检查点可能有数百文件、上 MB，不能一次性载入）。
//
// uri 与 blob 的映射放在一张注册表里（而不是从 uri 反解析字符串）：
// 反解析要在 scheme/host/path/query 之间拼字符串并在 Windows 路径上做转义，
// 是"看起来更优雅、出错更难查"的写法。
import * as vscode from 'vscode'
import type { CheckpointSummary } from './checkpoint-model'
import { diffTitles } from './checkpoint-model'
import type { CheckpointStore } from './checkpoint-store'

/** 虚拟文档 scheme */
export const CHECKPOINT_SCHEME = 'dsh-checkpoint'

/** 一个虚拟文档指向的 blob（注册表值） */
export interface BlobRef {
  readonly workspaceHash: string
  readonly blob: string
  /** 展示用相对路径（diff 标题） */
  readonly relPath: string
}

/** blob 内容提供者：注册表 + 文本缓存（同一 blob 在两次 diff 间复用） */
export class CheckpointContentProvider implements vscode.TextDocumentContentProvider {
  private readonly refs = new Map<string, BlobRef>()
  private readonly cache = new Map<string, string>()

  constructor(private readonly store: CheckpointStore) {}

  /** 为一个 blob 造 uri 并登记（同一 blob+路径复用同一 uri，避免编辑器里堆 tab） */
  uriFor(ref: BlobRef): vscode.Uri {
    const key = `${ref.workspaceHash}:${ref.blob}:${ref.relPath}`
    const uri = vscode.Uri.parse(`${CHECKPOINT_SCHEME}:${encodeURIComponent(key)}`)
    this.refs.set(uri.toString(), ref)
    return uri
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = this.refs.get(uri.toString())
    if (ref === undefined) return ''
    const cached = this.cache.get(ref.blob)
    if (cached !== undefined) return cached
    try {
      const text = await this.store.blobText(ref.workspaceHash, ref.blob)
      this.cache.set(ref.blob, text)
      return text
    } catch {
      return `（无法读取该检查点的文件快照：${ref.relPath}）`
    }
  }

  /** 释放（扩展停用时调用；同时避免长期持有大量文本） */
  dispose(): void {
    this.refs.clear()
    this.cache.clear()
  }
}

/** 注册内容提供者 */
export function registerCheckpointContent(
  provider: CheckpointContentProvider,
): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, provider)
}

/**
 * 打开「检查点快照 ↔ 当前文件」的原生 diff。
 *
 * 右侧用**当前文件**（Uri.file）而不是另一份虚拟文档：这样 VS Code 会把它当成真实的
 * 文件 diff（可保存、可比较、可撤销），而不是两个只读副本比较。
 * 当前文件已被删除时退化为"快照 ↔ 空文档"，用户仍能看到被删内容。
 */
export async function showCheckpointDiff(
  provider: CheckpointContentProvider,
  checkpoint: CheckpointSummary,
  workspaceHash: string,
  relPath: string,
  absPath: string,
  blob: string,
): Promise<void> {
  const left = provider.uriFor({ workspaceHash, blob, relPath })
  const exists = await fileExists(absPath)
  const right = exists ? vscode.Uri.file(absPath) : provider.uriFor({ workspaceHash, blob: '', relPath: '（文件已删除）' })
  const titles = diffTitles(checkpoint, relPath)
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    right === undefined ? titles.left : `${titles.left} ↔ ${titles.right}`,
  )
}

/** 文件是否存在（diff 的右侧选择用） */
async function fileExists(path: string): Promise<boolean> {
  try {
    const { promises: fs } = await import('node:fs')
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
