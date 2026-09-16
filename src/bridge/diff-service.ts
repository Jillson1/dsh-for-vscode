// src/bridge/diff-service.ts — A/B 组：修改可视化 vscode 组装层
// 职责：把 diff-tracker 的纯逻辑（定位/撤销编辑构造/修改栈/行级红绿 diff）接到 vscode API 上——
// record 时读文件定位修改区域并按行红绿高亮（新增行绿色、删除行红色，Cursor 风格；
// decoration + overview ruler）、记入修改栈；提供撤销（单处/全部）、保留（keep）、
// diff 对比视图、修改行 hover 说明（含可点击的操作按钮）。
// 纯数据路径（记录/定位/撤销编辑构造/红绿投影）在 diff-tracker 单测覆盖；本层是 vscode 装配。
import * as vscode from 'vscode';
import { relative } from 'node:path';
import {
  DiffStack,
  recordsFromDiffs,
  buildRevertEdit,
  locateNewText,
  pathsEqual,
  redGreenLines,
  mergeLineMarks,
  decorationTargetLine,
  diffNature,
  summarizeDiff,
  deletedLines,
  addedLines,
  planDiscard,
  writtenContentMatches,
  userAppendedPart,
  type ModificationRecord,
  type HighlightLine,
} from './diff-tracker';
import { ChangeBook, contentHash, type ChangeRecord, type ChangeSource, type RevertOutcome } from './change-book';

/**
 * hover 用的**紧凑** diff 预览：单个 ```diff 代码块（VS Code 原生红绿着色），
 * 最多 maxLines 行、每行截断 maxChars 字符，超出部分折叠为"另有 N 行"。
 */
function previewDiff(oldText: string, newText: string, maxLines = 4, maxChars = 120): string {
  const lines = [
    ...deletedLines(oldText, newText).map((l) => `- ${l}`),
    ...addedLines(oldText, newText).map((l) => `+ ${l}`),
  ];
  if (lines.length === 0) return '';
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l));
  const rest = lines.length - shown.length;
  const body = rest > 0 ? `${shown.join('\n')}\n… 另有 ${rest} 行` : shown.join('\n');
  return `\`\`\`diff\n${body}\n\`\`\``;
}

/** recordDiff 输入（与 host.ts BridgeMessageDeps.recordDiff 对齐）。 */
export interface DiffInput {
  path: string;
  cwd?: string;
  diffs: { oldText: string; newText: string }[];
  callId: string;
  /** 来源工具名（'edit' | 'write'）：决定"丢弃"是删除文件还是文本还原。 */
  tool?: string;
  /** F1 变更账本：来源通道（relay 实时 / replay 回放；缺省 relay）。 */
  source?: ChangeSource;
  /** F1：所属会话 id（账本按会话归档）。 */
  sessionId?: string;
  /** F1：所属轮次。 */
  turn?: number;
}

/** vscode API 依赖面（生产直接传 vscode 命名空间，测试可注入假实现验证调用形状）。 */
export interface DiffServiceDeps {
  window: Pick<
    typeof vscode.window,
    'createTextEditorDecorationType' | 'showWarningMessage' | 'showInformationMessage' | 'activeTextEditor' | 'visibleTextEditors'
  >;
  workspace: Pick<
    typeof vscode.workspace,
    'applyEdit' | 'registerTextDocumentContentProvider' | 'openTextDocument' | 'fs'
  >;
  languages: Pick<typeof vscode.languages, 'registerHoverProvider'>;
  commands: Pick<typeof vscode.commands, 'executeCommand'>;
  Uri: typeof vscode.Uri;
  Position: typeof vscode.Position;
  Range: typeof vscode.Range;
  WorkspaceEdit: typeof vscode.WorkspaceEdit;
  MarkdownString: typeof vscode.MarkdownString;
  Hover: typeof vscode.Hover;
  /** 读文件文本（生产 node:fs，测试注入桩）。 */
  readFileText(path: string): Promise<string>;
  /** 调试日志（生产接扩展 DSH 输出通道；不注入则静默）。 */
  log?(msg: string): void;
  /** 工作区根（相对路径兜底解析）。 */
  workspaceRoot?: string;
  /**
   * F1 变更账本（可选）：注入后 record 会写入账本（跨 Reload 持久化），
   * keep / revert / 清除标记会同步移除账本条目，保持"栈与账本按 callId 一致"。
   */
  book?: ChangeBook;
  /**
   * F1 当前会话 id getter（可选）：插件未在消息里带 sessionId 时的兜底。
   * 生产由扩展入口维护（收到带 sessionId 的上行消息即更新）。
   */
  sessionId?: () => string | undefined;
}

