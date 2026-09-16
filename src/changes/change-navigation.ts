// src/changes/change-navigation.ts — F2 变更导航的 vscode 装配层（F8 / Shift+F8）
//
// 职责：把"当前文件里有哪些 DSH 变更行"算出来（读内存文档 + locateNewText），按方向推进游标，
// 定位编辑器并把 `3/12` 计数写进状态栏。全部决策逻辑在 change-nav-model.ts / diff-tracker 里
// （纯函数），本层只做 IO 与 vscode 交互——但依赖仍以**最小接口**注入，因此可用假实现单测。
import { locateNewText, pathsEqual } from '../bridge/diff-tracker'
import {
  formatCounter,
  navSequence,
  stepLine,
  type NavDirection,
} from './change-nav-model'
import type { ChangeBook } from '../bridge/change-book'

/** 当前活动编辑器的最小接口（生产 = vscode.TextEditor） */
export interface ActiveEditorLike {
  /** 文件系统路径（uri.fsPath） */
  readonly fsPath: string
  /** 内存文档全文（**必须是内存文本**：定位基准要与将施加操作的文档一致） */
  getText(): string
}

/** 导航依赖（生产接 vscode API，测试注入假实现） */
export interface ChangeNavigationDeps {
  /** 变更账本（行号来源：每条记录的 newText 在当前文件里的位置） */
  book: ChangeBook
  /** 当前活动编辑器；无 → 提示用户先打开文件 */
  activeEditor(): ActiveEditorLike | undefined
  /** 打开并定位到 1-based 行（生产 = showTextDocument + revealRange + selection） */
  reveal(path: string, line: number): Promise<void>
  /** 读文件文本（兜底：编辑器取不到内容时） */
  readFileText(path: string): Promise<string>
  /** 状态栏计数（undefined = 清除显示） */
  status(text: string | undefined): void
  /** 用户可见提示（无活动文件 / 该文件无变更 / 锚点失效） */
  notify(message: string): void
  log?(message: string): void
}

/**
 * 变更导航器（F2）。
 *
 * 游标语义：只在**同一文件内**游走；切换活动文件后游标自动作废（从新文件的第一处/最后一处开始）。
 * 行号来源：每条记录的 `newText` 在当前内存文档中的位置——改前片段（oldText）落盘后已不在文件里，
 * 不能用来定位（这是 A 组就踩过的坑）。
 */
export class ChangeNavigator {
  private cursor: { path: string; line: number } | undefined

  constructor(private readonly deps: ChangeNavigationDeps) {}

  /** 跳到下一处变更（F8） */
  async next(): Promise<void> {
    await this.step('next')
  }

  /** 跳到上一处变更（Shift+F8） */
  async prev(): Promise<void> {
    await this.step('prev')
  }

  /** 作废游标（文件关闭 / 用户手动跳转后调用） */
  clearCursor(): void {
    this.cursor = undefined
    this.deps.status(undefined)
  }

  /** 当前文件的可游走行号（供状态栏初始化与测试观察） */
  async linesForActiveFile(): Promise<{ path: string; lines: number[] } | undefined> {
    const editor = this.deps.activeEditor()
    if (editor === undefined) return undefined
    const content = await this.contentOf(editor)
    const records = this.deps.book.recordsForPath(editor.fsPath)
    const lines = navSequence(
      records
        .map((r) => locateNewText(content, r.newText)?.line)
        .filter((l): l is number => l !== undefined),
    )
    return { path: editor.fsPath, lines }
  }

  private async step(dir: NavDirection): Promise<void> {
    const editor = this.deps.activeEditor()
    if (editor === undefined) {
      this.deps.notify('请先打开一个文件，再按 F8 / Shift+F8 游走 DSH 变更')
      return
    }
    const path = editor.fsPath
    const records = this.deps.book.recordsForPath(path)
    if (records.length === 0) {
      this.deps.status(undefined)
      this.deps.notify(`当前文件没有 DSH 变更：${path}`)
      return
    }
    const content = await this.contentOf(editor)
    const raw = records
      .map((r) => locateNewText(content, r.newText)?.line)
      .filter((l): l is number => l !== undefined)
    // 游标只在同一文件内有效：换文件即视为"重新开始游走"
    const current =
      this.cursor !== undefined && pathsEqual(this.cursor.path, path) ? this.cursor.line : undefined
    const target = stepLine(raw, current, dir)
    if (target === undefined) {
      this.deps.status(undefined)
      this.deps.notify('该文件的 DSH 变更已不在当前内容里（可能已被手动改动）')
      return
    }
    await this.deps.reveal(path, target)
    this.cursor = { path, line: target }
    this.deps.status(formatCounter(raw, target))
    this.deps.log?.(`change-nav ${dir}: ${path}:${target} (${formatCounter(raw, target)})`)
  }

  /** 取内存文档内容；取不到时回退读磁盘（失败则由调用方 catch，此处抛出即告警） */
  private async contentOf(editor: ActiveEditorLike): Promise<string> {
    try {
      return editor.getText()
    } catch {
      return this.deps.readFileText(editor.fsPath)
    }
  }
}
