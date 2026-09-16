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
  /** 来源工具（'edit' | 'write'；缺省未知）——决定"丢弃"的语义。 */
  tool?: string;
}

/** 一条 applied diff 输入（来自桥接消息，路径可能是相对路径）。 */
export interface AppliedDiffInput {
  path: string;
  cwd?: string;
  diffs: { oldText: string; newText: string }[];
  callId: string;
  /** 来源工具名（DSH 插件广播；决定丢弃语义）。 */
  tool?: string;
}

/** "丢弃一处修改"的执行方式。 */
export type DiscardPlan =
  /** write 新建整文件：丢弃 = 删除该文件（回收站）。 */
  | { kind: 'delete-file' }
  /** 其余（edit 替换 / edit 纯插入 / write 覆盖）：丢弃 = 文本替换回改前内容。 */
  | { kind: 'revert-text' }
  /**
   * 拒绝执行：旧内容为空（整文件新建）但来源工具未知——无法区分"新建文件"与"纯插入"，
   * 此时文本还原会把**整个文件内容替换成空串**（实测事故：0 字节文件）。
   * 宁可拒绝也不做破坏性操作（旧版桥接未转发 tool 时会走到这里）。
   */
  | { kind: 'refuse' };

/**
 * 决定一处记录的"丢弃"方式：
 * - write 且改前内容为空 → 删除文件；
 * - edit 纯插入（改前内容为空）→ 文本还原（replacement 为空串 = 移除插入内容）；
 * - 旧内容为空但工具未知 → **拒绝**（防清空文件）；
 * - 其余 → 文本还原。
 */
