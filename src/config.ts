// src/config.ts — dsh.* 设置项读取与规范化
// 纯函数（normalizeConfig / isLoopbackHost）不依赖 vscode，可直接单测；
// readConfig 是 vscode 设置的薄封装，供 extension.ts 使用。
import * as vscode from 'vscode';

/** 用户可配置的原始值（可能缺失/非法） */
export interface RawDshConfig {
  host?: string;
  port?: number;
  autoStart?: boolean;
  stopOnExit?: boolean;
  extraArgs?: string[];
  /** 是否启用桥接（dsh.bridge.enabled） */
  bridgeEnabled?: boolean;
  /** 多根工作区取第几个根目录（dsh.workspaceRootIndex） */
  workspaceRootIndex?: number;
  /** 是否抑制桥接警告（dsh.bridge.silenceWarning） */
  silenceWarning?: boolean;
  /** dsh 可执行文件绝对路径（空串 = 用 PATH 里的 dsh） */
  executablePath?: string;
  /** 轮次完成时是否弹通知（dsh.notify.onTurnComplete） */
  notifyOnTurnComplete?: boolean;
  /** 选区变化时是否挂 Comments 内联线程（dsh.selection.threads.enabled） */
  selectionThreadsEnabled?: boolean;
  /** Quick Edit 发送前是否先确认（dsh.quickEdit.confirmBeforeSend） */
  quickEditConfirmBeforeSend?: boolean;
  /** 面板可见时是否把审批/提问交给面板（dsh.interaction.onlyWhenPanelHidden） */
  interactionOnlyWhenPanelHidden?: boolean;
}

/** 规范化后的配置（均有合法默认值） */
export interface DshConfig {
  host: string;
  port: number;
  autoStart: boolean;
  stopOnExit: boolean;
  extraArgs: string[];
  /** 是否启用桥接（dsh.bridge.enabled） */
  bridgeEnabled: boolean;
  /** 多根工作区取第几个根目录（dsh.workspaceRootIndex） */
  workspaceRootIndex: number;
  /** 是否抑制桥接警告（dsh.bridge.silenceWarning） */
  silenceWarning: boolean;
  /** dsh 可执行文件绝对路径（空串 = 用 PATH 里的 dsh） */
  executablePath: string;
  /** 轮次完成时是否弹通知 */
  notifyOnTurnComplete: boolean;
  /** 选区变化时是否挂 Comments 内联线程 */
  selectionThreadsEnabled: boolean;
  /** Quick Edit 发送前是否先确认 */
  quickEditConfirmBeforeSend: boolean;
  /** 面板可见时是否把审批/提问交给面板（策略 B，默认开） */
  interactionOnlyWhenPanelHidden: boolean;
}

/** 默认配置 */
export const DEFAULTS: DshConfig = {
  host: '127.0.0.1',
  port: 3080,
  autoStart: true,
  stopOnExit: true,
  extraArgs: [],
  bridgeEnabled: true,
  workspaceRootIndex: 0,
  silenceWarning: false,
  executablePath: '',
  notifyOnTurnComplete: true,
  // F10/F11 默认值：线程默认开（可在设置里关掉，避免"选一点就冒东西"）；发送前确认默认开
  selectionThreadsEnabled: true,
  quickEditConfirmBeforeSend: true,
  // 策略 B：面板可见时审批/提问交回面板处理（避免同一问题问两遍、模态框抢焦点）
  interactionOnlyWhenPanelHidden: true,
};

/** 安全边界：仅允许回环地址 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 判断是否为回环地址 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 规范化原始配置：非法值回退默认并记录错误描述
 * （安全规则：host 只允许回环地址，端口必须为 0..65535 的整数）
 */
