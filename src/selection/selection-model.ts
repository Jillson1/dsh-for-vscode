// src/selection/selection-model.ts — F10/F11 的纯模型
//
// 选区的"该不该出现工具条 / 引用文本长什么样 / 输入框提示什么"全部在这里定，
// vscode 层只负责把 Comments 线程挂上去与把指令发出去。
//
// 打扰控制（方案 §8.5 的明确要求）：
//   - 空选区、单点光标（start == end 且无文本）不触发；
//   - 可在设置里整体关闭（`dsh.selection.threads.enabled`）；
//   - **绝不移动光标、绝不抢焦点**——线程只是"挂"在选区下方。
import type { PanelDownlink } from '../panel/html'

/** 一处选区（1-based 行号，便于直接拼 `@path:start-end`） */
export interface SelectionInfo {
  /** 文件绝对路径 */
  readonly path: string
  /** 起始行（1-based） */
  readonly startLine: number
  /** 结束行（1-based，含） */
  readonly endLine: number
  /** 选中行数 */
  readonly lineCount: number
  /** 选中文本（用于"是否为空"判定；不直接塞进 composer——行号引用已足够，agent 自己会读文件） */
  readonly text: string
  /** `@path:start-end`（单行时为 `@path:line`） */
  readonly pathRef: string
}

/**
 * 构造选区信息。
 *
 * 行号约定：VS Code 的 `Range` 是 0-based 且 end 是排他的；这里统一转成 **1-based 闭区间**
 * （用户看到的是"第 12-14 行"，而 `@path:12-14` 也是这个语义）。
 * 结束行按"选区末行"处理：当 end 落在某行第 0 列时（整行选中的常见形态），末行取 end-1。
 *
 * @returns 无有效选区（空文本且零长度、或行号非法）时返回 null
 */
export function selectionInfo(
  path: string,
  startLine0: number,
  startChar0: number,
  endLine0: number,
  endChar0: number,
  text: string,
): SelectionInfo | null {
  if (path === '') return null
  if (!Number.isFinite(startLine0) || !Number.isFinite(endLine0)) return null
  if (startLine0 < 0 || endLine0 < startLine0) return null
  // 零长度选区（只是光标、或点了一下）：不打扰
  if (startLine0 === endLine0 && startChar0 === endChar0) return null
  const startLine = Math.floor(startLine0) + 1
  const lastLine0 = endChar0 === 0 && endLine0 > startLine0 ? endLine0 - 1 : endLine0
  const endLine = Math.floor(lastLine0) + 1
  const lineCount = endLine - startLine + 1
  return {
    path,
    startLine,
    endLine,
    lineCount,
    text,
    pathRef: pathRefFor(path, startLine, endLine),
  }
}

/** `@path:line` / `@path:start-end`（单行不写区间，与 Add to DSH 的既有写法一致） */
export function pathRefFor(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `@${path}:${startLine}` : `@${path}:${startLine}-${endLine}`
}

/** 线程正文（一行摘要，含行数与引用） */
export function threadBody(info: SelectionInfo): string {
  return `选中 ${info.lineCount} 行 · ${info.pathRef}`
}

/** 线程正文的折叠预览（Comments 的 preview 模式只显示一行） */
export function threadPreview(info: SelectionInfo): string {
  const first = info.text.split('\n', 1)[0] ?? ''
  const clipped = first.length > 60 ? `${first.slice(0, 60)}…` : first
  return clipped === '' ? threadBody(info) : `${threadBody(info)} · ${clipped}`
}

/** Quick Edit 输入框的提示文案 */
export function quickEditPlaceholder(info: SelectionInfo): string {
  return `对 ${info.lineCount} 行执行什么修改？（回车发送）· ${info.pathRef}`
}

/** Quick Edit 的确认框正文（仅在 `dsh.quickEdit.confirmBeforeSend` 打开时使用） */
export function quickEditConfirmText(info: SelectionInfo, instruction: string): string {
  const body = instruction.trim() === '' ? info.pathRef : `${info.pathRef} ${instruction.trim()}`
  return `将发送到 DSH 当前会话：\n\n${body}\n\n这会真实触发一轮模型调用。`
}

/**
 * 是否应该为这次选区变化挂线程。
 * @param info 选区信息（null = 无有效选区）
 * @param enabled 设置开关
 */
export function shouldOfferThread(info: SelectionInfo | null, enabled: boolean): boolean {
  return enabled && info !== null && info.lineCount >= 1 && info.text.trim() !== ''
}

/** F11 的下行消息（Quick Edit 指令） */
export function quickEditDownlink(info: SelectionInfo, instruction: string): PanelDownlink {
  return {
    type: 'bridgeQuickEditSubmit',
    path: info.path,
    startLine: info.startLine,
    endLine: info.endLine,
    instruction,
  }
}
