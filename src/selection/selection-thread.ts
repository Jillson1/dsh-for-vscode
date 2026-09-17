// src/selection/selection-thread.ts — F10 选区线程（Comments 内联线程，**按需创建**）
//
// 方案取舍（探索文档 §8.5 的实测结论）：VS Code **没有**"选区悬浮工具条" API，
// "ChatLocation / inline chat 不可接管"。能做到的最接近形态是 **Comments 内联线程**：
//   - 线程锚定在选区范围（`createCommentThread(uri, range)`）；
//   - 标题区挂我们的命令（`comments/commentThread/title`）；
//   - `canReply: true` 提供的输入框**就是编辑器内的 Quick Edit 输入框**。
//
// **2026-09-17 语义变更（真机反馈）**：原先"一划选就自动挂线程"，但 VS Code 会把该线程的
// 展开按钮固定渲染在**行号左侧**，用户明确要求去掉那个常驻按钮。
// 现在改为**按需创建**：平时选区变化只 `clear()` 不创建；只有用户点了 `✨ Quick Edit`
// （`openForCurrentSelection()`）才建线程并展开——于是"按钮只在你要用它的时候才出现"。
//
// **2026-09-17 再次变更（交互统一，真机反馈）**：Quick Edit 的编辑器内输入框**已下线**——
// 工具条按钮 / 右键菜单 / Alt+K 三条入口统一走**顶部 InputBox**（见 extension.ts 的
// `quickEditFromInput`）。原因：线程输入框位置固定在选区下方、宽度不可控，无法与 InputBox 对齐，
// 同一功能两种弹窗形态会被当成两个功能。
// 因此本模块现在**只剩一个职责**：给选区提供一个锚点线程，承载标题按钮（`Add to DSH`）与正文摘要。
// `openForCurrentSelection()` 目前无调用方（保留以备将来恢复编辑器内输入），`canReply` 留着但无入口。
//
// 打扰控制：
//   - 选区为空/零长度 → 不建（openForCurrentSelection 内部校验）；
//   - 同 range 同文本 → 复用不重建（避免闪烁与滚动跳动）；
//   - 选区变化、编辑器失焦、文档关闭 → 旧线程 dispose（只保留一个活动线程）；
//   - 设置 `dsh.selection.threads.enabled` 控制线程的创建（当前无 UI 入口会触发创建）。
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
   * 展开线程（生产 = `thread.collapsibleState = Expanded`）。
   * 按需创建时用它把回复输入框直接亮出来，省掉用户再点一次。
   */
  expandThread?(thread: unknown): void
  /**
   * 是否处于"程序化选区"静音窗（默认 false）。
   * 跳行定位等我们自己设置的选区必须静音，否则用户刚点完卡片就被问"要不要 Quick Edit"。
   */
  suppressed?(): boolean
  log?(message: string): void
}

/**
 * 选区线程控制器（**按需创建**，见文件头说明）。
 *
 * 线程本身只做两件事：显示"选了几行 / 引用是什么"，以及**充当输入框**。
 * 用户在线程回复框里输入的文本由扩展侧的 `onDidSubmitCommentReply` 接走（走 F11 的发送链路）；
 * 标题按钮则分别走 Add to DSH 与 Quick Edit 命令。
 */
export class SelectionThreadController {
  private thread: unknown
  private lastKey: string | undefined

  constructor(private readonly deps: SelectionThreadDeps) {}

  /**
   * 选区变化时调用：**只清不建**。
   *
   * 线程是按需创建的，选区一变它的锚点就失效了 → 立刻清掉，避免线程停留在错误的位置上。
   * （此处不再防抖：已经不创建东西了，dispose 很廉价，留着反而让旧线程多停 250ms。）
   */
  onSelectionChanged(): void {
    this.clear()
  }

  /**
   * 按需创建/复用当前选区的线程（供 `dsh.selection.quickEdit` 调用）。
   * @returns 线程对象；不满足条件（未开启 / 静音 / 无活动编辑器 / 零长度或纯空白选区）→ undefined
   */
  openForCurrentSelection(): unknown {
    if (this.deps.suppressed?.() === true) return undefined
    const editor = this.deps.activeEditor()
    if (editor === undefined) return undefined
    const info = this.infoOf(editor)
    // 显式判空：shouldOfferThread 是布尔断言，TS 不会据此收窄 info
    if (info === null || !shouldOfferThread(info, this.deps.enabled())) return undefined
    const key = `${info.path}|${info.startLine}|${info.endLine}|${info.text}`
    if (key === this.lastKey && this.thread !== undefined) {
      this.deps.expandThread?.(this.thread) // 同选区：复用并确保展开
      return this.thread
    }
    this.clear()
    const range = this.deps.range(info.startLine - 1, info.endLine - 1)
    const body = this.deps.markdown(threadBody(info))
    this.thread = this.deps.createThread(this.deps.uri(info.path), range, body)
    this.lastKey = key
    this.deps.expandThread?.(this.thread)
    this.deps.log?.(`selection-thread: 按需创建 ${threadBody(info)}`)
    return this.thread
  }

  /** 释放当前线程（选区变化 / 失焦 / 关闭文档 / 发送完成 / 扩展停用） */
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

  /** 当前线程（供 UI 动作取用；无则 undefined） */
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
    this.clear()
  }
}
