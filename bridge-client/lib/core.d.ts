// bridge-client/lib/core.d.ts — core.js 的类型声明（供 TS 侧 import 获得类型）
// 与 core.js 的运行时导出保持一致；纯逻辑无 DOM，可在 node 环境 import。

/** 外链协议白名单：仅 http/https 且非空返回 true */
export function isAllowedExternalUrl(url: string): boolean;

/** 构造"打开外链"消息 */
export function buildOpenExternalMessage(url: string): { kind: 'openExternal'; url: string };

/** 构造"打开文件"消息（cwd 为会话工作目录；oldText/newText 为工具卡片改前/改后片段，均可选） */
export function buildOpenFileMessage(
  path: string,
  cwd: string | undefined,
  oldText?: string,
  newText?: string,
): { kind: 'openFile'; path: string; cwd?: string; oldText?: string; newText?: string };

/** 构造"diff 已应用"转发消息（iframe 插件 → 父页面 → 扩展；tool 决定丢弃语义） */
export function buildDiffAppliedMessage(payload: unknown): {
  kind: 'diffApplied';
  path: string;
  diffs: { oldText: string; newText: string }[];
  callId: string;
  cwd?: string;
  tool?: string;
  /** F1 变更账本：'relay' 实时广播 / 'replay' 历史回放（缺失时扩展按 relay 处理） */
  source?: 'relay' | 'replay';
  /** F1：所属会话 id（扩展按会话归档） */
  sessionId?: string;
  /** F1：所属轮次 */
  turn?: number;
} | null;

/** 构造"工作区同步回执"消息（bridgeAck，path 可选；capabilities 为能力表，可选） */
export function buildSyncWorkspaceAck(
  ok: boolean,
  path?: string,
  capabilities?: string[],
): { kind: 'bridgeAck'; ok: boolean; path?: string; capabilities?: string[] };

/** 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板） */
export function buildCopyTextMessage(text: string, requestId: string): { kind: 'copyText'; text: string; requestId: string };

/** 构造"复制文本回执"消息（父页面 → iframe 页面） */
export function buildCopyTextAck(requestId: string, ok: boolean): { kind: 'copyTextAck'; requestId: string; ok: boolean };

/** 校验来自父页面的消息 token（握手防伪） */
export function isBridgeMessage(data: unknown, token: string): boolean;

/** 握手 token 字段名（父页面发来的消息里携带） */
export const HANDSHAKE_TOKEN_KEY: string;

