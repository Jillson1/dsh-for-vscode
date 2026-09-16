// bridge-client/lib/core.js — 桥接纯逻辑（无 DOM、无 window，可在 node 环境单测）
// 说明：本文件是唯一实现与单测目标；生产环境在构建时（scripts/build.mjs）把它
// 内联进 client.js 工厂，保证"生产运行的逻辑 = 单测验证的逻辑"同一份源码。

// 外链协议白名单：只允许 http/https，杜绝 javascript:/file: 等危险协议
export function isAllowedExternalUrl(url) {
  // 非字符串或空串一律拒绝
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    // 用 URL 解析取协议；无效 URL 会抛错，落入 catch 返回 false
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// 构造"打开外链"消息（父页面 → 扩展 → 系统浏览器）
export function buildOpenExternalMessage(url) {
  return { kind: 'openExternal', url };
}

// 构造"打开文件"消息（cwd 为会话工作目录；oldText/newText 为工具卡片的改前/改后片段，均可选）
// newText 用于跳行兜底：改前片段落盘后已不在文件里，扩展在无修改记录时用改后片段定位。
export function buildOpenFileMessage(path, cwd, oldText, newText) {
  const msg = { kind: 'openFile', path };
  if (cwd !== undefined) msg.cwd = cwd;
  if (oldText !== undefined && typeof oldText === 'string' && oldText !== '') msg.oldText = oldText;
  if (newText !== undefined && typeof newText === 'string' && newText !== '') msg.newText = newText;
  return msg;
}

// 构造"工作区同步回执"消息（bridgeAck，path 可选；capabilities 为扩展侧能力表，可选）
// capabilities（0.4.0）：握手即交换能力表，扩展据此门控命令显隐，避免"只装一半"时的玄学降级。
// 传空数组/非数组时省略字段，保持消息形状向后兼容（旧扩展按 { kind, ok } 解析）。
export function buildSyncWorkspaceAck(ok, path, capabilities) {
  const msg = path === undefined ? { kind: 'bridgeAck', ok } : { kind: 'bridgeAck', ok, path };
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    const list = capabilities.filter((c) => typeof c === 'string' && c !== '');
    if (list.length > 0) msg.capabilities = list;
  }
  return msg;
}

// 构造"复制文本"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板）
export function buildCopyTextMessage(text, requestId) {
  return { kind: 'copyText', text, requestId };
}

// 构造"复制文本回执"消息（父页面 → iframe 页面，用于 resolve/reject writeText 的 Promise）
export function buildCopyTextAck(requestId, ok) {
  return { kind: 'copyTextAck', requestId, ok };
}

// 校验来自父页面的消息 token（握手防伪）：必须是对象且携带匹配的非空 token
export function isBridgeMessage(data, token) {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.token === 'string' &&
    data.token === token &&
    data.token !== ''
  );
}

// 握手 token 字段名（父页面发来的消息里携带）
export const HANDSHAKE_TOKEN_KEY = 'token';

/**
 * 从键盘事件判定"标准编辑快捷键"命令。
 *
 * 背景：VS Code 在 macOS 上会调用 setIgnoreMenuShortcuts(true) 并只在顶层 webview
 * 转发快捷键，导致嵌套 iframe（本桥接所在的 DSH 页面）里的 Cmd+C / Cmd+V / Cmd+A 等
 * 被吞掉（microsoft/vscode#129178 / #180234，官方至今未修复）。但 iframe 内的 JS 仍能
 * 收到 keydown 事件，因此这里把"按键 → 编辑命令"的判定抽成纯函数，
 * 由 client.js 捕获后自行模拟对应行为。
 *
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean }} e
 *   键盘事件的关键字段（兼容真实 KeyboardEvent 与测试桩，多余字段忽略）
 * @returns {null | 'copy' | 'paste' | 'cut' | 'selectAll' | 'undo' | 'redo'}
 *   命中的编辑命令；未命中返回 null（调用方应放行原事件）
 */
