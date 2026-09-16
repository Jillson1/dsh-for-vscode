// src/bridge/diff-service.ts — A 组：修改可视化 vscode 组装层
// 职责：把 diff-tracker 的纯逻辑（定位/撤销编辑构造/修改栈）接到 vscode API 上——
// record 时读文件定位修改区域并高亮（TextEditorDecorationType + gutter + overview ruler）、
// 记入修改栈；提供撤销（单处/全部）、diff 对比视图、修改行 hover 说明。
// 纯数据路径（记录/定位/撤销编辑构造）在 diff-tracker 单测覆盖；本层是 vscode 装配。
import * as vscode from 'vscode';
import { DiffStack, recordsFromDiffs, buildRevertEdit, locateNewText, pathsEqual, type ModificationRecord } from './diff-tracker';

/** recordDiff 输入（与 host.ts BridgeMessageDeps.recordDiff 对齐）。 */
export interface DiffInput {
  path: string;
  cwd?: string;
  diffs: { oldText: string; newText: string }[];
  callId: string;
}

/** vscode API 依赖面（生产直接传 vscode 命名空间，测试可注入假实现验证调用形状）。 */
export interface DiffServiceDeps {
  window: Pick<
    typeof vscode.window,
    'createTextEditorDecorationType' | 'showWarningMessage' | 'showInformationMessage' | 'activeTextEditor' | 'visibleTextEditors'
  >;
  workspace: Pick<
    typeof vscode.workspace,
    'applyEdit' | 'registerTextDocumentContentProvider' | 'openTextDocument'
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
}

/**
 * A 组修改服务：高亮、撤销、diff 视图、hover 的统一入口。
 * 生命周期由 extension.ts 持有（单例），dispose 时清理所有 decoration。
 */
export class DiffService {
  private readonly stack = new DiffStack();
  /** 文件 → decoration type + 该文件已收集的高亮区间。 */
  private readonly byPath = new Map<string, { type: vscode.TextEditorDecorationType; ranges: vscode.Range[] }>();

  constructor(private readonly deps: DiffServiceDeps) {}

