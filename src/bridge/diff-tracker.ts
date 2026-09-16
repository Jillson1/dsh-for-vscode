// src/bridge/diff-tracker.ts — A 组：修改跟踪与撤销的纯逻辑核心
// 职责：把 DSH 插件广播的 applied diff（{path, diffs, cwd, callId}）转成可定位、可撤销的
// 修改记录（ModificationRecord），并据此构造撤销编辑（WorkspaceEdit 的纯数据形状）。
// 本模块不 import vscode：记录管理 / 行号定位 / 撤销编辑构造都是纯数据操作，可 node:test 直测；
// decoration / hover / diff 视图等 vscode API 组装在 panel/provider.ts（薄封装）。
import { isAbsolute, resolve } from 'node:path';

/** 路径比较：Windows 大小写不敏感（插件路径与 VS Code fsPath 可能大小写不同）。 */
export function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 一条可定位、可撤销的修改记录。 */
export interface ModificationRecord {
  /** 稳定工具调用 id（去重 / 单处撤销的定位键）。 */
  callId: string;
  /** 目标文件绝对路径。 */
  path: string;
  /** 改前片段（撤销时 indexOf 定位 + 还原的锚点）。 */
  oldText: string;
  /** 改后片段（高亮区域与 diff 视图用）。 */
  newText: string;
  /** oldText 在文件中的 1-based 起始行（record 时定位；文件被改动后可能失效）。 */
  line: number;
  /** oldText 覆盖的行数（含跨行；>=1）。 */
  lineCount: number;
  /** 记录时间（Unix epoch ms）。 */
  ts: number;
}

/** 一条 applied diff 输入（来自桥接消息，路径可能是相对路径）。 */
export interface AppliedDiffInput {
  path: string;
  cwd?: string;
  diffs: { oldText: string; newText: string }[];
  callId: string;
}

/** 撤销编辑的纯数据形状：目标路径 + 一个文本替换（position 由定位阶段算出）。 */
export interface RevertEdit {
  /** 绝对目标路径。 */
  path: string;
  /** 0-based 字符偏移（oldText 起始处）。 */
  startOffset: number;
  /** 需要替换的原文（当前文件里 oldText 所在片段）。 */
  currentText: string;
  /** 替换为（即原 oldText）。 */
  replacement: string;
}

/** 解析输入路径为绝对路径（同 host.resolveBridgePath 的规则，供 tracker 独立使用）。 */
export function resolveInputPath(raw: string, cwd: string | undefined, workspaceRoot: string | undefined): string | null {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return null; // 协议串拒绝
  if (isAbsolute(raw)) return raw;
  const base = cwd ?? workspaceRoot;
  if (base === undefined) return null;
  return resolve(base, raw);
}

/**
 * 把 applied diff 输入窄化为修改记录（纯数据，不做文件 IO）。
 * - path 解析为绝对路径（解析失败 → 整条丢弃）；
 * - 每个 hunk 成为一条记录；hunk 的 oldText 为空（write 新建）→ 丢弃（无撤销锚点）。
 * @returns 修改记录列表（可能为空数组），并保留输入顺序。
 */
export function recordsFromDiffs(input: AppliedDiffInput, workspaceRoot: string | undefined): ModificationRecord[] {
  const absPath = resolveInputPath(input.path, input.cwd, workspaceRoot);
  if (absPath === null) return [];
  const ts = Date.now();
  const out: ModificationRecord[] = [];
  for (const d of input.diffs) {
    if (typeof d.oldText !== 'string' || d.oldText === '') continue;
    if (typeof d.newText !== 'string') continue;
    const lineCount = Math.max(1, d.oldText.split('\n').length);
    out.push({
      callId: input.callId,
      path: absPath,
      oldText: d.oldText,
      newText: d.newText,
      line: 1, // 占位：record 阶段读文件定位后回填
      lineCount,
      ts,
    });
  }
  return out;
}

/** 计算 oldText 在 content 中的 1-based 起始行与 0-based 字符偏移；找不到返回 null。 */
export function locateOldText(content: string, oldText: string): { line: number; startOffset: number } | null {
  if (typeof content !== 'string' || typeof oldText !== 'string' || oldText === '') return null;
  const idx = content.indexOf(oldText);
  if (idx === -1) return null;
  return { line: content.slice(0, idx).split('\n').length, startOffset: idx };
}

/** 计算 newText 在 content 中的 1-based 起始行与 0-based 字符偏移；找不到返回 null。 */
export function locateNewText(content: string, newText: string): { line: number; startOffset: number } | null {
  if (typeof content !== 'string' || typeof newText !== 'string' || newText === '') return null;
  const idx = content.indexOf(newText);
  if (idx === -1) return null;
  return { line: content.slice(0, idx).split('\n').length, startOffset: idx };
}

/**
 * 撤销前校验：newText 仍在文件中（edit 已落盘且未被后续改动覆盖）。
 * 返回 newText 的字符偏移；文件被用户改过（找不到）→ null。
 */
export function verifyRevert(content: string, record: ModificationRecord): { startOffset: number } | null {
  const loc = locateNewText(content, record.newText);
  if (loc === null) return null;
  return { startOffset: loc.startOffset };
}

/**
 * 构造撤销编辑（纯数据）：把当前文件里 newText 出现的片段替换回 oldText。
 * edit 落盘后文件内容 = 含 newText；撤销 = newText → oldText。
 */
export function buildRevertEdit(content: string, record: ModificationRecord): RevertEdit | null {
  const v = verifyRevert(content, record);
  if (v === null) return null;
  return {
    path: record.path,
    startOffset: v.startOffset,
    currentText: record.newText, // 当前文件里的片段
    replacement: record.oldText, // 还原为改前片段
  };
}

/**
 * 修改栈（内存）：按 callId 去重（同一次修改重复广播只记一条），支持按路径/全部撤销。
 * 纯数据容器，thread-safe 由调用方保证（扩展主线程单线程）。
 */
export class DiffStack {
  private byCallId = new Map<string, ModificationRecord>();

  /** 插入记录（同 callId 幂等：已存在则忽略）。 */
  push(record: ModificationRecord): boolean {
    if (this.byCallId.has(record.callId)) return false;
    this.byCallId.set(record.callId, record);
    return true;
  }

  /** 按 callId 取记录。 */
  get(callId: string): ModificationRecord | undefined {
    return this.byCallId.get(callId);
  }

  /** 按 callId 删除并返回；不存在返回 undefined。 */
  remove(callId: string): ModificationRecord | undefined {
    const r = this.byCallId.get(callId);
    if (r !== undefined) this.byCallId.delete(callId);
    return r;
  }

  /** 某文件的所有记录（保持插入序）。Windows 路径大小写不敏感。 */
  forPath(path: string): ModificationRecord[] {
    return [...this.byCallId.values()].filter((r) => pathsEqual(r.path, path));
  }

  /** 所有记录（保持插入序）。 */
  all(): ModificationRecord[] {
    return [...this.byCallId.values()];
  }

  /** 清空。 */
  clear(): void {
    this.byCallId.clear();
  }

  get size(): number {
    return this.byCallId.size;
  }
}