export function getShortcutCommand(e) {
  if (!e || typeof e !== 'object') return null;
  // 主修饰键：mac 用 meta（⌘），Windows/Linux 用 ctrl，两者都识别以兼容两种平台
  const hasMod = e.ctrlKey === true || e.metaKey === true;
  // Windows 上 Shift+Insert 是经典的粘贴组合，一并支持
  if (!hasMod) {
    return e.shiftKey === true && e.key === 'Insert' ? 'paste' : null;
  }
  // 键名统一小写以兼容 'c' 与 'C'（Shift+字母时 key 为大写）
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  switch (k) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'x':
      return 'cut';
    case 'a':
      return 'selectAll';
    case 'z':
      // Cmd+Shift+Z 是重做（mac 惯例；Windows 上 Ctrl+Y 也能重做，暂不额外处理）
      return e.shiftKey === true ? 'redo' : 'undo';
    default:
      return null;
  }
}

/**
 * 判定一个元素是否为"可编辑元素"（可接收粘贴/剪切/打字的目标）。
 *
 * @param {object|null} el DOM 元素
 * @returns {boolean} true 表示 textarea / 可输入 input / contenteditable
 */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    // 真实 DOM 的 input.type 属性默认为 'text'，但为兼容测试桩与旧浏览器，
    // 空字符串 type 一律按 text 处理
    const type = typeof el.type === 'string' && el.type !== '' ? el.type.toLowerCase() : 'text';
    // 仅把能接收键盘文本输入的 type 视为可编辑（checkbox/button/range 等排除）
    return ['text', 'search', 'url', 'tel', 'password', 'number', 'email'].includes(type);
  }
  return el.isContentEditable === true;
}

/**
 * 计算在字符串的 [start, end) 区间插入 text 后的新值（纯函数，供可编辑元素兜底写入）。
 *
 * @param {string|undefined|null} value 原值（textarea.value 等）
 * @param {number} start 选区起点（selectionStart）
 * @param {number} end 选区终点（selectionEnd）
 * @param {string} text 待插入文本
 * @returns {string} 插入后的完整新值
 */
export function computeInsertedValue(value, start, end, text) {
  const v = typeof value === 'string' ? value : String(value ?? '');
  // 越界/负值/顺序异常都归一到合法区间，避免 slice 结果错乱
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : v.length, v.length));
  const e = Math.max(s, Math.min(Number.isFinite(end) ? end : v.length, v.length));
  return v.slice(0, s) + text + v.slice(e);
}

// 构造"读取剪贴板"消息（iframe 页面 → 父页面 → 扩展 → 系统剪贴板读取，供粘贴兜底）
export function buildReadTextMessage(requestId) {
  return { kind: 'readText', requestId };
}

// 构造"读取剪贴板回执"消息（父页面 → iframe 页面，resolve/reject readText 的 Promise）
// ok=true 且 text 非空才视为成功；空文本/失败一律回执 ok=false（无可粘贴内容）
export function buildReadTextAck(requestId, ok, text) {
  return ok === true && typeof text === 'string' && text !== ''
    ? { kind: 'readTextAck', requestId, ok: true, text }
    : { kind: 'readTextAck', requestId, ok: false };
}

// 构造"diff 已应用"转发消息（iframe 内插件 → 父页面 → 扩展）
// A 组：dsh-file-jump 插件在 edit/write 落盘后广播 applied diff，桥接转发给扩展宿主，
// 由扩展在编辑区高亮修改行并记入撤销栈。payload 来自插件 CustomEvent 的 detail。
export function buildDiffAppliedMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.path !== 'string' || payload.path === '') return null;
  const diffs = Array.isArray(payload.diffs)
    ? payload.diffs
        .filter((d) => d && typeof d.oldText === 'string' && typeof d.newText === 'string' && d.newText !== '')
        .map((d) => ({ oldText: d.oldText, newText: d.newText }))
    : [];
  if (diffs.length === 0) return null;
  const msg = { kind: 'diffApplied', path: payload.path, diffs, callId: String(payload.callId ?? '') };
  if (typeof payload.cwd === 'string' && payload.cwd !== '') msg.cwd = payload.cwd;
  // 来源工具名（edit/write）：扩展据此判定丢弃语义（write 新建 → 删除文件）。
  // 缺了它 write 新建会退化成"文本还原"，hover 也不会出现「丢弃文件」。
  if (typeof payload.tool === 'string' && payload.tool !== '') msg.tool = payload.tool;
  // source（F1 变更账本）：'relay' = 渲染时实时广播；'replay' = 历史回放（Reload / 重开会话）。
  // 枚举白名单：未知值一律省略，扩展侧按缺省 'relay' 处理。
  if (payload.source === 'relay' || payload.source === 'replay') msg.source = payload.source;
  // sessionId（F1）：扩展按会话归档变更记录（脏数据不落库：非空字符串才透传）。
  if (typeof payload.sessionId === 'string' && payload.sessionId !== '') msg.sessionId = payload.sessionId;
  // turn（F1）：变更所属轮次（回放时可从节点推导；缺失则扩展记 0）。
  if (Number.isFinite(payload.turn)) msg.turn = payload.turn;
  return msg;
}

