// src/changes/changes-tree.ts — F3 `DSH Changes` 侧边栏树（vscode 装配层）
//
// 数据源永远是 ChangeBook（F1 的持久化权威）：账本变化 → onChange → 失效缓存 → 重绘。
// 树的形状 / 文案 / 排序全部来自 tree-model.ts（纯逻辑，已单测），本层只做三件事：
//   ① 把模型翻译成 TreeItem；② 计算 stale 所需的当前文件哈希；③ 暴露节点给命令用。
import * as vscode from 'vscode'
import { contentHash, type ChangeBook } from '../bridge/change-book'
import {
  buildTree,
  type ChangeNodeView,
  type FileNodeView,
  type SessionNodeView,
} from './tree-model'

/**
 * 树节点（纯数据 + 定位信息）。
 * 命令从树里拿到的是**这个对象**（`view/item/context` 与 TreeItem.command 都把节点作为首个实参），
 * 因此节点自带 sessionId / absPath，命令不需要再去反查树。
 */
export type ChangeTreeNode =
  | { readonly kind: 'session'; readonly view: SessionNodeView }
  | { readonly kind: 'file'; readonly sessionId: string; readonly view: FileNodeView }
  | { readonly kind: 'change'; readonly sessionId: string; readonly absPath: string; readonly view: ChangeNodeView }

/** 树依赖（生产接 vscode 与 node:fs；测试可注入假实现） */
export interface ChangesTreeDeps {
  book: ChangeBook
  /** 读文件文本（算当前哈希 → stale 判定） */
  readFileText(path: string): Promise<string>
  /**
   * 变更集总开关（`dsh.changes.enabled`）的实时读取口（可选，缺省视为开启）。
   * 关闭时树一律为空——连账本都不读（既不显示历史，也不做 stale 的磁盘哈希比对）。
   */
  enabled?(): boolean
  log?(message: string): void
}

/**
 * 参与 stale 判定的文件数上限。
 * stale 只是"置灰 + 提示"，不值得为它把整棵树的渲染拖慢；超出的文件按"不判定"处理（宁可不标，不误标）。
 */
export const MAX_HASH_FILES = 200

/** 变更性质 → 图标（VS Code 内置 diff 图标，与编辑区红绿语义一致） */
function iconFor(nature: ChangeNodeView['nature']): vscode.ThemeIcon {
  if (nature === 'add') return new vscode.ThemeIcon('diff-added')
  if (nature === 'del') return new vscode.ThemeIcon('diff-removed')
  return new vscode.ThemeIcon('diff-modified')
}

/** 取路径最后一段（树标签用 basename，完整路径放 tooltip） */
function baseName(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] ?? p
}