/** 一个装饰桶：装饰类型 + 已收集的区间。 */
interface Bucket {
  type: vscode.TextEditorDecorationType;
  ranges: vscode.Range[];
}

/** 每个文件一套：绿（纯新增）/ 红（纯删除）/ 琥珀（替换）+ 行尾注入的"被删原文"提示。 */
interface PathHandle {
  add: Bucket;
  del: Bucket;
  mod: Bucket;
  hints: Bucket[];
}

/**
 * A 组修改服务：高亮、撤销、diff 视图、hover 的统一入口。
 * 生命周期由 extension.ts 持有（单例），dispose 时清理所有 decoration。
 */
export class DiffService {
  private readonly stack = new DiffStack();
  /** 文件 → 红/绿两套 decoration（新增行绿、删除行红）+ 各自已收集的行区间。 */
  private readonly byPath = new Map<string, PathHandle>();
  /** F1：最近一次上报的会话 id（插件消息带 sessionId 时更新；账本归档用） */
  private lastSessionId: string | undefined;

  constructor(private readonly deps: DiffServiceDeps) {}

  /** 记录一条 applied diff：读文件 → 定位 newText 区域 → 高亮 + 入栈 + 写变更账本。 */
  async record(input: DiffInput): Promise<void> {
    this.deps.log?.(
      `record: path=${input.path} diffs=${input.diffs.length} callId=${input.callId} source=${input.source ?? 'relay'}`,
    );
    // F1：插件上报的会话 id 是账本归档的权威来源，记住它供本次及后续记账使用
    if (input.sessionId !== undefined && input.sessionId !== '') this.lastSessionId = input.sessionId;
    const records = recordsFromDiffs(input, this.deps.workspaceRoot);
    if (records.length === 0) {
      this.deps.log?.('record: recordsFromDiffs 返回空（路径解析失败或 hunk 无效）');
      return;
    }
    let content: string | null = null;
    try {
      content = await this.deps.readFileText(input.path);
    } catch (err) {
      this.deps.log?.(`record: 读文件失败 ${String(err)}`);
    }
    for (const rec of records) {
      // 同一处改动去重：running 与 settled 两次广播可能用不同 callId，
      // 若同文件已存在 oldText/newText 完全相同的记录，视为同一次改动 → 跳过，
      // 避免同一处出现两条记录（表现为 hover 分裂、要连点两次"丢弃改动"）。
      const existing = this.stack
        .forPath(rec.path)
        .find((r) => r.oldText === rec.oldText && r.newText === rec.newText);
      if (existing !== undefined) {
        this.deps.log?.(`record: 跳过重复改动 callId=${rec.callId}（已记于 ${existing.callId}）path=${rec.path}`);
        // F1：第二次广播（settled）带来的才是"文件已落盘"的内容——把既存记录的哈希补正，
        // 否则账本会拿着改动前的哈希，把 DSH 自己刚写的内容误判为"被外部修改"（stale 误报）。
        this.deps.book?.refreshHash(existing.callId, content === null ? '' : contentHash(content), rec.ts);
        continue;
      }
      if (this.stack.push(rec)) {
        // F1：写账本（持久化）。只有真正入栈的记录才记账，保证栈与账本条数一致。
        this.rememberInBook(rec, input, content);
        this.applyDecoration(rec, content);
      }
    }
    this.deps.log?.(`record: 完成，栈大小=${this.stack.size} 账本=${this.deps.book?.count() ?? '-'}`);
  }

  /** F1：把一条刚入栈的记录写入变更账本（含记录时的文件哈希，供 stale 判定） */
  private rememberInBook(rec: ModificationRecord, input: DiffInput, content: string | null): void {
    const book = this.deps.book;
    if (book === undefined) return;
    book.add({
      callId: rec.callId,
      sessionId: this.currentSessionId(),
      absPath: rec.path,
      path: this.relativePath(rec.path),
      tool: rec.tool,
      oldText: rec.oldText,
      newText: rec.newText,
      turn: input.turn,
      time: rec.ts,
      source: input.source ?? 'relay',
      // 哈希带的是**记录那一刻**的文件内容：之后被用户改动 → 与当前内容不符 → stale
      fileHashAtRecord: content === null ? '' : contentHash(content),
    });
  }

  /** F1：当前会话 id（消息里带来的 > 注入的 getter > 'local' 兜底桶） */
  private currentSessionId(): string {
    return this.lastSessionId ?? this.deps.sessionId?.() ?? 'local';
  }

  /** F1：绝对路径 → 工作区相对路径（树/显示用；不在工作区内则原样返回绝对路径） */
  private relativePath(absPath: string): string {
    const root = this.deps.workspaceRoot;
    if (root === undefined || root === '') return absPath;
    const rel = relative(root, absPath);
    return rel === '' || rel.startsWith('..') ? absPath : rel;
  }