// ============================================================================
// 交互增强地基（bridge 0.4.0）：能力表 + 新消息构造/校验
//
// 消息方向（与《交互增强开发方案》§4.1 一致）：
//   上行（页面 → 扩展）：sessionState / approvalRequest / questionRequest / changesSync / checkpointsReady
//   下行（扩展 → 页面）：quickEditSubmit / approvalDecision / questionAnswer / requestChanges
//
// 上行投递方式：插件（独立 bundle，dsh-file-jump）用
//   window.dispatchEvent(new CustomEvent(UPLINK_EVENT, { detail: { kind, payload } }))
// 把新消息交给桥接；桥接用 buildBridgeUplinkMessage 按白名单校验/归一后转发父页面。
// 下行投递方式：父页面（扩展）postMessage 到 iframe，桥接用 parse* 校验后加
// `dsh-file-jump:` 命名空间前缀转给插件（与既有 injectComposer 同款解耦方式）。
//
// 设计原则：所有归一/校验都在这层纯函数里完成（可单测）；client.js 只负责事件绑定与转发。
// 未知 kind 或形状非法的消息一律返回 null → 静默丢弃（桥接与插件/扩展版本混装时的兜底）。
// ============================================================================

/** 桥接具备的能力表（握手 bridgeAck 下发，扩展据此门控命令显隐） */
export const BRIDGE_CAPABILITIES = [
  'openFile', // 卡片路径点击 → 打开文件（含精确跳行）
  'diffApplied', // 变更高亮 / 丢弃 / 保留
  'injectComposer', // Add to DSH：文件引用注入 composer
  'quickEdit', // F11 就地指令提交
  'approval', // F6 审批闸门
  'question', // F8 提问 / plan-review
  'changes', // F1/F3 变更账本与树
  'checkpoint', // F9 检查点
  'sessionState', // F7 会话状态（运行中/待决数）
];

/** 上行消息投递事件名（插件 dispatch、桥接监听；两侧必须一致） */
export const UPLINK_EVENT = 'dsh-file-jump:bridgeUp';

/** 非空字符串判定（内部工具，不导出） */
function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

/** 有限数字兜底（内部工具：非法/缺失时取 fallback） */
function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 构造"会话状态"消息（F7 状态栏/通知的数据源）。
 * @param {object} p 快照派生的状态 { sessionId, running, turn, pending }
 * @returns {null | { kind:'sessionState', sessionId:string, running:boolean, turn:number, pending:number }}
 *   缺 sessionId 时返回 null；running 严格布尔化，turn/pending 缺省为 0。
 */
export function buildSessionStateMessage(p) {
  if (!p || typeof p !== 'object' || !isNonEmptyString(p.sessionId)) return null;
  return {
    kind: 'sessionState',
    sessionId: p.sessionId,
    running: p.running === true,
    turn: finiteOr(p.turn, 0),
    pending: finiteOr(p.pending, 0),
  };
}

/**
 * 构造"审批请求"消息（F6：DSH 请求许可 → VS Code 模态框）。
 * 字段形状与 host 侧 `session/pending` 帧一致（sessionId / approvalId / toolName / callId? / reason?）。
 * @returns {null | object} sessionId / approvalId / toolName 任一缺失即返回 null。
 */