/** 取父目录（文件节点的次标签；解析不出时返回空串） */
function dirName(p: string): string {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return at <= 0 ? '' : p.slice(0, at)
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ChangeTreeNode | undefined>()
  /** 树变化事件（VS Code 用它重绘） */
  readonly onDidChangeTreeData = this.emitter.event
  /** 本次构建的缓存（账本变更时失效） */
  private cached: SessionNodeView[] | undefined
  /**
   * 批量处置的失败留痕：callId → 原因。
   * 方案 §7.4 要求"失败条目保留在树里并标红"——失败后记录仍在账本里（账本只在成功时移除），
   * 这里补的是**视觉留痕**：用户下一次看树时知道哪几条没成、为什么。
   */
  private readonly failed = new Map<string, string>()
  private readonly subscription: { dispose(): void }

  constructor(private readonly deps: ChangesTreeDeps) {
    // 账本一变树就重绘：树不自己持有状态，永远反映账本
    this.subscription = deps.book.onChange(() => this.refresh())
  }

  /** 使缓存失效并触发重绘（账本变化 / 手动刷新命令调用） */
  refresh(): void {
    this.cached = undefined
    this.emitter.fire(undefined)
  }

  /**
   * 记录批量处置的失败条目（标红 + 原因），并立即重绘。
   * 每次批量开始前调用 `clearFailed()`；成功移除的记录在下次构建时被自动剪枝。
   */
  markFailed(entries: readonly { callId: string; reason: string }[]): void {
    for (const e of entries) this.failed.set(e.callId, e.reason)
    this.refresh()
  }

  /** 清空失败留痕（新一轮批量开始时调用） */
  clearFailed(): void {
    if (this.failed.size === 0) return
    this.failed.clear()
    this.refresh()
  }

  /** 带失败留痕的变更节点图标（红色警告；否则按变更性质） */
  private changeIcon(node: Extract<ChangeTreeNode, { kind: 'change' }>): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
    if (this.failed.has(node.view.callId)) {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'))
    }
    return iconFor(node.view.nature)
  }

  dispose(): void {
    this.subscription.dispose()
    this.emitter.dispose()
  }

  getTreeItem(node: ChangeTreeNode): vscode.TreeItem {
    if (node.kind === 'session') return this.sessionItem(node)
    if (node.kind === 'file') return this.fileItem(node)
    return this.changeItem(node)
  }

  async getChildren(node?: ChangeTreeNode): Promise<ChangeTreeNode[]> {
    if (!(this.deps.enabled?.() ?? true)) return [] // 变更集关闭：树为空（不读账本、不碰磁盘）
    if (node === undefined) {
      const tree = await this.loadTree()
      return tree.map((view) => ({ kind: 'session', view }) as ChangeTreeNode)
    }
    if (node.kind === 'session') {
      return node.view.files.map(
        (view) => ({ kind: 'file', sessionId: node.view.sessionId, view }) as ChangeTreeNode,
      )
    }
    if (node.kind === 'file') {
      return node.view.changes.map(
        (view) =>
          ({
            kind: 'change',
            sessionId: node.sessionId,
            absPath: node.view.absPath,
            view,
          }) as ChangeTreeNode,
      )
    }
    return [] // 变更节点是叶子
  }

  // —— 内部 ——

  private sessionItem(node: Extract<ChangeTreeNode, { kind: 'session' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(`会话 ${node.view.label}`, vscode.TreeItemCollapsibleState.Expanded)
    item.id = `session:${node.view.sessionId}`
    item.description = node.view.description
    item.contextValue = 'dsh.session'
    item.iconPath = new vscode.ThemeIcon('history')
    item.tooltip = node.view.sessionId
    return item
  }

  private fileItem(node: Extract<ChangeTreeNode, { kind: 'file' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(baseName(node.view.absPath), vscode.TreeItemCollapsibleState.Collapsed)
    item.id = `file:${node.sessionId}:${node.view.absPath}`
    const dir = dirName(node.view.absPath)
    item.description = node.view.staleCount > 0 ? `${dir} · ${node.view.staleCount} 处已被外部修改` : dir
    item.contextValue = 'dsh.file'
    // resourceUri 让 VS Code 按文件类型给图标（并支持"在资源管理器中显示"等原生行为）
    item.resourceUri = vscode.Uri.file(node.view.absPath)
    item.tooltip = node.view.absPath
    return item
  }

  private changeItem(node: Extract<ChangeTreeNode, { kind: 'change' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(node.view.label, vscode.TreeItemCollapsibleState.None)
    item.id = `change:${node.sessionId}:${node.view.callId}`
    item.description = node.view.description
    item.contextValue = 'dsh.change'
    item.iconPath = this.changeIcon(node)
    const failure = this.failed.get(node.view.callId)
    if (failure !== undefined) item.description = `${node.view.description} · 未能丢弃：${failure}`
    item.tooltip = `${node.view.label} · ${node.view.description}${failure === undefined ? '' : `
未能丢弃：${failure}`}`
    // 点击 = 打开并定位（与 hover 的「丢弃/保留」互补：树负责"过一遍"，hover 负责"就地处置"）
    item.command = { command: 'dsh.change.open', title: '打开并定位', arguments: [node] }
    return item
  }

  /** 构建（带缓存）：先算 stale 所需哈希，再投影成模型 */
  private async loadTree(): Promise<SessionNodeView[]> {
    if (this.cached !== undefined) return this.cached
    const hashes = await this.currentHashes()
    this.cached = buildTree(this.deps.book, hashes)
    // 剪枝：记录已被保留/成功丢弃的失败留痕不再有意义（否则会长期占据红色标记）
    if (this.failed.size > 0) {
      const alive = new Set<string>()
      for (const session of this.cached) {
        for (const file of session.files) for (const c of file.changes) alive.add(c.callId)
      }
      for (const callId of [...this.failed.keys()]) {
        if (!alive.has(callId)) this.failed.delete(callId)
      }
    }
    return this.cached
  }

  /** 账本涉及的文件 → 当前内容哈希（读失败的文件不参与 stale 判定） */
  private async currentHashes(): Promise<Map<string, string>> {
    const paths = this.deps.book.allPaths().slice(0, MAX_HASH_FILES)
    const hashes = new Map<string, string>()
    for (const path of paths) {
      try {
        hashes.set(path, contentHash(await this.deps.readFileText(path)))
      } catch {
        // 文件已删除 / 无权限：不参与判定（宁可不标 stale，也不误标）
        this.deps.log?.(`tree: 读取失败，跳过 stale 判定 ${path}`)
      }
    }
    return hashes
  }
}
