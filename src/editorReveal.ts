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
 * 判定一个"选区变更"是否应当被视为**用户发起**的。
 *
 * 真机缺陷（2026-09-18）：编辑区划选后，「添加到 DSH / Quick Edit」两个按钮**闪一下就消失**。
 * 根因是来源被记成"最后一次事件是什么"，而选区事件流里除了用户的鼠标/键盘事件，
 * 还夹杂大量**程序化事件**（kind = Command）：VS Code 在渲染 CodeLens、拖选收尾、
 * 视图变化时都会补发。任何一次这类事件都会把来源覆盖成"非用户"，
 * 于是 120ms 防抖后的那次重算直接把按钮收掉 —— 表现就是闪烁。
 *
 * 规则（与 `muteSelectionThreads` 同模块：这是"程序化 vs 用户"的唯一判定口，避免两处口径漂移）：
 *   - Mouse / Keyboard            → 用户发起（不在静音窗内时）→ `true`
 *   - Command **不在静音窗内**     → VS Code 的良性补发 → `null`（**不提供信息**，调用方保持原值）
 *   - Command **在静音窗内**       → 我们自己的跳行定位 → `false`（按钮不该冒出来）
 *   - Undefined / 其它            → 无法判定 → `null`（宁可保留按钮，也不要误收）
 *
 * `null` 是这套规则的关键：它表示"这次事件不提供新信息"，调用方**不得**据此覆盖已知来源。
 *
 * @param kind             VS Code 给出的选区变更来源（1=Keyboard、2=Mouse、3=Command）
 * @param inSuppressWindow 调用方提供的"是否处于程序化静音窗"判定
 * @returns true=用户发起；false=程序化；null=本次事件不提供信息（保持原值）
 */
export function classifySelectionOrigin(
  kind: number | undefined,
  inSuppressWindow: boolean,
): boolean | null {
  if (kind === 1 || kind === 2) return !inSuppressWindow;
  if (kind === 3) return inSuppressWindow ? false : null;
  return null;
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
