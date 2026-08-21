// src/addToDsh.ts — "Add to DSH" 命令：右键文件/选区 → 注入文件引用到 DSH 输入框
// 职责：构造 "@path" / "@path:start-end" 文本，选一个可见的 DSH 面板 webview 下行投递，
// 由桥接转发给 dsh-file-jump 插件写入 composer。本模块不触碰 vscode 以外的依赖，
// 纯逻辑（selectionRangeText）可与测试桩直接验证。
import * as vscode from 'vscode';
import { t } from './i18n';
import type { DshPanelProvider } from './panel/provider';

/** Add to DSH 的注入目标：左右两个面板 provider（按可见优先选取） */
export interface AddToDshTargets {
  providers: [DshPanelProvider, DshPanelProvider];
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
export async function addFileToDsh(uri: vscode.Uri, targets: AddToDshTargets): Promise<void> {
  dispatch(targets, `@${uri.fsPath}`);
}

/** 注入编辑区右键的当前选区（带行号范围） */
export async function addSelectionToDsh(targets: AddToDshTargets): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(t('addToDsh.notReady'));
    return;
  }
  dispatch(targets, selectionRangeText(editor.document, editor.selection));
}

/** 选一个可见面板投递；都不可见则提示先打开面板。返回是否成功投递。 */
export function dispatch(targets: AddToDshTargets, text: string): boolean {
  const [primary, secondary] = targets.providers;
  // injectComposer 内部已判定 view.visible；可见优先选主面板，其次右侧面板
  const ok = primary.injectComposer(text) || secondary.injectComposer(text);
  if (!ok) {
    void vscode.window.showWarningMessage(t('addToDsh.notReady'));
    return false;
  }
  void vscode.window.showInformationMessage(t('addToDsh.injected'));
  return true;
}
