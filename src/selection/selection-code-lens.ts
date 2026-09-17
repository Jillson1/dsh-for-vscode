// src/selection/selection-code-lens.ts — F10 选区工具条（CodeLens 版）
//
// 背景（真机反馈 2026-09-17）：划选后原先只有一个 comment thread 的展开按钮，而它由 VS Code
// 固定渲染在**编辑区左侧留白**，位置不可控；线程标题栏虽然挂了两个动作，实际观感上"只有一个
// 按钮"且要悬停才发现。用户拍板改成 CodeLens 版：
// **在选区首行上方常驻两个并排可点按钮** —— 选中即出现、不用悬停、位置与数量都可控。
//
// comment thread 仍然保留：它提供的 `canReply` 回复框是"编辑器内输入框"的实际载体，
// CodeLens 只负责把入口摆到看得见的地方（Quick Edit 按钮 = 展开该线程并聚焦输入框）。
//
// 纯逻辑（selectionLensSpecs）与 vscode 装配分离，前者可 node:test 直测。
import * as vscode from 'vscode'

/** 两个按钮的命令 id（复用既有命令，均不需要参数） */
export const ADD_COMMAND = 'dsh.selection.addToDsh'
export const QUICK_EDIT_COMMAND = 'dsh.selection.quickEdit'

/**
 * 按钮文案用 emoji 而非 `$(codicon)`：CodeLens 的文字颜色由主题决定
 * （`editorCodeLens.foreground`），扩展改不了；emoji 自带颜色、与主题无关，才看得见。
 * （与 F5 变更行 CodeLens 的取舍一致。）
 */
export const ADD_TITLE = '➕ 添加到 DSH'
export const QUICK_EDIT_TITLE = '✨ Quick Edit'

/** 当前选区（纯数据，0-based 行号） */
export interface ActiveSelection {
  /** 选区所在文档的绝对路径 */
  readonly fsPath: string
  /** 选区起始行（0-based）——工具条就挂在这一行上方 */
  readonly startLine: number
  /** 零长度选区（只是光标）→ 不出工具条 */
  readonly isEmpty: boolean
}

/** 一条工具条按钮的落点与内容 */
export interface SelectionLensSpec {
  readonly line: number
  readonly command: string
  readonly title: string
}

export interface SelectionCodeLensDeps {
  /** 读当前选区（无活动编辑器 / 无选区 → undefined） */
  activeSelection(): ActiveSelection | undefined
  /** 总开关（dsh.selection.lens.enabled） */
  enabled(): boolean
  /** 调试日志（去重后输出，避免 VS Code 频繁重取时刷屏） */
  log?(msg: string): void
}

/**
 * 纯函数：给定"当前请求的文档路径 + 活动选区 + 开关"，算出该出哪些按钮。
 *
 * 不出工具条的情形（全部返回空数组）：
 * - 开关关闭；
 * - 没有活动编辑器/选区；
 * - **零长度选区**（只点了一下光标）——否则每次点光标都冒工具条；
 * - 选区不在**当前请求的这个文档**里（VS Code 会对每个可见文档各问一次）。
 */
export function selectionLensSpecs(
  documentPath: string,
  selection: ActiveSelection | undefined,
  enabled: boolean,
): SelectionLensSpec[] {
  if (!enabled) return []
  if (selection === undefined) return []
  if (selection.isEmpty) return []
  if (selection.fsPath !== documentPath) return []
  const line = Math.max(0, selection.startLine)
  return [
    { line, command: ADD_COMMAND, title: ADD_TITLE },
    { line, command: QUICK_EDIT_COMMAND, title: QUICK_EDIT_TITLE },
  ]
}

/** CodeLens provider：选区/活动编辑器变化时由调用方触发 onDidChangeCodeLenses 让 VS Code 重取 */
export class SelectionCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event
  /** 上次已记录的落点（同样的落点不重复写日志） */
  private lastLogged = ''

  constructor(private readonly deps: SelectionCodeLensDeps) {}

  /** 选区或活动编辑器变化后调用（VS Code 会重新调用 provideCodeLenses） */
  refresh(): void {
    this.emitter.fire()
  }

  dispose(): void {
    this.emitter.dispose()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const specs = selectionLensSpecs(
      document.uri.fsPath,
      this.deps.activeSelection(),
      this.deps.enabled(),
    )
    if (specs.length === 0) {
      this.lastLogged = ''
      return []
    }
    const key = `${document.uri.fsPath}:${specs[0]!.line + 1}`
    if (key !== this.lastLogged) {
      this.lastLogged = key
      this.deps.log?.(`selection-lens: 选区首行 ${specs[0]!.line + 1} 出 ${specs.length} 个按钮（${document.uri.fsPath}）`)
    }
    return specs.map(
      (s) =>
        new vscode.CodeLens(new vscode.Range(s.line, 0, s.line, 0), {
          command: s.command,
          title: s.title,
        }),
    )
  }
}
