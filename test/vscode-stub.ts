// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
// 测试环境（node --test）没有 VS Code 宿主，而 src 下的模块顶层 `import * as vscode`，
// 因此构建脚本把 `vscode` 别名到本文件（见 scripts/build.mjs 的 alias）。
// 这里只提供最小可用对象：调用到的 API 必须有，不需要真实行为。
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
  /** config.ts 读取多根工作区用；测试里恒为空（等价"未打开文件夹"） */
  workspaceFolders: undefined as unknown,
};

/** 最小 window 桩：各类提示与面板交互 */
export const window = {
  showWarningMessage: () => undefined,
  showInformationMessage: () => undefined,
  showErrorMessage: () => undefined,
  registerWebviewViewProvider: () => ({ dispose: () => undefined }),
  onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
  createTextEditorDecorationType: () => ({ dispose: () => undefined }),
  createStatusBarItem: () => ({
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: () => ({ dispose: () => undefined }),
};

/** 环境信息（面板/远程分支会读 remoteName；测试等价"本地窗口"） */
export const env = {
  language: 'zh-cn',
  remoteName: undefined as string | undefined,
  openExternal: () => Promise.resolve(true),
  clipboard: {
    writeText: () => Promise.resolve(),
    readText: () => Promise.resolve(''),
  },
};

/** 命令注册（扩展激活时会 registerCommand；测试里只需可调用） */
export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: () => Promise.resolve(undefined),
};

/** Uri 桩：openExternal/openFile 会构造 Uri */
export const Uri = {
  parse: (s: string) => ({ toString: () => s, fsPath: s }),
  file: (s: string) => ({ toString: () => s, fsPath: s }),
  joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/'), fsPath: parts.join('/') }),
};

export const ViewColumn = { One: 1, Two: 2, Beside: -2 };

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const EventEmitter = class {
  private listeners = new Set<(e: unknown) => void>();
  event = (cb: (e: unknown) => void) => {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  };
  fire(e?: unknown): void {
    for (const cb of [...this.listeners]) cb(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
};

export const ThemeColor = class {
  constructor(public readonly id: string) {}
};

export const ThemeIcon = class {
  constructor(public readonly id: string) {}
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const ConfigurationTarget = { Global: 1, Workspace: 2 };

export const RelativePattern = class {
  constructor(public readonly base: unknown, public readonly pattern: string) {}
};

export const l10n = { t: (s: string) => s };

export default {
  workspace,
  window,
  env,
  commands,
  Uri,
  ViewColumn,
  TreeItemCollapsibleState,
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  StatusBarAlignment,
  ConfigurationTarget,
  RelativePattern,
  l10n,
};
