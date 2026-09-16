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
  editor.selection = new vscode.Selection(range.start, range.end)
  return editor
}
