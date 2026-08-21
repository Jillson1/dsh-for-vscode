// test/vscode-stub.ts — 测试专用的 vscode 运行时桩
// 测试环境（node --test）没有 VS Code 宿主，config.ts 顶层 `import * as vscode`
// 需要在本模块作用域内解析。这里只提供一个最小可用对象，
// 因为单测只覆盖 normalizeConfig / isLoopbackHost 等纯函数，
// 不会真正调用 readConfig 里的 vscode.workspace.getConfiguration。
export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
  }),
};

/** 最小 window 桩：Add to DSH 命令会用 showWarning/InformationMessage 提示用户 */
export const window = {
  showWarningMessage: () => undefined,
  showInformationMessage: () => undefined,
};

export default { workspace, window };