  /**
   * 从修改栈移除一条记录，并同步移除账本条目（F1：栈与账本按 callId 保持一致）。
   * 抽成单一入口的原因：撤销有 4 条成功/失效路径、保留有 1 条，任何一处漏同步都会造成
   * "栈里没了、账本还在"——表现为 Reload 后幽灵记录复活，比彻底丢记录更难排查。
   */
  private dropRecord(callId: string): ModificationRecord | undefined {
    const rec = this.stack.remove(callId);
    if (rec !== undefined) this.deps.book?.removeByCallId(callId);
    return rec;
  }

  /**
   * F1 Reload 恢复：把账本里已持久化的变更重新灌回修改栈并重建高亮。
   *
   * 为什么不"重新走一遍 record"：账本记录已是最终形态（含**记录时**的文件哈希与 sessionId），
   * 重新 record 会把哈希刷成"当前内容"，从此 stale 判定永远为假——而 stale 正是账本存在的意义。
   * 因此这里只搬运 + 定位 + 高亮，绝不回写账本。
   *
   * @param records 账本记录（通常取某会话全部）
   * @returns 真正被采纳（栈里此前没有该 callId）的条数
   */
  adoptFromBook(records: readonly ChangeRecord[]): number {
    let adopted = 0;
    for (const r of records) {
      if (this.stack.get(r.callId) !== undefined) continue; // 实时广播已经记过：不重复
      const rec: ModificationRecord = {
        callId: r.callId,
        path: r.absPath,
        oldText: r.oldText,
        newText: r.newText,
        line: 1, // 占位：定位阶段回填
        lineCount:
          r.oldText === ''
            ? Math.max(1, r.newText.split('\n').length)
            : Math.max(1, r.oldText.split('\n').length),
        ts: r.time,
        tool: r.tool === 'unknown' ? undefined : r.tool,
      };
      if (!this.stack.push(rec)) continue;
      adopted += 1;
      if (this.lastSessionId === undefined) this.lastSessionId = r.sessionId;
      // 异步定位（读文件 / 用已打开的内存文档）：文件未打开时只入栈，打开时由 refreshFile 补高亮
      void (async () => {
        try {
          const editor = this.findEditor(rec.path);
          const content = editor !== undefined ? editor.document.getText() : await this.deps.readFileText(rec.path);
          this.applyDecoration(rec, content);
        } catch {
          this.deps.log?.(`adopt: 读取失败，仅入栈（${rec.path}）`);
        }
      })();
    }
    this.deps.log?.(`adopt: 采纳 ${adopted} 条账本记录，栈大小=${this.stack.size}`);
    return adopted;
  }

  /**
   * F1：把 revert 的执行结果映射为账本的 RevertOutcome。
   * 账本据此决定是否移除记录——**只有真撤销成功才移除**，失败（含用户取消）保留记录便于重试。
   */
  async revertOutcome(callId: string): Promise<RevertOutcome> {
    const r = await this.revert(callId);
    if (r.ok) return { status: 'reverted' };
    switch (r.reason) {
      case 'not-found':
        return { status: 'missing', reason: 'record not found' };
      case 'unknown-tool':
        return { status: 'refused', reason: 'tool unknown && old content empty' };
      case 'anchor-missing':
        return { status: 'anchor-missing', reason: 'newText no longer in file' };
      default:
        return { status: 'failed', reason: r.reason ?? 'unknown' };
    }
  }

  /** 把一条记录的红绿行高亮落到可见编辑器（文件已打开则立即显示）。 */
  private applyDecoration(rec: ModificationRecord, _content: string | null): void {
    const editor = this.findEditor(rec.path);
    if (!editor) {
      this.deps.log?.(`applyDecoration: 未找到已打开的编辑器（path=${rec.path}），等待打开时 refreshFile`);
      return; // 文件未打开：不抢占编辑器；打开时由 refreshFile 补高亮
    }
    // 定位基准统一用**编辑器的内存文档**：与 refreshFile 同源。
    // 之前用传入的 content（record 时刚从磁盘读的）会让"磁盘定位 + 内存高亮"错位（A 组踩过同类坑）。
    const startLine = decorationTargetLine(editor.document.getText(), rec.newText);
    if (startLine === null) {
      // 定位失败**不回退占位行号**：那会把整片内容误标成新增（真机缺陷）。
      // 该记录仍留在栈/账本/树里，只是不高亮——宁可无标记，也不要标错位置。
      this.deps.log?.(
        `applyDecoration: 跳过（newText 已不在文档中，不误标）path=${rec.path} newText=${rec.newText.slice(0, 30)}`,
      );
      return;
    }
    this.deps.log?.(`applyDecoration: 高亮 path=${rec.path} startLine=${startLine} newText=${rec.newText.slice(0, 30)}`);
    this.highlightLines(rec, editor, startLine);
  }

