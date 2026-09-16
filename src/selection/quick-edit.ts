// src/selection/quick-edit.ts — F11 的发送侧（含"首次确认"策略）
//
// 与 selection-model.ts 的分工：那边决定"文本长什么样"，这边决定"发不发、怎么报错"。
// 依赖全部注入（确认框 / 下行 / 提示），因此可以用假实现把三种结局都测到。
import type { PanelDownlink } from '../panel/html'
import { quickEditConfirmText, quickEditDownlink, type SelectionInfo } from './selection-model'

/** 发送结局 */
export type QuickEditSendResult = 'sent' | 'cancelled' | 'unreachable' | 'empty'

/** 发放依赖（生产接 vscode 模态框与面板下行） */
export interface QuickEditSenderDeps {
  /** 是否需要发送前确认（`dsh.quickEdit.confirmBeforeSend`） */
  confirmBeforeSend(): boolean
  /** 弹确认框（返回 true = 用户确认发送） */
  confirm(text: string): Promise<boolean>
  /** 下发给 iframe（生产 = provider.postToPage；false = 面板不可达） */
  send(message: PanelDownlink): boolean
  /** 用户可见提示 */
  notify(message: string): void
  log?(message: string): void
}

/**
 * 发送一条 Quick Edit 指令。
 *
 * 三条边界：
 *   1. **空指令不发送**（用户只是按了回车没写东西）——写进 composer 一个光秃秃的 `@path:12-14` 也算合作用意，
 *      但"自动发送一轮模型调用"必须有指令，否则是在替用户花额度；
 *   2. 确认策略由设置决定，默认开（方案 §7.11 的 `dsh.quickEdit.confirmBeforeSend` 默认 true）；
 *   3. 面板不可达时**不假装已发送**，如实告知（与 F6/F8 同一原则）。
 */
export async function sendQuickEdit(
  info: SelectionInfo,
  instruction: string,
  deps: QuickEditSenderDeps,
): Promise<QuickEditSendResult> {
  const trimmed = instruction.trim()
  if (trimmed === '') {
    deps.log?.('quickEdit: 指令为空，未发送')
    deps.notify('没有填写修改指令，已取消发送')
    return 'empty'
  }
  if (deps.confirmBeforeSend()) {
    const ok = await deps.confirm(quickEditConfirmText(info, trimmed))
    if (!ok) {
      deps.log?.('quickEdit: 用户在确认框中取消')
      return 'cancelled'
    }
  }
  const sent = deps.send(quickEditDownlink(info, trimmed))
  if (!sent) {
    deps.log?.('quickEdit: 下行不可达，指令未送达')
    deps.notify('DSH 面板当前不可见，指令未能发送；请先打开 DSH 面板')
    return 'unreachable'
  }
  deps.log?.(`quickEdit: 已发送 ${info.pathRef} → ${trimmed.slice(0, 40)}`)
  return 'sent'
}