export function buildApprovalRequestMessage(p) {
  if (!p || typeof p !== 'object') return null;
  if (!isNonEmptyString(p.sessionId) || !isNonEmptyString(p.approvalId) || !isNonEmptyString(p.toolName)) {
    return null;
  }
  const msg = { kind: 'approvalRequest', sessionId: p.sessionId, approvalId: p.approvalId, toolName: p.toolName };
  if (isNonEmptyString(p.callId)) msg.callId = p.callId;
  if (isNonEmptyString(p.reason)) msg.reason = p.reason;
  return msg;
}

/**
 * 构造"提问请求"消息（F8：question / plan-review）。
 * questions 为 AskUserQuestionItem 列表：逐项只保留对象项，非数组按空数组处理
 * （提问本身仍可呈现，只是没有可选项——比整条丢弃更安全）。
 */
export function buildQuestionRequestMessage(p) {
  if (!p || typeof p !== 'object') return null;
  if (!isNonEmptyString(p.sessionId) || !isNonEmptyString(p.questionId)) return null;
  const questions = Array.isArray(p.questions)
    ? p.questions.filter((q) => q !== null && typeof q === 'object')
    : [];
  return { kind: 'questionRequest', sessionId: p.sessionId, questionId: p.questionId, questions };
}

/**
 * 归一单条变更记录（F1 ChangeRecord 的桥接子集）。
 * 只白名单拷贝已知字段，避免把插件侧的任意对象灌进扩展（体积与安全双重考虑）。
 * 必填：callId 非空；path 或 absPath 至少之一非空。
 */
function normalizeChangeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (!isNonEmptyString(r.callId)) return null;
  if (!isNonEmptyString(r.path) && !isNonEmptyString(r.absPath)) return null;
  const rec = {
    callId: r.callId,
    path: isNonEmptyString(r.path) ? r.path : r.absPath,
    absPath: isNonEmptyString(r.absPath) ? r.absPath : r.path,
  };
  if (isNonEmptyString(r.sessionId)) rec.sessionId = r.sessionId;
  if (Number.isFinite(r.turn)) rec.turn = r.turn;
  if (r.tool === 'edit' || r.tool === 'write') rec.tool = r.tool;
  if (typeof r.oldText === 'string') rec.oldText = r.oldText;
  if (typeof r.newText === 'string') rec.newText = r.newText;
  if (Number.isFinite(r.time)) rec.time = r.time;
  if (r.source === 'relay' || r.source === 'replay') rec.source = r.source;
  if (isNonEmptyString(r.fileHashAtRecord)) rec.fileHashAtRecord = r.fileHashAtRecord;
  return rec;
}

/**
 * 构造"变更同步"消息（F1：回放/relay 批量推送给扩展账本）。
 * 空 records 是合法语义（"该会话当前没有变更"），因此不在这里丢弃；
 * 全部记录都不合法时退化为空数组，由扩展侧按"无变更"处理。
 */
export function buildChangesSyncMessage(p) {
  if (!p || typeof p !== 'object' || !isNonEmptyString(p.sessionId)) return null;
  if (!Array.isArray(p.records)) return null;
  const records = p.records.map(normalizeChangeRecord).filter((r) => r !== null);
  return { kind: 'changesSync', sessionId: p.sessionId, records };
}

/**
 * 构造"检查点就绪/恢复回执"消息（F9：恢复完成后回执给扩展）。
 * ok 必须是布尔（缺了就无法判定成败）→ 返回 null。
 */
export function buildCheckpointsReadyMessage(p) {
  if (!p || typeof p !== 'object' || typeof p.ok !== 'boolean') return null;
  const msg = { kind: 'checkpointsReady', ok: p.ok };
  if (isNonEmptyString(p.sessionId)) msg.sessionId = p.sessionId;
  if (isNonEmptyString(p.error)) msg.error = p.error;
  return msg;
}

/**
 * 上行统一入口：把插件投递的 { kind, payload } 按白名单构造成桥接消息。
 * client.js 的唯一上行分发点——新增消息只需在这里加一个 case。
 * @returns {null | object} 未知 kind 或形状非法 → null（调用方静默丢弃）
 */
