// src/bridge/host.ts — 桥接消息处理：外链打开 / 文件跳转
// 职责：把 webview 顶层转发来的桥接消息（bridgeOpenExternal / bridgeOpenFile）落地为
// VS Code 动作（打开外部浏览器 / 打开文本文档），并做协议白名单与路径解析的纵深防御。
// 依赖注入设计：生产侧接 vscode API（openExternal / showTextDocument），测试侧注入假实现，
// 保证纯逻辑可被 node:test 直接验证。
import { isAbsolute, resolve } from 'node:path';
import type { PanelMessage } from '../panel/html';

/** 桥接消息处理依赖（生产接 vscode API，测试注入假实现） */
export interface BridgeMessageDeps {
  /** 打开外部链接（生产接 vscode.env.openExternal，返回是否成功） */
  openExternal(url: string): Thenable<boolean>;
  /** 打开文本文档（生产接 vscode.window.showTextDocument） */
  openTextDocument(path: string): Thenable<void>;
  /** 读取文件文本（edit 场景定位 oldText 用；生产接 node:fs readFileSync/async） */
  readFileText(path: string): Promise<string>;
  /** 打开文档后定位到 1-based 行并高亮（生产接 showTextDocument + revealRange） */
  revealLine(path: string, line: number): Thenable<void>;
  /** 弹用户可见提示（生产接 vscode.window.showWarningMessage，测试注入假实现以断言） */
  showWarning(msg: string): void;
  /** 工作区根目录（相对路径解析的兜底基准，生产由扩展入口注入） */
  workspaceRoot?: string;
}

/**
 * 提取错误摘要：优先取 Error.message，其余类型做保守的字符串化，兜底空串。
 * 用于把打开失败原因并入用户提示，避免把内部错误对象原样展示。
 */
function errSummary(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return '';
  return String(err);
}

/** 错误是否表示"文件在磁盘上不存在"（write 未落盘 / 路径失效等）。 */
function isFileMissingError(err: unknown): boolean {
  const msg = errSummary(err);
  return /ENOENT|no such file|Unable to resolve nonexistent/i.test(msg);
}

/**
 * 解析文件路径：绝对路径直接采用；相对路径依次按 会话 cwd → 工作区根 作为基准解析。
 * 安全规则：形似 URL 的协议串（如 https://、javascript:）一律拒绝，
 * 但 Windows 盘符（C:\ 或 C:/）不是协议，需要放行。
 */
export function resolveBridgePath(raw: string, sessionCwd: string | undefined, workspaceRoot: string | undefined):
  { kind: 'abs'; path: string } | { kind: 'invalid' } {
  // 路径形似 URL 一律拒绝（协议串）；Windows 盘符不属于协议，予以放行
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    return { kind: 'invalid' };
  }
  // 绝对路径直接采用（跨平台：Windows 盘符与 POSIX / 开头都算绝对）
  if (isAbsolute(raw)) return { kind: 'abs', path: raw };
  // 相对路径：优先用会话 cwd，缺失时退回工作区根；两者都无则无法解析
  const base = sessionCwd ?? workspaceRoot;
  if (base === undefined) return { kind: 'invalid' };
  return { kind: 'abs', path: resolve(base, raw) };
}

/**
 * 在文件内容中定位改前片段（oldText）的起始行号（1-based）。
 * 返回 `undefined` 表示无法定位：oldText 为空、内容不含该片段（文件可能已被后续修改）。
 * 取第一次出现位置，符合 edit 单次匹配语义；replace_all 场景定位第一处。
 * @param content 文件当前全文
 * @param oldText 改前片段（edit 的 old_string）
 * @returns 1-based 起始行号，或 undefined
 */
export function computeLineByText(content: string, oldText: string): number | undefined {
  if (typeof content !== 'string' || typeof oldText !== 'string' || oldText === '') return undefined;
  const idx = content.indexOf(oldText);
  if (idx === -1) return undefined;
  return content.slice(0, idx).split('\n').length;
}

/**
 * 处理桥接消息：外链打开走协议白名单，文件跳转走路径解析。
 * 文件跳转的定位优先级：消息自带 line（read 场景已带 offset）→ 消息自带 oldText
 * （edit 场景由 DSH 插件注入改前片段，这里读文件 indexOf 定位起始行）。
 */
export async function handleBridgeMessage(msg: PanelMessage, deps: BridgeMessageDeps): Promise<void> {
  if (msg.type === 'bridgeOpenExternal') {
    // 协议白名单：仅 http/https（与桥接侧白名单双重校验，纵深防御）
    if (/^https?:\/\//i.test(msg.url)) {
      try {
        await deps.openExternal(msg.url);
      } catch (err) {
        // 打开外链可能失败（如无默认浏览器），捕获后给用户可见反馈而非未处理拒绝
        deps.showWarning(`无法打开链接：${msg.url}（${errSummary(err)}）`);
      }
    }
    return;
  }
  if (msg.type === 'bridgeOpenFile') {
    const r = resolveBridgePath(msg.path, msg.cwd, deps.workspaceRoot);
    if (r.kind === 'abs') {
      try {
        // 打开文档可能因文件不存在/无权限等失败，捕获后给用户可见反馈而非未处理拒绝
        await deps.openTextDocument(r.path);
        // 定位目标行：优先消息自带 line（read 场景的 offset 直传），
        // 缺省但有 oldText（edit 场景的改前片段）时读文件 indexOf 计算。
        let targetLine = typeof msg.line === 'number' && Number.isFinite(msg.line) && msg.line >= 1
          ? msg.line
          : undefined;
        if (targetLine === undefined && typeof msg.oldText === 'string' && msg.oldText !== '') {
          try {
            const content = await deps.readFileText(r.path);
            targetLine = computeLineByText(content, msg.oldText);
          } catch {
            targetLine = undefined; // 读文件失败（权限/IO）：只打开文件，不跳行
          }
        }
        if (targetLine !== undefined) {
          try {
            await deps.revealLine(r.path, targetLine);
          } catch (err) {
            // 跳行失败（行号越界等）不影响文件已打开，仅提示定位失败
            deps.showWarning(`无法定位到第 ${targetLine} 行：${r.path}（${errSummary(err)}）`);
          }
        }
      } catch (err) {
        // 文案内联固定提示（本模块纯逻辑，直接断言，与 Task 7 的 i18n 无关）
        // write 新建场景文件可能尚未落盘（被拒/失败），错误若指向"文件不存在"
        // 则给针对性的提示，避免误导为路径解析问题。
        const summary = errSummary(err);
        deps.showWarning(isFileMissingError(err)
          ? `文件不存在（可能尚未创建或未落盘）：${r.path}`
          : `无法打开文件：${r.path}（${summary}）`);
      }
    } else {
      // 路径无法解析（危险协议或缺少基准目录）：仅弹提示，不打断面板与桥接流程
      deps.showWarning(`无法解析路径：${msg.path}`);
    }
    return;
  }
}