/** 键盘事件关键字段（getShortcutCommand 的输入，兼容真实 KeyboardEvent 与测试桩） */
interface ShortcutEventLike {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** 编辑命令枚举（getShortcutCommand 的返回） */
type EditCommand = 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo';

/**
 * 从键盘事件判定"标准编辑快捷键"命令（VS Code 吞掉 iframe 内 Cmd+C/V/A 的修复）。
 * 命中返回对应编辑命令；未命中返回 null（调用方应放行原事件）。
 */
export function getShortcutCommand(e: ShortcutEventLike | null | undefined): EditCommand | null;

/** 判定元素是否为可编辑元素（textarea / 可输入 input / contenteditable） */
export function isEditableElement(el: unknown): boolean;

/** 计算在 [start, end) 选区插入 text 后的新值（越界/负值归一） */
export function computeInsertedValue(
  value: string | null | undefined,
  start: number,
  end: number,
  text: string,
): string;

/** 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，粘贴兜底用） */
export function buildReadTextMessage(requestId: string): { kind: 'readText'; requestId: string };

/** 构造"读取剪贴板回执"消息（父页面 → iframe 页面）；成功带 text，失败省略 text */
export function buildReadTextAck(
  requestId: string,
  ok: boolean,
  text?: string,
): { kind: 'readTextAck'; requestId: string; ok: boolean; text?: string };

// ============================================================================
// 交互增强地基（bridge 0.4.0）：能力表 + 新消息构造/校验（与 core.js 一一对应）
// ============================================================================

/** 桥接具备的能力表（握手 bridgeAck 下发，扩展据此门控命令显隐） */
export const BRIDGE_CAPABILITIES: string[];

/** 上行消息投递事件名（插件 dispatch、桥接监听；两侧必须一致） */
export const UPLINK_EVENT: string;

/** 会话状态消息（F7） */
export interface SessionStateMsg {
  kind: 'sessionState';
  sessionId: string;
  running: boolean;
  turn: number;
  pending: number;
}

/** 审批请求消息（F6） */
export interface ApprovalRequestMsg {
  kind: 'approvalRequest';
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

/** 提问请求消息（F8） */
export interface QuestionRequestMsg {
  kind: 'questionRequest';
  sessionId: string;
  questionId: string;
  questions: object[];
}

/** 变更记录（桥接子集；字段与扩展 ChangeRecord 对齐） */
export interface ChangeRecordMsg {
  callId: string;
  path: string;
  absPath: string;
  sessionId?: string;
  turn?: number;
  tool?: 'edit' | 'write';
  oldText?: string;
  newText?: string;
  time?: number;
  source?: 'relay' | 'replay';
  fileHashAtRecord?: string;
}

/** 变更同步消息（F1） */
export interface ChangesSyncMsg {
  kind: 'changesSync';
  sessionId: string;
  records: ChangeRecordMsg[];
}

/** 检查点回执消息（F9）：预览与应用共用一条 kind，用 phase 区分 */
export interface CheckpointsReadyMsg {
  kind: 'checkpointsReady';
  phase: 'preview' | 'apply';
  ok: boolean;
  /** 扩展侧请求 id（预览/应用可能并发在飞，回执靠它配对） */
  requestId?: string;
  sessionId?: string;
  error?: string;
  code?: string;
  turn?: number;
  totalChanges?: number;
  changes?: { path: string; kind: string }[];
  truncated?: boolean;
  restoreBlocked?: boolean;
  headChanged?: boolean;
  operationChanged?: boolean;
  planId?: string;
  confirmation?: string;
}

/** 检查点回执里最多透传的变更条数 */
export const CHECKPOINT_CHANGE_LIMIT: number;

/** 校验下行"检查点预览 / 恢复"（F9） */
export function parseCheckpointRestore(d: unknown): {
  kind: 'checkpointRestore';
  phase: 'preview' | 'apply';
  sessionId: string;
  messageSeq: number;
  checkpointId: string;
  mode: 'code' | 'both';
  requestId: string;
  planId?: string;
  confirmation?: string;
} | null;

/** 构造"会话状态"消息；缺 sessionId 返回 null */
export function buildSessionStateMessage(p: unknown): SessionStateMsg | null;

/** 构造"审批请求"消息；sessionId/approvalId/toolName 任一缺失返回 null */
export function buildApprovalRequestMessage(p: unknown): ApprovalRequestMsg | null;

/** 构造"提问请求"消息；缺 sessionId/questionId 返回 null */
export function buildQuestionRequestMessage(p: unknown): QuestionRequestMsg | null;

/** 构造"变更同步"消息；缺 sessionId 或 records 非数组返回 null */
export function buildChangesSyncMessage(p: unknown): ChangesSyncMsg | null;

/** 构造"检查点回执"消息；ok 非布尔返回 null */
export function buildCheckpointsReadyMessage(p: unknown): CheckpointsReadyMsg | null;

/** 上行统一入口：{ kind, payload } → 桥接消息；未知 kind / 形状非法返回 null */
export function buildBridgeUplinkMessage(detail: unknown):
  | SessionStateMsg
  | ApprovalRequestMsg
  | QuestionRequestMsg
  | ChangesSyncMsg
  | CheckpointsReadyMsg
  | null;

/** 校验下行"就地指令提交"（F11） */
export function parseQuickEditSubmit(d: unknown): {
  kind: 'quickEditSubmit';
  path: string;
  startLine: number;
  endLine: number;
  instruction: string;
} | null;

/** 校验下行"审批决策"（F6）；outcome 仅接受 allowed-once / rejected */
export function parseApprovalDecision(d: unknown): {
  kind: 'approvalDecision';
  sessionId: string;
  approvalId: string;
  outcome: 'allowed-once' | 'rejected';
} | null;

/** 校验下行"提问回答"（F8） */
export function parseQuestionAnswer(d: unknown): {
  kind: 'questionAnswer';
  sessionId: string;
  questionId: string;
  answer: unknown;
} | null;

/** 校验下行"请求重放变更"（F1） */
export function parseRequestChanges(d: unknown): { kind: 'requestChanges'; sessionId: string } | null;

/** 校验下行"注入 composer"（Add to DSH 既有通道） */
export function parseInjectComposer(d: unknown): { kind: 'injectComposer'; text: string } | null;

/**
 * 下行统一入口：按 kind 分发到对应校验器（client.js 的唯一下行分发点）。
 * 各 parse* 均先校验 kind，避免不同消息被宽松解析器互相误收。
 */
export function parseDownlinkMessage(d: unknown):
  | { kind: 'injectComposer'; text: string }
  | { kind: 'quickEditSubmit'; path: string; startLine: number; endLine: number; instruction: string }
  | { kind: 'approvalDecision'; sessionId: string; approvalId: string; outcome: 'allowed-once' | 'rejected' }
  | { kind: 'questionAnswer'; sessionId: string; questionId: string; answer: unknown }
  | { kind: 'requestChanges'; sessionId: string }
  | {
      kind: 'checkpointRestore';
      phase: 'preview' | 'apply';
      sessionId: string;
      messageSeq: number;
      checkpointId: string;
      mode: 'code' | 'both';
      requestId: string;
      planId?: string;
      confirmation?: string;
    }
  | null;
