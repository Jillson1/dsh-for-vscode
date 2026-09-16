// src/editorReveal.ts — 打开文件并定位到某一行的**单点实现**
//
// 为什么单独一个模块：这段逻辑原本在 `panel/provider.ts` 的桥接依赖里内联了一份，
// 现在 F2 导航（F8 游走）与 F3 树（点击变更节点）都要用同样的行为。
// 复制第二份的代价是"高亮范围 / 居中策略 / 选区"三处细节会在两个地方漂移，
// 而这两条路径都是用户每天用的——因此收敛成一份，任何调整只改这里。
//
// 行为（与 B 组实测通过的那份一致）：打开（preview:false，不占用预览位）→ 取整行范围 →
// 越界行由 validateRange 归一到最后一行 → 居中滚动 → 选中整行（用户可直接开始编辑）。
import * as vscode from 'vscode'

/**
 * 程序化选区静音窗（毫秒）。
 *
 * 问题（真机反馈）：跳行定位为了"让用户看清落在哪一行"会把整行设为选区，
 * 而选区监听（F10 的选区线程）无法区分"用户选的"与"我们选的"——于是每次点击
 * 工具卡片路径都会冒出一个评论线程、并把回复输入框弹出来。
 *
 * 做法：凡是我们自己设置的选区，都在这里开一个短静音窗；选区线程在窗口内
 * 既不新建线程、也不保留旧线程（跳走时应当消失）。
 * 窗口取 600ms：足够覆盖 selection 事件派发 + 防抖 250ms，又短到不会吞掉
 * 用户紧接着的真实选择（用户手动选区的动作通常在跳转之后才开始）。
 */
let suppressUntil = 0

/** 开一个静音窗（供 revealLineInEditor 内部调用，也可被其它程序化选区复用） */
export function muteSelectionThreads(ms = 600): void {
  suppressUntil = Date.now() + Math.max(0, ms)
}

/** 当前是否处于静音窗（选区线程据此抑制） */
export function selectionThreadsMuted(): boolean {
  return Date.now() < suppressUntil
}

/**
 * 打开文件并定位到 1-based 行。
 * @param path 文件绝对路径
 * @param line 1-based 行号（越界时归一到文档最后一行）
 * @returns 打开后的编辑器（调用方可继续操作）
 */
export async function revealLineInEditor(path: string, line: number): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false })
  const doc = editor.document
  const row = Math.min(Math.max(0, Math.floor(line) - 1), Math.max(0, doc.lineCount - 1))
  const start = new vscode.Position(row, 0)
  const end = doc.lineAt(row).range.end
  const range = doc.validateRange(new vscode.Range(start, end))
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  // 选中整行是为了让用户看清落在哪一行；但对选区线程来说这是"程序化选区"，
  // 必须静音，否则每次跳行都会弹出一个评论线程（真机反馈的缺陷）。
  muteSelectionThreads()
  editor.selection = new vscode.Selection(range.start, range.end)
  return editor
}
