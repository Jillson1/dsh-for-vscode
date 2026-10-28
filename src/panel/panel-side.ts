// src/panel/panel-side.ts — 面板未打开时"自动打开哪一侧"的纯决策
//
// 背景（真机反馈）：面板没开时执行 Add to DSH 只会弹错误提示（"请先打开面板"），
// 对比 Claude Code 的 Add File to Chat——它会先把 chat 面板打开再注入。
// 自动打开需要决定开哪一侧，规则写死为一处纯函数，避免散落在扩展入口里无法单测：
//
//   1. 用户本次会话打开过**右侧**（`dsh.panel.secondary`）→ 沿用右侧；
//   2. 只打开过左侧（`dsh.panel`）→ 沿用左侧；
//   3. 两侧都没打开过 → **默认右侧**（辅助侧边栏；与 Claude Code 的 chat 面板位置一致，
//      也不遮挡左侧文件树）。旧版 VS Code 没有辅助侧边栏时由调用方退化到左侧。

/** 面板所在侧：左侧活动栏（primary） / 右侧辅助侧边栏（secondary） */
export type PanelSide = 'primary' | 'secondary'

/** 两侧面板是否已创建（曾打开过） */
export interface ResolvedPanels {
  /** `dsh.panel`（左侧活动栏）是否已创建 */
  readonly primary: boolean
  /** `dsh.panel.secondary`（右侧辅助侧边栏）是否已创建 */
  readonly secondary: boolean
}

/**
 * 选一侧去打开。优先级：用过右侧 → 用过左侧 → 默认右侧。
 * 只看"是否创建过"而不看"当前是否可见"：可见的那一侧本就不需要打开。
 */
export function pickPanelSide(resolved: ResolvedPanels): PanelSide {
  if (resolved.secondary) return 'secondary'
  if (resolved.primary) return 'primary'
  return 'secondary'
}
