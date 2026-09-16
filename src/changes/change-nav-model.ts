// src/changes/change-nav-model.ts — F2 变更导航的纯逻辑
//
// 为什么单独抽一层：导航的全部"正确性"都在这几个纯函数里——行号序列的升序归一、
// 游标推进（含环绕与边界）、计数文案。把它与 vscode API（revealRange / 状态栏）分开，
// 就能用 node:test 把边界情况钉死，而 vscode 层只剩"读文件定位 + 显示"。
//
// 行号约定：**1-based**（与 VS Code 编辑器显示、以及 diff-tracker 的 locateNewText 一致）。

/** 导航方向 */
export type NavDirection = 'next' | 'prev'

/**
 * 归一为可游走的行号序列：过滤非有限值/小于 1 的值 → 去重 → 升序。
 *
 * 去重的必要性：同一行可能有多条变更记录（例如两处相邻改动被投影到同一行），
 * 用户按 F8 时不该在同一行停两次。
 */
export function navSequence(lines: readonly number[]): number[] {
  const valid = lines.filter((l) => Number.isFinite(l) && l >= 1).map((l) => Math.floor(l))
  return [...new Set(valid)].sort((a, b) => a - b)
}

/**
 * 从当前行推进到下一个目标行。
 *
 * 语义（与 VS Code 的 F8 习惯一致）：
 * - `next`：第一个严格大于当前行的行；已到末尾则**环绕**到第一行；
 * - `prev`：最后一个严格小于当前行的行；已在开头则环绕到最后一行；
 * - 当前行缺失（尚未开始游走 / 是别的文件的行）：`next` → 第一行；`prev` → 最后一行；
 * - 序列为空 → `undefined`（调用方据此提示"该文件没有 DSH 变更"）。
 *
 * @param lines   已归一的升序行号（见 navSequence）
 * @param current 当前行（1-based；缺失表示未开始）
 * @param dir     方向
 * @param wrap    是否环绕（缺省 true）
 */
export function stepLine(
  lines: readonly number[],
  current: number | undefined,
  dir: NavDirection,
  wrap = true,
): number | undefined {
  const seq = navSequence(lines)
  if (seq.length === 0) return undefined
  if (current === undefined || !Number.isFinite(current)) {
    return dir === 'next' ? seq[0] : seq[seq.length - 1]
  }
  if (dir === 'next') {
    const found = seq.find((l) => l > current)
    if (found !== undefined) return found
    return wrap ? seq[0] : undefined
  }
  for (let i = seq.length - 1; i >= 0; i -= 1) {
    const l = seq[i] as number
    if (l < current) return l
  }
  return wrap ? seq[seq.length - 1] : undefined
}

/**
 * 行号在序列里的序号（1-based），用于"3/12"计数；不在序列中返回 undefined。
 * 按**精确行**匹配：当前行可能已因用户编辑而偏离某条记录，此时计数按 undefined 处理
 * （下一次推进才会落到真实行上，显示"0/12"比显示错误的序号更诚实）。
 */
export function indexOfLine(lines: readonly number[], line: number | undefined): number | undefined {
  if (line === undefined || !Number.isFinite(line)) return undefined
  const at = navSequence(lines).indexOf(Math.floor(line))
  return at === -1 ? undefined : at + 1
}

/**
 * 状态栏计数文案：`3/12`；当前行不在序列中（或尚未开始）时为 `0/12`。
 * 序列为空时返回 `0/0`（调用方通常直接清除状态栏而不显示它）。
 */
export function formatCounter(lines: readonly number[], line: number | undefined): string {
  const seq = navSequence(lines)
  const at = indexOfLine(seq, line)
  return `${at ?? 0}/${seq.length}`
}
