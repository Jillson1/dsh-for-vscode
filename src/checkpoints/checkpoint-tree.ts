// src/checkpoints/checkpoint-tree.ts — F9 `DSH 检查点` 树（vscode 装配层）
//
// 层级：检查点（第 N 轮 · 时间 · 文件数）→ 漂移文件（相对该检查点已改动 / 已删除）
//
// "受影响文件"是**惰性 + 近似**的：展开某个检查点时才把它的 entries 与当前磁盘逐个比哈希。
// 为什么近似（方案 §7.9 已注明）：manifest 只记录了当时的文件表，无法枚举"之后新增的文件"；
// 因此只报"内容变了"和"已删除"两类，宁可少报也不猜。
import * as vscode from 'vscode'
import {
  MAX_COMPARE_FILES,
  checkpointLabel,
  compareToCurrent,
  sha256Hex,
  type CheckpointDrift,
  type CheckpointSummary,
} from './checkpoint-model'
import type { CheckpointStore } from './checkpoint-store'

/** 树节点 */
export type CheckpointTreeNode =
  | { readonly kind: 'checkpoint'; readonly checkpoint: CheckpointSummary; readonly workspaceHash: string }
  | {
      readonly kind: 'drift'
      readonly checkpoint: CheckpointSummary
      readonly workspaceHash: string
      readonly drift: CheckpointDrift
      readonly absPath: string
    }
  | { readonly kind: 'note'; readonly label: string; readonly tooltip: string }

/** 依赖 */
export interface CheckpointTreeDeps {
  store: CheckpointStore
  /** 当前工作区根目录（决定"哪个账本工作区"与漂移文件的绝对路径） */
  workspaceRoot(): string | undefined
  /** 读当前文件文本（算哈希）；失败表示文件不存在 */
  readFileText(path: string): Promise<string>
  log?(message: string): void
}

export class CheckpointTreeProvider implements vscode.TreeDataProvider<CheckpointTreeNode> {
  private readonly emitter = new vscode.EventEmitter<CheckpointTreeNode | undefined>()
  readonly onDidChangeTreeData = this.emitter.event
  constructor(private readonly deps: CheckpointTreeDeps) {}

  refresh(): void {
    this.emitter.fire(undefined)
  }

  /** 释放（扩展停用时由 context.subscriptions 调用） */
  dispose(): void {
    this.emitter.dispose()
  }

  getTreeItem(node: CheckpointTreeNode): vscode.TreeItem {
    if (node.kind === 'checkpoint') {
      const item = new vscode.TreeItem(checkpointLabel(node.checkpoint), vscode.TreeItemCollapsibleState.Collapsed)
      item.id = `cp:${node.checkpoint.id}`
      item.description = node.checkpoint.label ?? ''
      item.contextValue = 'dsh.checkpoint'
      item.iconPath = new vscode.ThemeIcon('history')
      item.tooltip = [
        node.checkpoint.id,
        `工作区：${node.checkpoint.workspace}`,
        node.checkpoint.sessionId === undefined ? '会话：未知' : `会话：${node.checkpoint.sessionId}`,
        `文件 ${node.checkpoint.fileCount} 个 / ${formatBytes(node.checkpoint.totalBytes)}`,
      ].join('\n')
      return item
    }
    if (node.kind === 'drift') {
      const item = new vscode.TreeItem(node.drift.path, vscode.TreeItemCollapsibleState.None)
      item.id = `drift:${node.checkpoint.id}:${node.drift.path}`
      item.description = node.drift.kind === 'deleted' ? '已删除' : '已修改'
      item.contextValue = 'dsh.checkpointFile'
      item.iconPath = new vscode.ThemeIcon(node.drift.kind === 'deleted' ? 'diff-removed' : 'diff-modified')
      item.resourceUri = vscode.Uri.file(node.absPath)
      item.tooltip = `${node.absPath}\n点击查看「该轮之前 ↔ 现在」的原生 diff`
      item.command = { command: 'dsh.checkpoint.diff', title: '对比该轮之前', arguments: [node] }
      return item
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None)
    item.contextValue = 'dsh.checkpointNote'
    item.iconPath = new vscode.ThemeIcon('info')
    item.tooltip = node.tooltip
    return item
  }