  /** 在编辑器上按行级 diff 投影红/绿区间（Cursor 风格：新增绿、删除红）。 */
  private highlightLines(rec: ModificationRecord, editor: vscode.TextEditor, startLine: number): void {
    const handle = this.decorationHandle(rec.path);
    const marks = mergeLineMarks(redGreenLines(rec.oldText, rec.newText, startLine));
    for (const mark of marks) {
      this.pushLineMark(handle, editor, mark);
    }
    if (marks.some((m) => m.kind !== 'add')) this.addDeletedHint(handle, editor, startLine, deletedLines(rec.oldText, rec.newText));
    this.applyAllDecorations(handle, editor);
  }

  /** 把红/绿两套 decoration 的区间应用到编辑器（push 只收集，此处才真正渲染）。 */
  private applyAllDecorations(
    handle: PathHandle,
    editor: vscode.TextEditor,
  ): void {
    void editor.setDecorations(handle.add.type, handle.add.ranges);
    void editor.setDecorations(handle.del.type, handle.del.ranges);
    void editor.setDecorations(handle.mod.type, handle.mod.ranges);
    for (const hint of handle.hints) void editor.setDecorations(hint.type, hint.ranges);
  }

  /**
   * 在被替换行的**行尾注入**被删原文（红色斜体、单行截断）：
   * VS Code 的 decoration 无法凭空插入"幽灵行"，这是"看得到红的那份内容"的最接近实现。
   */
  private addDeletedHint(handle: PathHandle, editor: vscode.TextEditor, line1Based: number, deleted: string[]): void {
    const text = deleted.join(' ⏎ ').replace(/s+/g, ' ').trim();
    if (text === '') return;
    const clipped = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const type = this.deps.window.createTextEditorDecorationType({
      after: { contentText: `  ⇠ 原: ${clipped}`, color: 'rgba(229, 57, 53, 0.9)', fontStyle: 'italic' },
    });
    const line = Math.min(editor.document.lineCount, Math.max(1, line1Based));
    handle.hints.push({ type, ranges: [editor.document.lineAt(line - 1).range] });
  }

  /** 释放该文件的行尾提示装饰（重建前调用，避免类型泄漏）。 */
  private disposeHints(handle: PathHandle): void {
    for (const hint of handle.hints) {
      try {
        hint.type.dispose();
      } catch {
        /* 已释放 */
      }
    }
    handle.hints = [];
  }

  /** 把一条红绿标记（1-based 文件行）追加到对应 decoration 的区间列表。 */
  private pushLineMark(
    handle: PathHandle,
    editor: vscode.TextEditor,
    mark: HighlightLine,
  ): void {
    const line1Based = Math.min(editor.document.lineCount, Math.max(1, mark.line));
    const range = editor.document.lineAt(line1Based - 1).range;
    const bucket = mark.kind === 'add' ? handle.add : mark.kind === 'del' ? handle.del : handle.mod;
    bucket.ranges.push(range);
  }

