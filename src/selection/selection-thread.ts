// src/selection/selection-thread.ts — F10 选区悬浮工具条（Comments 内联线程）
//
// 方案取舍（探索文档 §8.5 的实测结论）：VS Code **没有**"选区悬浮工具条" API，
// "ChatLocation / inline chat 不可接管"。能做到的最接近形态是 **Comments 内联线程**：
//   - 线程锚定在选区范围（`createCommentThread(uri, range)`）；
//   - 标题区挂我们的命令（`comments/commentThread/title`）；
//   - `canReply: true` 提供的输入框**就是编辑器内的 Quick Edit 输入框**；
//   - `collapsibleState: Expanded` 让它一出现就是展开的。
//
// 打扰控制（缺一不可，否则线程会堆得到处都是）：
//   - 防抖 250ms（鼠标拖选过程中不反复建线程）；
//   - 选区为空/零长度 → dispose；
//   - 同 range 同文本 → 复用不重建（避免闪烁与滚动跳动）；
//   - 选区变化、编辑器失焦、文档关闭 → 旧线程 dispose（只保留一个活动线程）；
//   - 设置 `dsh.selection.threads.enabled` 可整体关闭。
import * as vscode from 'vscode'
import {
  shouldOfferThread,
  selectionInfo,
  threadBody,
  type SelectionInfo,
} from './selection-model'

/** 我们的评论控制器 id（一个控制器 + 单线程复用，避免线程堆积） */
export const SELECTION_CONTROLLER_ID = 'dsh.selection'
/** 线程的 contextValue（供 `comments/commentThread/title` 的 when 子句匹配） */
export const SELECTION_THREAD_CONTEXT = 'dsh.selection'

/** 依赖（可控时钟与工厂，便于单测） */
export interface SelectionThreadDeps {
  /** 当前活动编辑器 */
  activeEditor(): vscode.TextEditor | undefined
  /** 路径 → Uri（注入而不是直接 new：单测无需 vscode 运行时，与 DiffService 的约定一致） */
  uri(path: string): vscode.Uri
  /** 0-based 行范围 → Range */
  range(startLine0: number, endLine0: number): vscode.Range
  /** 文本 → MarkdownString（Comments 的正文类型） */
  markdown(text: string): vscode.MarkdownString
  /** 新建线程（生产 = controller.createCommentThread） */
  createThread(uri: vscode.Uri, range: vscode.Range, body: vscode.MarkdownString): unknown
  /** 释放线程（生产 = thread.dispose） */
  disposeThread(thread: unknown): void
  /** 设置开关 */
  enabled(): boolean
  /**
   * 是否处于"程序化选区"静音窗（默认 false）。
   * 跳行定位等我们自己设置的选区必须静音，否则会凭空弹出评论线程。
   */
  suppressed?(): boolean
  /** 防抖毫秒（默认 250） */
  debounceMs?: number
  log?(message: string): void
}

/**
 * 选区线程控制器。
 *
 * 线程本身只做两件事：显示"选了几行 / 引用是什么"，以及**充当输入框**。
 * 用户在线程回复框里输入的文本由扩展侧的 `onDidSubmitCommentReply` 接走（走 F11 的发送链路）；
 * 标题按钮则分别走 Add to DSH 与 Quick Edit 命令。
 */
export class SelectionThreadController {
  private thread: unknown
  private lastKey: string | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly deps: SelectionThreadDeps) {}

  /** 选区变化时调用（内部防抖） */
  onSelectionChanged(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    const delay = this.deps.debounceMs ?? 250
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.apply()
    }, delay)
  }

  /** 立即应用一次（测试与"设置变更后刷新"用） */
  apply(): void {
    // 程序化选区（跳行定位）：既不新建线程，也要把旧线程清掉——光标已经跳走了，线程留着就是错位
    if (this.deps.suppressed?.() === true) {
      this.clear()
      return
    }
    const editor = this.deps.activeEditor()
    if (editor === undefined) {
      this.clear()
      return
    }
    const info = this.infoOf(editor)
    // 显式判空：shouldOfferThread 是布尔断言，TS 不会据此收窄 info
    if (info === null || !shouldOfferThread(info, this.deps.enabled())) {
      this.clear()
      return
    }
    const key = `${info.path}|${info.startLine}|${info.endLine}|${info.text}`
    if (key === this.lastKey && this.thread !== undefined) return // 同选区同文本：不重建（避免闪烁）
    this.clear()
    const range = this.deps.range(info.startLine - 1, info.endLine - 1)
    const body = this.deps.markdown(threadBody(info))
    this.thread = this.deps.createThread(this.deps.uri(info.path), range, body)
    this.lastKey = key
    this.deps.log?.(`selection-thread: ${threadBody(info)}`)
  }

  /** 释放当前线程（选区取消 / 失焦 / 关闭文档 / 扩展停用） */
  clear(): void {
    if (this.thread !== undefined) {
      this.deps.disposeThread(this.thread)
      this.thread = undefined
    }
    this.lastKey = undefined
  }

  /** 当前是否挂着线程（诊断/测试） */
  hasThread(): boolean {
    return this.thread !== undefined
  }

  /** 当前线程（供"Quick Edit 按钮展开它"这类 UI 动作用；无则 undefined） */
  currentThread(): unknown {
    return this.thread
  }

  /** 由编辑器状态算出选区信息 */
  infoOf(editor: vscode.TextEditor): SelectionInfo | null {
    const sel = editor.selection
    const path = editor.document.uri.fsPath
    const text = editor.document.getText(sel)
    return selectionInfo(path, sel.start.line, sel.start.character, sel.end.line, sel.end.character, text)
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.clear()
  }
}