  async getChildren(node?: CheckpointTreeNode): Promise<CheckpointTreeNode[]> {
    if (node === undefined) return this.rootNodes()
    if (node.kind === 'checkpoint') return this.driftNodes(node.checkpoint, node.workspaceHash)
    return []
  }

  /** 根：当前工作区的检查点（无工作区 / 非 git 工作区 / 账本为空 → 一条说明节点） */
  private async rootNodes(): Promise<CheckpointTreeNode[]> {
    const root = this.deps.workspaceRoot()
    if (root === undefined || root === '') {
      return [note('未打开工作区', 'F9 检查点按工作区归档，请先打开一个文件夹。')]
    }
    const hash = await this.deps.store.matchWorkspace(root)
    if (hash === null) {
      return [
        note(
          '当前工作区无检查点',
          `${root}\n\n检查点由 DSH 的 change-ledger（turn-rewind 插件）写入，且只支持常规 git 工作区；` +
            'sparse checkount / submodule 与普通文件夹不会产生检查点。',
        ),
      ]
    }
    const list = await this.deps.store.checkpoints(hash)
    if (list.checkpoints.length === 0) {
      return [note('暂无检查点', `${root}\n\n每次 DSH 轮次开始前会自动打点，跑一轮后这里就会出现。`)]
    }
    const nodes: CheckpointTreeNode[] = list.checkpoints.map((checkpoint) => ({
      kind: 'checkpoint' as const,
      checkpoint,
      workspaceHash: hash,
    }))
    if (list.skipped > 0) {
      nodes.push(
        note(
          `另有 ${list.skipped} 个更早的检查点未列出`,
          `账本共 ${list.total} 个检查点，为避免打开树时读取过多 manifest，只列出最近 ${list.checkpoints.length} 个。`,
        ),
      )
    }
    return nodes
  }

  /** 展开检查点：逐文件比哈希，列出"相对该轮已改动 / 已删除"的文件 */
  private async driftNodes(checkpoint: CheckpointSummary, workspaceHash: string): Promise<CheckpointTreeNode[]> {
    const { files, truncated } = this.deps.store.files(checkpoint, MAX_COMPARE_FILES)
    const current = new Map<string, string>()
    for (const file of files) {
      const abs = joinPath(checkpoint.workspace, file.path)
      try {
        current.set(file.path, sha256Hex(await this.deps.readFileText(abs)))
      } catch {
        // 读不到 = 已删除（比较阶段按"不存在"处理）
      }
    }
    const entries: Record<string, { kind: string; blob?: string; size?: number }> = {}
    for (const file of files) {
      entries[file.path] = {
        kind: 'file',
        ...(file.blob === undefined ? {} : { blob: file.blob }),
        ...(file.size === undefined ? {} : { size: file.size }),
      }
    }
    const { drifts } = compareToCurrent(entries, current, MAX_COMPARE_FILES)
    const nodes: CheckpointTreeNode[] = drifts.map((drift) => ({
      kind: 'drift' as const,
      checkpoint,
      workspaceHash,
      drift,
      absPath: joinPath(checkpoint.workspace, drift.path),
    }))
    if (nodes.length === 0) {
      nodes.push(note('该轮之后没有检测到改动', '当前文件内容与该检查点一致（新增文件不计入，见文档说明）。'))
    }
    if (truncated > 0) {
      nodes.push(note(`另有 ${truncated} 个文件未参与比较`, '单个检查点比较上限 400 个文件。'))
    }
    this.deps.log?.(`checkpoint ${checkpoint.id}: 比较 ${files.length} 个文件，漂移 ${drifts.length} 个`)
    return nodes
  }
}

/** 绝对路径拼接（manifest 里的 key 是相对路径，使用正斜杠） */
function joinPath(root: string, rel: string): string {
  const base = root.replace(/[/\\]+$/, '')
  const tail = rel.replace(/^[/\\]+/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${tail.replace(/[/\\]/g, sep)}`
}

/** 说明节点（空态 / 截断提示） */
function note(label: string, tooltip: string): CheckpointTreeNode {
  return { kind: 'note', label, tooltip }
}

/** 字节数展示 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