  /** 记录一条 applied diff：读文件 → 定位 newText 区域 → 高亮 + 入栈。 */
  async record(input: DiffInput): Promise<void> {
    this.deps.log?.(`record: path=${input.path} diffs=${input.diffs.length} callId=${input.callId}`);
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
      if (this.stack.push(rec)) {
        this.applyDecoration(rec, content);
      }
    }
    this.deps.log?.(`record: 完成，栈大小=${this.stack.size}`);
  }

  /** 把一条记录的高亮落到可见编辑器（文件已打开则立即显示）。 */
  private applyDecoration(rec: ModificationRecord, content: string | null): void {
    const editor = this.findEditor(rec.path);
    if (!editor) {
      this.deps.log?.(`applyDecoration: 未找到已打开的编辑器（path=${rec.path}），等待打开时 refreshFile`);
      return; // 文件未打开：不抢占编辑器；打开时由 refreshFile 补高亮
    }
    const line = content !== null ? locateNewText(content, rec.newText) : null;
    const startLine = line !== null ? line.line : rec.line; // 定位失败回退记录行号（尽力而为）
    const lineCount = line !== null ? Math.max(1, rec.newText.split('\n').length) : rec.lineCount;
    this.deps.log?.(`applyDecoration: 高亮 path=${rec.path} startLine=${startLine} lineCount=${lineCount} newText=${rec.newText.slice(0, 30)}`);
    this.highlightRange(rec.path, editor, startLine, lineCount);
  }

  /** 在编辑器上高亮 [startLine-1, startLine-1+lineCount) 行区间（合并到该文件的 decoration）。 */
  private highlightRange(path: string, editor: vscode.TextEditor, startLine1Based: number, lineCount: number): void {
    const handle = this.decorationHandle(path);
    const lastLine = Math.min(editor.document.lineCount - 1, startLine1Based - 1 + lineCount - 1);
    const start = new this.deps.Position(startLine1Based - 1, 0);
    const end = editor.document.lineAt(lastLine).range.end;
    handle.ranges.push(new this.deps.Range(start, end));
    void editor.setDecorations(handle.type, handle.ranges);
  }

  /** 取（或创建）某文件的 decoration handle：修改行 = 半透明黄底 + overview ruler 标记。 */
  private decorationHandle(path: string): { type: vscode.TextEditorDecorationType; ranges: vscode.Range[] } {
    const existing = this.byPath.get(path);
    if (existing) return existing;
    const type = this.deps.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 193, 7, 0.18)',
      overviewRulerColor: 'rgba(255, 193, 7, 0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    const handle = { type, ranges: [] as vscode.Range[] };
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
  private findHandle(path: string): { type: vscode.TextEditorDecorationType; ranges: vscode.Range[] } | undefined {
    for (const [key, handle] of this.byPath) {
      if (pathsEqual(key, path)) return handle;
    }
    return undefined;
  }

  /** 文件重新打开 / 编辑后重建高亮（用户打开被改文件时调用）。 */
  refreshFile(path: string): void {
    const editor = this.findEditor(path);
    const handle = this.findHandle(path);
    if (!editor || !handle) return;
    const recs = this.stack.forPath(path);
    const ranges: vscode.Range[] = [];
    const content = editor.document.getText();
    for (const rec of recs) {
      const loc = locateNewText(content, rec.newText);
      if (loc === null) continue; // newText 已被用户改写：该条不再高亮
      const lc = Math.max(1, rec.newText.split('\n').length);
      const lastLine = Math.min(editor.document.lineCount - 1, loc.line - 1 + lc - 1);
      ranges.push(new this.deps.Range(new this.deps.Position(loc.line - 1, 0), editor.document.lineAt(lastLine).range.end));
    }
    handle.ranges = ranges;
    void editor.setDecorations(handle.type, ranges);
  }

  /**
   * 撤销单处修改（按 callId）：读文件 → newText 仍在则替换回 oldText → 清高亮与记录。
   * @returns 撤销结果（供命令入口提示）
   */
  async revert(callId: string): Promise<{ ok: boolean; reason?: string; path?: string }> {
    const rec = this.stack.get(callId);
    if (rec === undefined) return { ok: false, reason: 'not-found' };
    let content: string;
    try {
      content = await this.deps.readFileText(rec.path);
    } catch {
      return { ok: false, reason: 'io-error', path: rec.path };
    }
    const edit = buildRevertEdit(content, rec);
    if (edit === null) {
      // 文件已被用户改动，锚点失效：放弃（记录移除，高亮重建）
      this.stack.remove(callId);
      this.refreshFile(rec.path);
      return { ok: false, reason: 'anchor-missing', path: rec.path };
    }
    const applied = await this.applyRevertEdit(edit.path, edit.startOffset, edit.currentText, edit.replacement);
    if (!applied) return { ok: false, reason: 'apply-failed', path: rec.path };
    this.stack.remove(callId);
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

  /** 修改行 hover 说明：文件内任意位置 hover 时，若该行在修改区间内展示摘要。 */
  registerHoverProvider(): vscode.Disposable {
    return this.deps.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover: (document, position): vscode.Hover | null => {
          const recs = this.stack.forPath(document.uri.fsPath);
          if (recs.length === 0) return null;
          const lineNo = position.line + 1; // 0-based → 1-based
          const content = document.getText();
          const hit = recs.find((r) => {
            const loc = locateNewText(content, r.newText);
            if (loc === null) return false;
            const lc = Math.max(1, r.newText.split('\n').length);
            return lineNo >= loc.line && lineNo < loc.line + lc;
          });
          if (hit === undefined) return null;
          const when = new Date(hit.ts).toLocaleTimeString();
          const md = new this.deps.MarkdownString();
          md.appendMarkdown(`**DSH 修改** · ${when}\n\n`);
          md.appendCodeblock(hit.newText.slice(0, 120), 'text');
          md.appendMarkdown(`可运行 **DSH: 撤销修改** 还原（原文 ${hit.oldText.length} 字符）。`);
          return new this.deps.Hover(md);
        },
      },
    );
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
        handle.type.dispose();
      } catch {
        /* 已释放 */
      }
    }
    this.byPath.clear();
    this.stack.clear();
  }
}