  /** 取（或创建）某文件的红/绿 decoration handle：新增行绿底、删除行红底 + overview ruler 标记。 */
  private decorationHandle(path: string): PathHandle {
    const existing = this.byPath.get(path);
    if (existing) return existing;
    const add = {
      type: this.deps.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(76, 175, 80, 0.22)',
        overviewRulerColor: 'rgba(76, 175, 80, 0.7)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
      ranges: [] as vscode.Range[],
    };
    const del = {
      type: this.deps.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(229, 57, 53, 0.22)',
        overviewRulerColor: 'rgba(229, 57, 53, 0.7)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
      ranges: [] as vscode.Range[],
    };
    const mod = {
      type: this.deps.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 193, 7, 0.20)',
        overviewRulerColor: 'rgba(255, 193, 7, 0.7)',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
      ranges: [] as vscode.Range[],
    };
    const handle: PathHandle = { add, del, mod, hints: [] };
    this.byPath.set(path, handle);
    return handle;
  }

  /** 找某文件的可见编辑器（活动编辑器优先）。Windows 路径大小写不敏感。 */
  private findEditor(path: string): vscode.TextEditor | undefined {
    const active = this.deps.window.activeTextEditor;
    if (active && pathsEqual(active.document.uri.fsPath, path)) return active;
    for (const ed of this.deps.window.visibleTextEditors) {
      if (pathsEqual(ed.document.uri.fsPath, path)) return ed;
    }
    return undefined;
  }

  /** 按路径查找该文件的 decoration handle（Windows 大小写不敏感）。 */
  private findHandle(path: string): PathHandle | undefined {
    for (const [key, handle] of this.byPath) {
      if (pathsEqual(key, path)) return handle;
    }
    return undefined;
  }

  /**
   * 文件重新可见 / 内容变更后重建高亮（打开、切换标签、外部写入被 VS Code 重载时调用）。
   * 注意：**handle 缺失但栈里有记录时要按需创建**——记录可能在文件不可见时到达
   * （此时 applyDecoration 直接 return，从未创建 handle）；若此处再因 handle 为空返回，
   * 那些记录将永远不高亮（历史缺陷）。
   */
  refreshFile(path: string): void {
    const editor = this.findEditor(path);
    if (!editor) return;
    const recs = this.stack.forPath(path);
    let handle = this.findHandle(path);
    if (handle === undefined) {
      if (recs.length === 0) return;
      handle = this.decorationHandle(path);
    }
    handle.add.ranges = [];
    handle.del.ranges = [];
    handle.mod.ranges = [];
    this.disposeHints(handle);
    const content = editor.document.getText();
    for (const rec of recs) {
      const loc = locateNewText(content, rec.newText);
      if (loc === null) continue; // newText 已被用户改写：该条不再高亮
      const marks = mergeLineMarks(redGreenLines(rec.oldText, rec.newText, loc.line));
      for (const mark of marks) this.pushLineMark(handle, editor, mark);
      if (marks.some((m) => m.kind !== 'add')) this.addDeletedHint(handle, editor, loc.line, deletedLines(rec.oldText, rec.newText));
    }
    this.applyAllDecorations(handle, editor);
  }

  /** 对所有"当前可见且有记录"的文件重建高亮（编辑器可见集合变化时调用）。 */
  refreshVisible(): void {
    const seen = new Set<string>();
    for (const ed of this.deps.window.visibleTextEditors) {
      const p = ed.document.uri.fsPath;
      if (seen.has(p)) continue;
      seen.add(p);
      this.refreshFile(p);
    }
  }

  /**
   * 丢弃一处修改（按 callId）：
   * - write 新建（旧内容为空）→ **删除该文件**（送系统回收站，可恢复）；
   * - 其余 → 文本还原（newText 片段替换回 oldText；edit 纯插入时 replacement 为空串）。
   */
  async revert(
    callId: string,
  ): Promise<{
    ok: boolean;
    reason?: string;
    path?: string;
    deletedFile?: boolean;
    keptUserPart?: boolean;
  }> {
    const rec = this.stack.get(callId);
    if (rec === undefined) return { ok: false, reason: 'not-found' };
    if (planDiscard(rec).kind === 'refuse') {
      // 旧内容为空且来源工具未知：文本还原会把整个文件替换成空串（实测事故）→ 拒绝
      this.deps.log?.(`revert: 拒绝执行（tool 未知且旧内容为空，防清空文件）${rec.path}`);
      return { ok: false, reason: 'unknown-tool', path: rec.path };
    }
    if (planDiscard(rec).kind === 'delete-file') {
      // 前置校验：文件是否**仍等于 DSH 写入的内容**。若用户之后手动改过，
      // 直接删除会连带删掉用户手写的内容 → 先弹确认，默认不删（只清标记）。
      let current: string | null = null;
      try {
        current = await this.deps.readFileText(rec.path);
      } catch {
        current = null; // 读不到（已删除等）：按"不匹配"走确认流程更安全
      }
      const untouched = current !== null && writtenContentMatches(current, rec.newText);
      this.deps.log?.(`revert: 删除前校验 path=${rec.path} 未被用户改动=${untouched}`);
      if (!untouched) {
        // 若用户改动是"纯追加"（DSH 写入内容仍是文件开头），额外提供"只丢 DSH 那部分"的选项
        const userPart = userAppendedPart(current ?? '', rec.newText);
        const DELETE = '仍然删除整个文件';
        const DROP_DSH = '丢弃 DSH 写入的内容（保留我的新增）';
        const question = `该文件在 DSH 写入后已被修改，直接删除会连你的改动一起删掉：${rec.path}`;
        // 只给两个出口：删整个文件 / 摘掉 DSH 内容保留用户新增（可拆分时）。
        // 「仅清标记、文件原样保留」这类需求走命令 DSH: 清除当前文件标记（保留改动）。
        const choice = userPart === null
          ? await this.deps.window.showWarningMessage(question, { modal: true }, DELETE)
          : await this.deps.window.showWarningMessage(question, { modal: true }, DELETE, DROP_DSH);
        this.deps.log?.(`revert: 用户选择=${choice ?? '(取消)'} 纯追加可拆分=${userPart !== null}`);
        if (choice === undefined) return { ok: false, reason: 'cancelled', path: rec.path };
        if (choice === DROP_DSH && userPart !== null) {
          const ok = await this.replaceWholeFile(rec.path, userPart);
          this.dropRecord(callId);
          this.clearDecorations(rec.path);
          this.refreshFile(rec.path);
          return ok
            ? { ok: true, path: rec.path, keptUserPart: true }
            : { ok: false, reason: 'apply-failed', path: rec.path };
        }
        // 其余（仍然删除整个文件）落到下面的删除流程
      }
      const gone = await this.deleteFileToTrash(rec.path);
      this.dropRecord(callId);
      this.clearDecorations(rec.path);
      return gone
        ? { ok: true, path: rec.path, deletedFile: true }
        : { ok: false, reason: 'delete-failed', path: rec.path };
    }
    // 定位基准必须与"将施加编辑的那个文档"一致：文件已打开时用**内存文档**文本
    // （编辑器可能有未保存改动、或外部写入后的重载时序差异），否则回退读磁盘。
    // 历史上混用（磁盘定位 + 内存施加）会在两者不一致时产生偏移，
    // 表现为 revert 后残留尾部字符（实测「）交」/「）交）交」）。
    const openEditor = this.findEditor(rec.path);
    let content: string;
    try {
      content = openEditor !== undefined ? openEditor.document.getText() : await this.deps.readFileText(rec.path);
    } catch {
      return { ok: false, reason: 'io-error', path: rec.path };
    }
    const edit = buildRevertEdit(content, rec);
    if (edit === null) {
      // newText 已不在文件中（文件被用户改动）→ 锚点失效：移除记录 + 重建高亮
      this.dropRecord(callId);
      this.clearDecorations(rec.path);
      this.refreshFile(rec.path);
      return { ok: false, reason: 'anchor-missing', path: rec.path };
    }
    const applied = await this.applyRevertEdit(edit.path, edit.startOffset, edit.currentText, edit.replacement);
    if (!applied) return { ok: false, reason: 'apply-failed', path: rec.path };
    this.dropRecord(callId);
    // 先无条件清空旧装饰再按剩余记录重建：避免任何重置失败路径留下"记录已删、高亮还在"的残留
    this.clearDecorations(rec.path);
    this.refreshFile(rec.path);
    return { ok: true, path: rec.path };
  }

  /** 用 WorkspaceEdit 应用撤销替换（按字符偏移定位到 position）。 */
  private async applyRevertEdit(path: string, startOffset: number, currentText: string, replacement: string): Promise<boolean> {
    const uri = this.deps.Uri.file(path);
    const doc = await this.deps.workspace.openTextDocument(uri);
    const start = doc.positionAt(startOffset);
    const end = doc.positionAt(startOffset + currentText.length);
    const edit = new this.deps.WorkspaceEdit();
    edit.replace(uri, new this.deps.Range(start, end), replacement);
    return this.deps.workspace.applyEdit(edit);
  }
  /** 撤销某文件全部（或全部文件）的修改；返回成功撤销条数。 */
  async revertAll(path?: string): Promise<number> {
    const targets = path !== undefined ? this.stack.forPath(path) : this.stack.all();
    let done = 0;
    for (const rec of targets) {
      const r = await this.revert(rec.callId);
      if (r.ok) done += 1;
    }
    return done;
  }

  /** 在 diff 编辑器里对比本次修改：左侧 = 修改前虚拟内容，右侧 = 当前文件。 */
  async showDiff(path: string): Promise<void> {
    const recs = this.stack.forPath(path);
    if (recs.length === 0) {
      void this.deps.window.showInformationMessage('当前文件没有 DSH 修改记录');
      return;
    }
    let content: string;
    try {
      content = await this.deps.readFileText(path);
    } catch {
      void this.deps.window.showWarningMessage(`无法读取文件：${path}`);
      return;
    }
    // 构造左侧虚拟内容：把所有记录的 newText 替换回 oldText
    let oldContent = content;
    for (const rec of recs) {
      oldContent = oldContent.replace(rec.newText, rec.oldText);
    }
    const oldUri = this.deps.Uri.parse(`dsh-diff://old/${encodeURIComponent(path)}`);
    this.virtualOld.set(oldUri.toString(), oldContent);
    const rightUri = this.deps.Uri.file(path);
    const title = `DSH 修改对比 · ${path.split(/[\\/]/).pop()}`;
    await this.deps.commands.executeCommand('vscode.diff', oldUri, rightUri, title);
  }

  /** 虚拟"修改前"文档缓存（provider 读取用）。 */
  private readonly virtualOld = new Map<string, string>();

  /** 注册 dsh-diff://old 虚拟文档 provider（extension.ts 装配时调用一次）。 */
  registerContentProvider(): vscode.Disposable {
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri: vscode.Uri): string => this.virtualOld.get(uri.toString()) ?? '',
    };
    return this.deps.workspace.registerTextDocumentContentProvider('dsh-diff', provider);
  }

  /**
   * 修改行 hover 说明：悬停在实际高亮行（红/绿）上时展示**分型文案**
   * （DSH 新增 / DSH 修改 / DSH 删除）+ 增删统计 + 改动内容 + 操作按钮。
   */
  registerHoverProvider(): vscode.Disposable {
    return this.deps.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover: (document, position): vscode.Hover | null => {
          const recs = this.stack.forPath(document.uri.fsPath);
          if (recs.length === 0) return null;
          const lineNo = position.line + 1; // 0-based → 1-based
          const content = document.getText();
          // 命中判定按"实际高亮行"（红/绿标记所在行）；同一行上的多条记录**聚合成一条 hover**，
          // 只展示信息量最大的那条（修改 > 删除 > 新增），避免同一处出现多个条目。
          const hits = recs.filter((r) => {
            const loc = locateNewText(content, r.newText);
            if (loc === null) return false;
            return redGreenLines(r.oldText, r.newText, loc.line).some((m) => m.line === lineNo);
          });
          if (hits.length === 0) return null;
          const rankOf = (r: ModificationRecord): number => {
            const n = diffNature(r.oldText, r.newText);
            return n === 'modify' ? 2 : n === 'del' ? 1 : 0;
          };
          const hit = hits.reduce((best, cur) => (rankOf(cur) >= rankOf(best) ? cur : best));

          const nature = diffNature(hit.oldText, hit.newText);
          const { added, deleted } = summarizeDiff(hit.oldText, hit.newText);
          const label = nature === 'add' ? '新增' : nature === 'del' ? '删除' : '修改';
          const when = new Date(hit.ts).toLocaleTimeString();
          const stats = [added > 0 ? `+${added} 行` : '', deleted > 0 ? `−${deleted} 行` : '']
            .filter((s) => s !== '')
            .join(' / ');

          const md = new this.deps.MarkdownString(undefined, true);
          md.isTrusted = true; // 允许命令链接（hover 按钮）
          const lineNote = hits.length > 1 ? ` · 本行 ${hits.length} 处` : '';
          md.appendMarkdown(`**DSH ${label}** · ${when}${stats === '' ? '' : ` · ${stats}`}${lineNote}\n\n`);
          const preview = previewDiff(hit.oldText, hit.newText);
          if (preview !== '') {
            md.appendMarkdown(`${preview}\n\n`);
          }
          // 按钮：丢弃（edit → 还原改动；write 新建 → 删除文件）+ 保留 + 查看对比
          const arg = encodeURIComponent(JSON.stringify([hit.callId]));
          const plan = planDiscard(hit);
          if (plan.kind === 'refuse') {
            // 来源工具未知（旧版桥接未转发 tool）：不提供丢弃按钮，避免文本还原清空文件
            md.appendMarkdown(
              `[$(check) 保留](command:dsh.diff.keep?${arg})　·　[查看对比](command:dsh.diff.show)`,
            );
            md.appendMarkdown(`\n\n_未收到来源工具信息，无法安全丢弃（请 Reload Window 升级桥接）_`);
          } else {
            const discardLabel = plan.kind === 'delete-file' ? '$(trash) 丢弃文件' : '$(discard) 丢弃改动';
            md.appendMarkdown(
              `[${discardLabel}](command:dsh.diff.revert?${arg})　[$(check) 保留](command:dsh.diff.keep?${arg})　·　[查看对比](command:dsh.diff.show)`,
            );
          }
          return new this.deps.Hover(md);
        },
      },
    );
  }

  /** 用整文件替换写回内容（"丢弃 DSH 内容、保留我的新增"用）；失败返回 false。 */
  private async replaceWholeFile(path: string, text: string): Promise<boolean> {
    try {
      const uri = this.deps.Uri.file(path);
      const doc = await this.deps.workspace.openTextDocument(uri);
      const full = new this.deps.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      const edit = new this.deps.WorkspaceEdit();
      edit.replace(uri, full, text);
      const ok = await this.deps.workspace.applyEdit(edit);
      this.deps.log?.(`revert: 已写回（仅保留用户新增）${path}`);
      return ok;
    } catch (err) {
      this.deps.log?.(`revert: 写回失败 ${path} ${String(err)}`);
      return false;
    }
  }

  /** 删除文件（送系统回收站，可从回收站恢复）；失败返回 false。 */
  private async deleteFileToTrash(path: string): Promise<boolean> {
    try {
      await this.deps.workspace.fs.delete(this.deps.Uri.file(path), { useTrash: true });
      this.deps.log?.(`revert: 已删除文件（回收站）${path}`);
      return true;
    } catch (err) {
      this.deps.log?.(`revert: 删除文件失败 ${path} ${String(err)}`);
      return false;
    }
  }

  /**
   * 清空某文件的红绿高亮（文件被删除 / 记录被清空时）。
   * 对**所有**可见编辑器（含分屏同一文件）都清一遍，避免只清了活动编辑器、
   * 另一个编辑器上残留旧区间（表现为"记录没了但高亮还在、hover 又无内容"）。
   */
  clearDecorations(path: string): void {
    const handle = this.findHandle(path);
    if (handle === undefined) return;
    handle.add.ranges = [];
    handle.del.ranges = [];
    handle.mod.ranges = [];
    this.disposeHints(handle);
    let touched = 0;
    for (const ed of this.deps.window.visibleTextEditors) {
      if (!pathsEqual(ed.document.uri.fsPath, path)) continue;
      this.applyAllDecorations(handle, ed);
      touched += 1;
    }
    if (touched === 0) {
      this.deps.log?.(`clearDecorations: 文件当前不可见（${path}），已重置区间，下次可见时自动为空`);
    }
  }

  /**
   * 清除某文件的全部 DSH 标记（保留改动）：移除该文件的所有记录 + 清空高亮。
   * 用途：记录与装饰状态错位时（hover 已无内容但高亮还在）的稳妥清理入口，
   * 以及用户"我不想再看到这些标记"的一键操作。语义等同对该文件逐条 keep。
   */
  clearMarksForFile(path: string): number {
    const recs = this.stack.forPath(path);
    for (const rec of recs) this.dropRecord(rec.callId);
    this.clearDecorations(path);
    this.refreshFile(path);
    return recs.length;
  }

  /**
   * 点击 edit 卡片时的精确跳行：按 oldText 在记录里找到对应那次修改，
   * 返回其 newText 在文件中的当前行号（1-based）。
   * 必要性：改前片段（oldText）落盘后已不在文件里，直接 indexOf 必然定位失败，
   * 必须用改后片段（newText）定位——这也是修掉"三处 edit 都跳到同一行"的关键。
   */
  async lineForOldText(path: string, oldText: string): Promise<number | undefined> {
    const matches = this.stack.forPath(path).filter((r) => r.oldText === oldText);
    if (matches.length === 0) return undefined;
    const rec = matches[matches.length - 1];
    const editor = this.findEditor(rec.path);
    let content: string | null = editor !== undefined ? editor.document.getText() : null;
    if (content === null) {
      try {
        content = await this.deps.readFileText(rec.path);
      } catch {
        return undefined;
      }
    }
    const loc = locateNewText(content, rec.newText);
    return loc === null ? undefined : loc.line;
  }

  /**
   * 保留一处修改（keep）：文件改动不动，仅从修改栈移除该条记录并重建高亮。
   * 语义：用户认可该改动，不再标记为"待撤销的 DSH 修改"。
   */
  async keep(callId: string): Promise<{ ok: boolean; reason?: string; path?: string }> {
    const rec = this.dropRecord(callId);
    if (rec === undefined) return { ok: false, reason: 'not-found' };
    this.refreshFile(rec.path);
    return { ok: true, path: rec.path };
  }

  /** 某文件是否有修改记录（命令可用性判断）。 */
  hasRecords(path: string): boolean {
    return this.stack.forPath(path).length > 0;
  }

  /** 某文件最后一条修改记录的 callId（后改先撤；无记录返回 undefined）。 */
  lastCallId(path: string): string | undefined {
    const recs = this.stack.forPath(path);
    return recs.length === 0 ? undefined : recs[recs.length - 1].callId;
  }

  /** 修改记录数（无 path = 全部；有 path = 该文件）。 */
  recordCount(path?: string): number {
    return path === undefined ? this.stack.size : this.stack.forPath(path).length;
  }

  /** 清理全部 decoration（扩展停用）。 */
  dispose(): void {
    for (const handle of this.byPath.values()) {
      try {
        handle.add.type.dispose();
        handle.del.type.dispose();
        handle.mod.type.dispose();
        for (const hint of handle.hints) hint.type.dispose();
      } catch {
        /* 已释放 */
      }
    }
    this.byPath.clear();
    this.stack.clear();
  }
}