export function normalizeConfig(raw: RawDshConfig): { config: DshConfig; errors: string[] } {
  const errors: string[] = [];

  // 缺失与非法需区分：字段未配置时静默回退默认（不算错误），
  // 只有提供了非法值才记录错误并回退默认。
  let host: string;
  if (typeof raw.host !== 'string') {
    host = DEFAULTS.host;
  } else {
    host = raw.host.trim();
    if (!isLoopbackHost(host)) {
      errors.push(`dsh.host must be a loopback address, got ${JSON.stringify(raw.host)}`);
      host = DEFAULTS.host;
    }
  }

  let port = raw.port;
  if (port === undefined) {
    port = DEFAULTS.port;
  } else if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`dsh.port must be an integer in 0..65535, got ${JSON.stringify(raw.port)}`);
    port = DEFAULTS.port;
  }

  const autoStart = typeof raw.autoStart === 'boolean' ? raw.autoStart : DEFAULTS.autoStart;
  const stopOnExit = typeof raw.stopOnExit === 'boolean' ? raw.stopOnExit : DEFAULTS.stopOnExit;
  const extraArgs = Array.isArray(raw.extraArgs)
    ? raw.extraArgs.filter((a): a is string => typeof a === 'string')
    : DEFAULTS.extraArgs;

  // 布尔设置沿用 autoStart 的缺省处理模式：仅接受布尔值，否则回退默认（不记错误）
  const bridgeEnabled = typeof raw.bridgeEnabled === 'boolean' ? raw.bridgeEnabled : DEFAULTS.bridgeEnabled;
  const silenceWarning = typeof raw.silenceWarning === 'boolean' ? raw.silenceWarning : DEFAULTS.silenceWarning;

  // workspaceRootIndex：必须为非负整数，非法值回退默认并记录错误
  let workspaceRootIndex: number;
  if (raw.workspaceRootIndex === undefined) {
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else if (
    typeof raw.workspaceRootIndex !== 'number' ||
    !Number.isInteger(raw.workspaceRootIndex) ||
    raw.workspaceRootIndex < 0
  ) {
    errors.push(`dsh.workspaceRootIndex must be a non-negative integer, got ${JSON.stringify(raw.workspaceRootIndex)}`);
    workspaceRootIndex = DEFAULTS.workspaceRootIndex;
  } else {
    workspaceRootIndex = raw.workspaceRootIndex;
  }

  // executablePath：非字符串静默回退默认 ''；空字符串合法（表示用 PATH 里的 dsh）
  const executablePath = typeof raw.executablePath === 'string' ? raw.executablePath : DEFAULTS.executablePath;

  // F7 通知设置：仅接受布尔值，否则回退默认（默认开通知、关声音——过度弹窗是明确反对项）
  const notifyOnTurnComplete =
    typeof raw.notifyOnTurnComplete === 'boolean' ? raw.notifyOnTurnComplete : DEFAULTS.notifyOnTurnComplete;
  const selectionThreadsEnabled =
    typeof raw.selectionThreadsEnabled === 'boolean' ? raw.selectionThreadsEnabled : DEFAULTS.selectionThreadsEnabled;
  const quickEditConfirmBeforeSend =
    typeof raw.quickEditConfirmBeforeSend === 'boolean'
      ? raw.quickEditConfirmBeforeSend
      : DEFAULTS.quickEditConfirmBeforeSend;
  const interactionOnlyWhenPanelHidden =
    typeof raw.interactionOnlyWhenPanelHidden === 'boolean'
      ? raw.interactionOnlyWhenPanelHidden
      : DEFAULTS.interactionOnlyWhenPanelHidden;

  return {
    config: {
      host, port, autoStart, stopOnExit, extraArgs, bridgeEnabled, workspaceRootIndex,
      silenceWarning, executablePath, notifyOnTurnComplete, selectionThreadsEnabled, quickEditConfirmBeforeSend,
      interactionOnlyWhenPanelHidden,
    },
    errors,
  };
}

/** 从 VS Code 设置读取（薄封装，供 extension.ts 使用） */
export function readConfig(): { config: DshConfig; errors: string[] } {
  const ws = vscode.workspace.getConfiguration('dsh');
  return normalizeConfig({
    host: ws.get<string>('host'),
    port: ws.get<number>('port'),
    autoStart: ws.get<boolean>('autoStart'),
    stopOnExit: ws.get<boolean>('stopOnExit'),
    extraArgs: ws.get<string[]>('extraArgs'),
    bridgeEnabled: ws.get<boolean>('bridge.enabled'),
    workspaceRootIndex: ws.get<number>('workspaceRootIndex'),
    silenceWarning: ws.get<boolean>('bridge.silenceWarning'),
    executablePath: ws.get<string>('executablePath'),
    notifyOnTurnComplete: ws.get<boolean>('notify.onTurnComplete'),
    selectionThreadsEnabled: ws.get<boolean>('selection.threads.enabled'),
    quickEditConfirmBeforeSend: ws.get<boolean>('quickEdit.confirmBeforeSend'),
    interactionOnlyWhenPanelHidden: ws.get<boolean>('interaction.onlyWhenPanelHidden'),
  });
}