export function planDiscard(record: ModificationRecord): DiscardPlan {
  if (record.oldText !== '') return { kind: 'revert-text' };
  if (record.tool === 'write') return { kind: 'delete-file' };
  if (record.tool === 'edit') return { kind: 'revert-text' };
  return { kind: 'refuse' };
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
 * - 每个 hunk 成为一条记录；hunk 的 oldText 为空（write 新建 / edit 纯插入）也保留——
 *   此时红绿高亮为"全新增行"，撤销语义 = 把 newText 替换回空串（丢弃写入内容）。
 * @returns 修改记录列表（可能为空数组），并保留输入顺序。
 */
export function recordsFromDiffs(input: AppliedDiffInput, workspaceRoot: string | undefined): ModificationRecord[] {
  const absPath = resolveInputPath(input.path, input.cwd, workspaceRoot);
  if (absPath === null) return [];
  const ts = Date.now();
  const out: ModificationRecord[] = [];
  for (const d of input.diffs) {
    if (typeof d.oldText !== 'string') continue;
    if (typeof d.newText !== 'string') continue;
    // 高亮区域行数：oldText 空（新建）时按 newText 行数；否则按 oldText（替换块高度）
    const lineCount = d.oldText === '' ? Math.max(1, d.newText.split('\n').length) : Math.max(1, d.oldText.split('\n').length);
    out.push({
      callId: input.callId,
      path: absPath,
      oldText: d.oldText,
      newText: d.newText,
      line: 1, // 占位：record 阶段读文件定位后回填
      lineCount,
      ts,
      tool: input.tool,
    });
  }
  return out;
}

/**
 * 容错定位：在 content 中找 text 的 1-based 起始行与 0-based 字符偏移；找不到返回 null。
 * 兼容 CRLF/LF 换行差异：DSH 侧片段（LF）与磁盘文件（CRLF）换行风格可能不同，
 * 直接 indexOf 会失败——先原样找，失败则把 text 换行归一为 content 风格再找。
 */
function locateFlexible(content: string, text: string): LocatedText | null {
  if (typeof content !== 'string' || typeof text !== 'string' || text === '') return null;
  let idx = content.indexOf(text);
  let matched = text;
  if (idx === -1 && text.includes('\n')) {
    const normalized = text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n');
    idx = content.indexOf(normalized);
    matched = normalized;
  }
  if (idx === -1) return null;
  return { line: content.slice(0, idx).split('\n').length, startOffset: idx, matched };
}

/** 定位结果：1-based 行号 + 0-based 偏移 + **文件中的实际片段**（换行风格可能与入参不同）。 */
export interface LocatedText {
  line: number;
  startOffset: number;
  /** content 中真实命中的子串（CRLF 文件里含 \r，长度与入参可能不同）。 */
  matched: string;
}

/** 计算 oldText 在 content 中的 1-based 起始行与 0-based 字符偏移；找不到返回 null。 */
export function locateOldText(content: string, oldText: string): LocatedText | null {
  return locateFlexible(content, oldText);
}

/** 计算 newText 在 content 中的 1-based 起始行与 0-based 字符偏移；找不到返回 null。 */
export function locateNewText(content: string, newText: string): LocatedText | null {
  return locateFlexible(content, newText);
}

/** 把 text 的换行统一为 eol（'\r\n' 或 '\n'），避免写回时混入异种换行。 */
function normalizeToStyle(text: string, eol: '\r\n' | '\n'): string {
  if (eol === '\r\n') return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return text.replace(/\r\n/g, '\n');
}

/** 探测文件换行风格：含 CRLF 即视为 CRLF（Windows 常见），否则 LF。 */
function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 撤销前校验：newText 仍在文件中（edit 已落盘且未被后续改动覆盖）。
 * 返回 newText 在文件中的真实偏移与实际片段；文件被用户改过（找不到）→ null。
 */
export function verifyRevert(content: string, record: ModificationRecord): { startOffset: number; matched: string } | null {
  const loc = locateNewText(content, record.newText);
  if (loc === null) return null;
  return { startOffset: loc.startOffset, matched: loc.matched };
}

/**
 * 构造撤销编辑（纯数据）：把当前文件里 newText 出现的片段替换回 oldText。
 * edit 落盘后文件内容 = 含 newText；撤销 = newText → oldText。
 * - `currentText` 取**文件中的实际片段**（CRLF 对齐）：替换区间长度必须按它算，
 *   用 LF 片段长度会短出"每行一个 \r"，还原后残留尾部字符（实测 bug：文件多出「）」）；
 * - `replacement` 按文件换行风格写回，避免 CRLF 文件里混入裸 LF 行；
 * - oldText 为空串（edit 纯插入）时 replacement 为空 = 移除插入内容（语义正确）。
 * write 新建（整文件写入）不走这里——由 planDiscard 判为 delete-file。
 */
export function buildRevertEdit(content: string, record: ModificationRecord): RevertEdit | null {
  const v = verifyRevert(content, record);
  if (v === null) return null;
  return {
    path: record.path,
    startOffset: v.startOffset,
    currentText: v.matched, // 当前文件里的实际片段（长度含 \r）
    replacement: normalizeToStyle(record.oldText, detectEol(content)), // 还原为改前片段（空串 = 删除该片段）
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B 组增强：行级红绿 diff（Cursor 风格）
// 把 oldText/newText 做行级 LCS 比较，输出每条变更的行号与类型：
// - 新增行（add）→ 绿色高亮（文件中的实体行，可精确定位）
// - 删除行（del）→ 红色高亮（文件中无实体，投影到替换锚点行，hover 显示被删内容）
// 纯逻辑，node:test 直测。
// ─────────────────────────────────────────────────────────────────────────────

/** 行级 diff 的一个操作：新增 / 删除 / 未变（附各自 1-based 行号）。 */
export interface LineChange {
  type: 'add' | 'del' | 'ctx';
  /** 1-based 行号：del/ctx 在 oldText 中的行号。 */
  oldLine?: number;
  /** 1-based 行号：add/ctx 在 newText 中的行号。 */
  newLine?: number;
}

/** 一条高亮标记：文件 1-based 行号 + 类型（add 纯新增 / del 纯删除 / modify 替换）。 */
export interface HighlightLine {
  line: number;
  kind: 'add' | 'del' | 'modify';
}

/**
 * 合并同一行上的 add + del 为单条 `modify` 标记。
 *
 * 必要性：单行替换时 del 与 add 都落在同一行，若分别渲染两组背景装饰，
 * 后 set 的红色会盖掉绿色（实测：修改行"只剩红色"）。合并为 modify 后
 * 由装配层用**单一"修改色"**渲染，语义也更准确。
 */
export function mergeLineMarks(marks: HighlightLine[]): HighlightLine[] {
  const byLine = new Map<number, Set<HighlightLine['kind']>>();
  for (const m of marks) {
    const set = byLine.get(m.line) ?? new Set<HighlightLine['kind']>();
    set.add(m.kind);
    byLine.set(m.line, set);
  }
  const out: HighlightLine[] = [];
  for (const [line, kinds] of byLine) {
    if (kinds.has('add') && kinds.has('del')) out.push({ line, kind: 'modify' });
    else if (kinds.has('del')) out.push({ line, kind: 'del' });
    else out.push({ line, kind: 'add' });
  }
  return out.sort((x, y) => x.line - y.line);
}

/** 行级 LCS diff：逐行比较 oldText/newText，输出操作序列（保持相对顺序）。 */
export function diffLines(oldText: string, newText: string): LineChange[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // 大输入保护：LCS O(n*m) 会卡死；超过阈值直接全删全增（write 全文件覆盖场景）
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((_, i) => ({ type: 'del' as const, oldLine: i + 1 })),
      ...b.map((_, j) => ({ type: 'add' as const, newLine: j + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', oldLine: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', oldLine: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', newLine: j + 1 });
    j++;
  }
  return out;
}

/**
 * 把行级 diff 投影到文件行号（Cursor 风格红绿）：
 * - add 行 → 文件中的精确行（newStartLine 是 newText 在文件中的 1-based 起始行）→ 绿
 * - del 行 → 文件中无实体，投影到替换锚点（该 del 块之后第一个 new 行的位置；
 *   纯删除/删到末尾 → 投影到 hunk 区域末尾行）→ 红（hover 展示被删内容）
 * 输出按行号升序、同点去重。
 */
export function redGreenLines(oldText: string, newText: string, newStartLine: number): HighlightLine[] {
  const changes = diffLines(oldText, newText);
  const newCount = newText === '' ? 0 : newText.split('\n').length;
  const out: HighlightLine[] = [];
  for (let k = 0; k < changes.length; k++) {
    const c = changes[k];
    if (c.type === 'add' && c.newLine !== undefined) {
      out.push({ line: newStartLine + c.newLine - 1, kind: 'add' });
    } else if (c.type === 'del') {
      let anchor: number | undefined;
      for (let kk = k + 1; kk < changes.length; kk++) {
        if (changes[kk].type === 'add' || changes[kk].type === 'ctx') {
          anchor = changes[kk].newLine;
          break;
        }
      }
      const line = anchor !== undefined
        ? newStartLine + anchor - 1
        : Math.max(1, newStartLine + newCount - 1);
      out.push({ line, kind: 'del' });
    }
  }
  const seen = new Set<string>();
  return out
    .filter((h) => {
      const key = `${h.kind}:${h.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => x.line - y.line);
}

/** 一处修改的整体性质：纯新增 / 纯删除 / 替换（有增有删）。 */
export type DiffNature = 'add' | 'del' | 'modify';

/**
 * 判断一处修改的性质（hover 文案分型用）：
 * - 只有新增行 → 'add'（DSH 新增）
 * - 只有删除行 → 'del'（DSH 删除）
 * - 有增有删 → 'modify'（DSH 修改）
 */
export function diffNature(oldText: string, newText: string): DiffNature {
  let hasAdd = false;
  let hasDel = false;
  for (const c of diffLines(oldText, newText)) {
    if (c.type === 'add') hasAdd = true;
    else if (c.type === 'del') hasDel = true;
  }
  if (hasAdd && hasDel) return 'modify';
  if (hasDel) return 'del';
  return 'add'; // 纯新增 / 空 hunk（理论不出现）
}

/** 统计一处修改的新增行数与删除行数（hover 摘要用）。 */
export function summarizeDiff(oldText: string, newText: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const c of diffLines(oldText, newText)) {
    if (c.type === 'add') added += 1;
    else if (c.type === 'del') deleted += 1;
  }
  return { added, deleted };
}

/** 取被删除的行文本（hover 展示"删了什么"）。 */
export function deletedLines(oldText: string, newText: string): string[] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const out: string[] = [];
  for (const c of diffLines(oldText, newText)) {
    if (c.type === 'del' && c.oldLine !== undefined) {
      const text = oldLines[c.oldLine - 1];
      if (text !== undefined) out.push(text);
    }
  }
  return out;
}

/** 取新增的行文本（hover 展示"加了什么"）。 */
export function addedLines(oldText: string, newText: string): string[] {
  const newLines = newText === '' ? [] : newText.split('\n');
  const out: string[] = [];
  for (const c of diffLines(oldText, newText)) {
    if (c.type === 'add' && c.newLine !== undefined) {
      const text = newLines[c.newLine - 1];
      if (text !== undefined) out.push(text);
    }
  }
  return out;
}

/**
 * 归一化：仅统一换行风格（CRLF → LF），**不**剥除尾部空白。
 * 末尾多敲一个回车也算用户编辑过 —— 必须触发删除确认，而不是被静默忽略。
 */
function canonical(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * 文件当前内容是否**仍等同于 DSH 写入的内容**（write 新建场景删除前的前置校验）。
 *
 * 用途：write 新建后用户可能又手动改了文件，此时"丢弃"若直接删文件会连带删掉用户手写的内容。
 * 放宽点：忽略换行风格与尾部空行差异（编辑器保存常见），其余任何差异都算"已被用户改动"。
 */
export function writtenContentMatches(content: string, written: string): boolean {
  if (typeof content !== 'string' || typeof written !== 'string') return false;
  if (written === '') return false; // 无写入内容可比（异常输入）：一律按"不匹配"走确认流程
  return canonical(content) === canonical(written);
}

/**
 * 若 DSH 写入的内容仍是文件**开头部分**（用户只在后面追加），返回用户追加的那段原文；
 * 否则返回 null（内容交织/被改写，无法安全拆分）。
 *
 * 用途：write 新建后用户又追加了内容时，支持"丢弃 DSH 写入的内容、保留我的新增"。
 * 判据严格：只有"写入内容整体是前缀"才视为可拆（用户改动是纯追加）；
 * 用户在中间插入或改动了 DSH 原文时一律 null，避免误删用户内容。
 */
export function userAppendedPart(content: string, written: string): string | null {
  if (typeof content !== 'string' || typeof written !== 'string' || written === '') return null;
  let matched = written;
  let idx = content.indexOf(written);
  if (idx === -1 && written.includes('\n')) {
    const normalized = written.includes('\r\n') ? written.replace(/\r\n/g, '\n') : written.replace(/\n/g, '\r\n');
    idx = content.indexOf(normalized);
    matched = normalized;
  }
  if (idx !== 0) return null;
  // 去掉衔接处空行，只留用户真正追加的内容
  const rest = content.slice(matched.length).replace(/^(?:\r?\n)+/, '');
  return rest.trim() === '' ? null : rest;
}

/**
 * 决定一条记录当前应在文件的哪一行落高亮（1-based）；**定位不到就返回 null**。
 *
 * 这条规则统一了此前不一致的两条路径（真机缺陷的根因）：
 * - `refreshFile`（切换 tab / 文件打开）原本就 `locateNewText === null → 跳过`；
 * - `applyDecoration`（record 与 adopt 走这条）原本回退到 `rec.line`，而恢复出来的记录
 *   `line` 是占位值 1 → 表现为"整份文件从第 1 行起被标成新增"（创建文件时那条 write 记录
 *   的 newText 是整份旧内容，用户改了文件后它自然定位不到）。
 *
 * 语义取舍：**宁可没有标记，也不要标在错误的位置**——错误的整片高亮会让人以为 DSH 改了整份文件，
 * 而 hover 又查不到对应记录（自相矛盾的界面）。历史记录本身仍留在账本/树里（可看可处置）。
 *
 * @param content 以**将要高亮的那个文档**的内存文本为基准（与 refreshFile 一致）
 * @param newText 记录的改后片段
 * @returns 1-based 行号；newText 为空或找不到 → null
 */
export function decorationTargetLine(content: string, newText: string): number | null {
  if (typeof content !== 'string' || typeof newText !== 'string' || newText === '') return null;
  const loc = locateNewText(content, newText);
  return loc === null ? null : loc.line;
}

/**
 * 把落在**空行**上的标记吸附到同一 hunk 内最近的有内容行（向上找）。
 *
 * 为什么需要（真机缺陷）：删除发生在文件末尾时，被删行在文档里没有实体，投影规则把它落到
 * hunk 末尾——而那里往往是结尾的空白行。VS Code 对**空行的背景装饰几乎不可见**，
 * 用户看到的现象就是"这次删除完全没有高亮"（实测：记录的 newText 是 `"\n## 标题\n\n"`，
 * 唯一一条 del 标记落在第 16 行的空行上，而 `⇠ 原:` 提示却在第 13 行，两者还错开 3 行）。
 *
 * 吸附规则：
 * - 非空行不动；
 * - 空行则从上一行起向上找，**不越过 hunk 起始行**（`floorLine`），避免标到无关内容上；
 * - hunk 内全为空行时保持原样（总比乱标好）。
 *
 * @param content  将要高亮的那个文档的内存文本
 * @param marks    行级标记（1-based）
 * @param floorLine 吸附下界（hunk 起始行，1-based）
 */
export function snapMarksToContent(
  content: string,
  marks: readonly HighlightLine[],
  floorLine: number,
): HighlightLine[] {
  if (typeof content !== 'string' || content === '' || marks.length === 0) return [...marks];
  const lines = content.split('\n');
  const blank = (ln: number): boolean => (lines[ln - 1] ?? '').trim() === '';
  const floor = Math.max(1, Math.floor(floorLine));
  return marks.map((m) => {
    if (!blank(m.line)) return m;
    for (let ln = m.line - 1; ln >= floor; ln--) {
      if (!blank(ln)) return { ...m, line: ln };
    }
    return m;
  });
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
