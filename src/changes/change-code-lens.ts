// src/changes/change-code-lens.ts — F5 变更行内 CodeLens
//
// 目标（方案 §7.5）：变更行的上方直接出现「保留 / 丢弃 / 对比」三个可点元素，不必 hover、不必开树。
//
// 与 hover 的分工（A/B 组已有 hover 操作按钮）：
//   hover  = 鼠标停在该行时的就地处置（零位移，但需要先知道"这里改过"）；
//   CodeLens = **常驻可见**的"这里改过"提示 + 一次性入口，适合逐处过审的扫读场景。
// 两者共用同一批命令（dsh.diff.keep / revert / show），不新增语义。
import * as vscode from 'vscode'
import { locateNewText } from '../bridge/diff-tracker'
import type { ChangeBook } from '../bridge/change-book'

/** CodeLens 依赖（生产接 vscode；测试可注入假实现） */
export interface ChangeCodeLensDeps {
  book: ChangeBook
  log?(message: string): void
}

/**
 * 单文件最多渲染的记录数。超出部分**截断**并给出一条"…另有 N 条"的提示：
 * 一个文件几百处改动时，CodeLens 会把编辑区顶部挤满——方案 §7.5 明确要求截断。
 */
export const MAX_LENS_RECORDS = 200

/** 一条 CodeLens 的目标（纯数据，便于断言顺序与去重） */
export interface LensSpec {
  /** 0-based 行 */
  readonly line: number
  readonly callId: string
  /** 该行上的记录数（同一行多处改动合并成一组按钮） */
  readonly count: number
}

/**
 * 从"记录 + 文档内容"算出 CodeLens 落点（纯函数）。
 *
 * 规则：
 * - 行号取 `newText` 在文档中的位置（改前片段落盘后已不在文件里，无法定位）；
 * - 定位不到的记录直接跳过（用户手改过 → 不再提示"这里改过"）；
 * - **同一行合并**（相邻改动投影到同一行时只出一组按钮，避免三倍噪音）；
 * - 按行号升序输出，超过 `limit` 截断。
 */
export function lensSpecs(
  records: readonly { callId: string; newText: string }[],
  content: string,
  limit: number = MAX_LENS_RECORDS,
): { specs: LensSpec[]; skipped: number; truncated: number } {
  const byLine = new Map<number, { callId: string; count: number }>()
  let skipped = 0
  for (const rec of records) {
    const loc = locateNewText(content, rec.newText)
    if (loc === null) {
      skipped += 1
      continue
    }
    const line = loc.line - 1 // 转 0-based（CodeLens 用 0-based）
    const prev = byLine.get(line)
    if (prev === undefined) byLine.set(line, { callId: rec.callId, count: 1 })
    else byLine.set(line, { callId: prev.callId, count: prev.count + 1 })
  }
  const all = [...byLine.entries()]
    .map(([line, v]) => ({ line, callId: v.callId, count: v.count }))
    .sort((a, b) => a.line - b.line)
  const specs = all.slice(0, limit)
  return { specs, skipped, truncated: all.length - specs.length }
}

/** CodeLens provider（数据源 = ChangeBook；账本变化时通过 onDidChangeCodeLenses 让 VS Code 重取） */
export class ChangeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>()
  /** 账本变化 → 重算（VS Code 会重新调用 provideCodeLenses） */
  readonly onDidChangeCodeLenses = this.emitter.event
  private readonly subscription: { dispose(): void }

  constructor(private readonly deps: ChangeCodeLensDeps) {
    this.subscription = deps.book.onChange(() => this.emitter.fire())
  }

  /** 账本被外部改动（保留/丢弃/新增）后手动触发重算 */
  refresh(): void {
    this.emitter.fire()
  }

  dispose(): void {
    this.subscription.dispose()
    this.emitter.dispose()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const path = document.uri.fsPath
    const records = this.deps.book.recordsForPath(path)
    if (records.length === 0) return []
    const content = document.getText()
    const { specs, truncated } = lensSpecs(records, content)
    const lenses: vscode.CodeLens[] = []
    for (const spec of specs) {
      const range = new vscode.Range(spec.line, 0, spec.line, 0)
      const suffix = spec.count > 1 ? `（${spec.count} 处）` : ''
      lenses.push(
        // 图标用 emoji 而非 $(codicon)：CodeLens 的文字颜色由主题决定（editorCodeLens.foreground），
        // 扩展无法设置；$(icon) codicon 也只能单色跟随文字色。emoji 自带颜色、与主题无关，
        // 是让这组按钮"看得见"的唯一手段（用户拍板 2026-09-17，方案 A）。
        // 曾试过行号旁彩色 gutter 图标（方案 B）：颜色确实可控，但用户实测觉得不美观，已撤。
        new vscode.CodeLens(range, {
          command: 'dsh.diff.keep',
          title: `✅ 保留${suffix}`,
          arguments: [spec.callId],
        }),
        new vscode.CodeLens(range, {
          command: 'dsh.diff.revert',
          title: `❌ 丢弃${suffix}`,
          arguments: [spec.callId],
        }),
        new vscode.CodeLens(range, {
          command: 'dsh.diff.show',
          title: '🔍 对比',
          arguments: [spec.callId],
        }),
      )
    }
    if (truncated > 0) {
      const last = specs[specs.length - 1]
      const line = last === undefined ? 0 : last.line
      this.deps.log?.(`code-lens: ${path} 超过 ${MAX_LENS_RECORDS} 处，截断 ${truncated} 条`)
      // 截断提示：不做成按钮（点了没有合理动作），只如实说明还剩多少
      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          command: 'dsh.changes.refresh',
          title: `…另有 ${truncated} 处未显示`,
          arguments: [],
        }),
      )
    }
    return lenses
  }
}