export function buildBridgeUplinkMessage(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const payload = detail.payload;
  switch (detail.kind) {
    case 'sessionState':
      return buildSessionStateMessage(payload);
    case 'approvalRequest':
      return buildApprovalRequestMessage(payload);
    case 'questionRequest':
      return buildQuestionRequestMessage(payload);
    case 'changesSync':
      return buildChangesSyncMessage(payload);
    case 'checkpointsReady':
      return buildCheckpointsReadyMessage(payload);
    default:
      return null; // 未知 kind：静默丢弃（版本混装兜底）
  }
}

/**
 * 校验下行"就地指令提交"（F11 Quick Edit）。
 * 首行先校验 kind：下行是"逐条尝试"的分发，若不校验 kind，只带 sessionId 的其它消息
 * 会被宽松解析器误收（实测踩坑：非法 outcome 的 approvalDecision 曾落进 requestChanges 被转发）。
 * path 非空、startLine/endLine 为有限数字、instruction 为字符串（可为空串：空指令由扩展侧拦）。
 */
export function parseQuickEditSubmit(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'quickEditSubmit') return null;
  if (!isNonEmptyString(d.path)) return null;
  if (!Number.isFinite(d.startLine) || !Number.isFinite(d.endLine)) return null;
  if (typeof d.instruction !== 'string') return null;
  return {
    kind: 'quickEditSubmit',
    path: d.path,
    startLine: d.startLine,
    endLine: d.endLine,
    instruction: d.instruction,
  };
}

/** 校验下行"审批决策"（F6）：outcome 只接受 'allowed-once' | 'rejected'（载荷不支持"总是允许"） */
export function parseApprovalDecision(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'approvalDecision') return null;
  if (!isNonEmptyString(d.sessionId) || !isNonEmptyString(d.approvalId)) return null;
  if (d.outcome !== 'allowed-once' && d.outcome !== 'rejected') return null;
  return { kind: 'approvalDecision', sessionId: d.sessionId, approvalId: d.approvalId, outcome: d.outcome };
}

/** 校验下行"提问回答"（F8）：一次问答整批回填，answer 必须是对象/数组（null/undefined 视为未答） */
export function parseQuestionAnswer(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'questionAnswer') return null;
  if (!isNonEmptyString(d.sessionId) || !isNonEmptyString(d.questionId)) return null;
  if (d.answer === null || d.answer === undefined) return null;
  return { kind: 'questionAnswer', sessionId: d.sessionId, questionId: d.questionId, answer: d.answer };
}

/** 校验下行"请求重放变更"（扩展加载后主动要一次回放，F1） */
export function parseRequestChanges(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'requestChanges') return null;
  if (!isNonEmptyString(d.sessionId)) return null;
  return { kind: 'requestChanges', sessionId: d.sessionId };
}

/** 校验下行"注入 composer"（Add to DSH 既有通道，纳入统一下行分发） */
export function parseInjectComposer(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'injectComposer') return null;
  if (typeof d.text !== 'string') return null;
  return { kind: 'injectComposer', text: d.text };
}

/**
 * 下行统一入口：按 kind 分发到对应校验器（client.js 的唯一下行分发点）。
 * 未知 kind 返回 null → 静默丢弃（版本混装兜底）。新增下行消息只需在这里加一个 case，
 * 不必在 client.js 里维护"逐条尝试"的分支链——那正是误收的温床。
 * @returns {null | object} 已校验并归一的 { kind, ...payload }
 */
export function parseDownlinkMessage(d) {
  if (!d || typeof d !== 'object') return null;
  switch (d.kind) {
    case 'injectComposer':
      return parseInjectComposer(d);
    case 'quickEditSubmit':
      return parseQuickEditSubmit(d);
    case 'approvalDecision':
      return parseApprovalDecision(d);
    case 'questionAnswer':
      return parseQuestionAnswer(d);
    case 'requestChanges':
      return parseRequestChanges(d);
    default:
      return null; // 未知 kind：静默丢弃
  }
}
