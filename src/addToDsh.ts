// src/addToDsh.ts — "Add to DSH" 命令：右键文件/选区 → 注入文件引用到 DSH 输入框
// 职责：构造 "@path" / "@path:start-end" 文本，交给注入器写进 DSH 输入框草稿。
//
// **面板未打开时由注入器负责自动打开并等待就绪**（见 extension.ts 的 postToPanelDsh）——
// 本模块只管"文本长什么样 + 成功后怎么提示"，不关心面板状态，因此可以纯逻辑直测。
import * as vscode from 'vscode';
import { t } from './i18n';

/**
 * 注入器：把文本写进 DSH 当前会话输入框。
 * 返回 false = 面板不可达（自动打开失败 / 桥接未就绪超时），调用方据此提示。
 */
export interface ComposerInjector {
  (text: string): Promise<boolean>;
}

/**
 * 从选区构造文件引用文本（行号 1-based）：
 * - 单行选区 → "@路径"
 * - 多行选区 → "@路径:起始行-结束行"
 * VS Code 的 Selection.line 是 0-based，需 +1 转 1-based 与扩展/DSH 侧行号语义一致。
 */
export function selectionRangeText(doc: vscode.TextDocument, sel: vscode.Selection): string {
  const start = Math.min(sel.start.line, sel.end.line) + 1;
  const end = Math.max(sel.start.line, sel.end.line) + 1;
  const ref = `@${doc.uri.fsPath}`;
  return start === end ? ref : `${ref}:${start}-${end}`;
}

/** 注入文件树右键的整个文件（仅路径，无行号） */
export async function addFileToDsh(uri: vscode.Uri, inject: ComposerInjector): Promise<void> {
  await dispatch(inject, `@${uri.fsPath}`);
}

/** 注入编辑区右键的当前选区（带行号范围） */
export async function addSelectionToDsh(inject: ComposerInjector): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(t('addToDsh.noEditor'));
    return;
  }
  await dispatch(inject, selectionRangeText(editor.document, editor.selection));
}

/**
 * 投递并给出必要的用户反馈。
 *
 * 成功**不弹提示**：引用会直接出现在 DSH 输入框里（面板打开时也看得见），
 * 成功用例的 toast 只是打扰（真机反馈：每次添加文件都弹「已添加到 DSH 输入框」太吵，
 * 与 Claude Code 的 Add File to Chat 无声注入一致）。
 * 失败仍然必须明确告知——那是用户唯一能知道"没生效"的途径。
 */
export async function dispatch(inject: ComposerInjector, text: string): Promise<boolean> {
  const ok = await inject(text);
  if (!ok) {
    void vscode.window.showWarningMessage(t('addToDsh.notReady'));
    return false;
  }
  return true;
}
