// src/panel/provider.ts — 侧边栏面板：iframe 与占位页切换
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ServiceManager } from '../service/manager';
import { handleBridgeMessage, type BridgeUplinkEvent } from '../bridge/host';
import { DiffService } from '../bridge/diff-service';
import { revealLineInEditor } from '../editorReveal';
import { t } from '../i18n';
import {
  loadingPage,
  errorPage,
  disconnectedPage,
  stoppedPage,
  readyPage,
  type PanelDownlink,
  type PanelMessage,
  type PageCtx,
} from './html';

export class DshPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  /** 曾处于 ready：用于区分"服务断开"与"手动停止"两种占位页 */
  private wasConnected = false;
  /** 面板是否已首次打开过（用于一次性回调） */
  private openedOnce = false;
  /** 桥接握手 token：一次性防伪凭据，用密码学随机数（不可预测） */
  private readonly bridgeToken = randomUUID();

  /**
   * @param manager 服务管理器（面板与服务状态联动）
   * @param onFirstOpen 面板首次打开时调用一次的回调（用于引导提示，由入口注入）
   * @param onBridgeAck 桥接握手回执回调（Task 7 评估桥接状态时注入；可选）
   * @param workspaceRoot 工作区根目录注入函数（openFile 相对路径解析的兜底基准；可选，默认无根）
   * @param bridgeEnabled 桥接是否启用的 getter（Task 7 由 dsh.bridge.enabled 配置驱动；默认启用，
   *   disabled 时不注入握手脚本，避免向未安装桥接的 DSH 页面发送无意义的握手）
   */
  constructor(
    private manager: ServiceManager,
    private onFirstOpen?: () => void,
    private onBridgeAck?: (ok: boolean, capabilities?: string[]) => void,
    private workspaceRoot: () => string | undefined = () => undefined,
    private bridgeEnabled: () => boolean = () => true,
    /** A 组修改服务（高亮/撤销/diff 视图；两个面板共享同一单例） */
    private diffService?: DiffService,
    /**
     * 交互增强（bridge 0.4.0）上行消息落点：T0 由入口注入日志实现（打桩），
     * 后续阶段（F1/F6/F7/F8/F9）改注入真实服务或在此分发。
     */
    private logBridgeEvent?: (event: BridgeUplinkEvent) => void,
  ) {
    // 订阅状态变化，重绘面板（iframe 与占位页由状态驱动，无白屏路径）
    manager.onChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // enableScripts 允许占位页的内联按钮脚本（nonce 放行）运行。
    // 注意：retainContextWhenHidden 不在这里设置——它不是 WebviewOptions 字段，
    // 由 Task 10 注册视图时通过第三参数传入（隐藏面板时保留 iframe 会话）。
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    if (!this.openedOnce) {
      this.openedOnce = true;
      this.onFirstOpen?.(); // 首次打开：触发一次性引导（如"移到右侧栏"提示）
    }
    this.render();
    // 面板打开即确保服务运行：复用已有或自动启动。
    void this.manager.ensureRunning();
  }

  /**
   * 把文件引用文本注入 DSH 页面 composer（下行，供 "Add to DSH" 命令使用）。
   * 仅当面板可见且 webview 就绪时投递；返回 false 表示当前不可注入
   * （面板未打开/隐藏），调用方据此提示用户。
   */
  /** 面板当前是否可见（F6/F8 的投递决策要读它：可见时交回面板，避免 IDE 重复弹窗） */
  isVisible(): boolean {
    return this.view !== null && this.view.visible === true;
  }

  injectComposer(text: string): boolean {
    return this.postToPage({ type: 'bridgeInjectComposer', text });
  }

  /**
   * 向 DSH 页面投递下行消息（bridge 0.4.0 通用入口）。
   * 顶层握手脚本按 type 翻译成桥接 kind 转给 iframe，桥接校验后加 `dsh-file-jump:` 前缀交给插件。
   * 仅当面板可见且 webview 就绪时投递；返回 false 表示当前不可投递，调用方据此提示用户。
   */
  postToPage(msg: PanelDownlink): boolean {
    if (!this.view || this.view.visible !== true) return false;
    void this.view.webview.postMessage(msg);
    return true;
  }

  /** 处理面板内按钮消息（全部转交给 manager 或对应命令） */
  private onMessage(msg: PanelMessage): void {
    switch (msg.type) {
      case 'retry':
      case 'reconnect':
        void this.manager.ensureRunning();
        break;
      case 'restart':
        void this.manager.restart();
        break;
      case 'stop':
        this.wasConnected = false;
        void this.manager.stop();
        break;
      case 'openExternal':
        void vscode.commands.executeCommand('dsh.openExternal');
        break;
      case 'copyUrl':
        void vscode.commands.executeCommand('dsh.copyUrl');
        break;
      case 'showLogs':
        void vscode.commands.executeCommand('dsh.showLogs');
        break;
      case 'bridgeCopyText':
        // 桥接剪贴板消息：VS Code 会拦截跨源 iframe 的原生 clipboard API，
        // 这里由扩展宿主写系统剪贴板，并回执给 iframe 收尾其 writeText Promise。
        void this.copyTextToClipboard(msg);
        break;
      case 'bridgeReadText':
        // 剪贴板读取：扩展宿主读系统剪贴板（无 webview 权限限制），
        // 回执给 iframe 供其 Cmd+V 粘贴兜底使用。
        void this.readTextFromClipboard(msg);
        break;
      case 'bridgeOpenExternal':
      case 'bridgeOpenFile':
      case 'bridgeSessionState':
      case 'bridgeApprovalRequest':
      case 'bridgeQuestionRequest':
      case 'bridgeChangesSync':
      case 'bridgeCheckpointsReady':
        // 桥接消息统一走 host 的 handleBridgeMessage（内部分流：外链/文件跳转落地为 VS Code
        // 动作；交互增强上行消息 T0 落到 logBridgeEvent 打桩）。
        void handleBridgeMessage(msg, this.bridgeDeps());
        break;
      case 'bridgeDiffApplied':
        // A 组：DSH 插件广播的 applied diff → 修改服务记录（高亮 + 撤销栈）
        void this.diffService?.record(msg);
        break;
      case 'bridgeAck':
        // 握手回执：通知注入的回调（Task 7 据此评估桥接状态；0.4.0 起附带能力表）
        this.onBridgeAck?.(msg.ok, msg.capabilities);
        break;
    }
  }

  /**
   * 桥接消息处理依赖（生产实现）。
   * 抽成方法的原因：外链/文件跳转与交互增强上行消息共用同一套 deps，
   * 内联两份会让后续阶段加消息时出现"两处必须同步改"的隐性耦合。
   */
  private bridgeDeps(): Parameters<typeof handleBridgeMessage>[1] {
    return {
      openExternal: (u) => vscode.env.openExternal(vscode.Uri.parse(u)),
      // showTextDocument 返回 TextEditor，而依赖约定返回 Thenable<void>：用 async 包装丢弃返回值
      openTextDocument: async (p) => {
        await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: false });
      },
      // edit 场景定位 oldText：扩展宿主读文件（有完整 Node 权限），indexOf 算起始行
      readFileText: async (p) => {
        const { promises: fs } = await import('node:fs');
        return fs.readFile(p, 'utf8');
      },
      // edit 场景精确跳行：打开后定位到 1-based 修改起始行并高亮居中。
      // 实现收敛在 editorReveal.ts（F2 导航与 F3 树共用同一份，避免三处细节漂移）。
      revealLine: async (p, line) => {
        await revealLineInEditor(p, line);
      },
      // A 组：applied diff → 修改服务记录（高亮 + 撤销栈）
      recordDiff: async (d) => {
        await this.diffService?.record(d);
      },
      // edit 卡片点击的精确跳行：走修改记录（oldText → newText 定位），
      // 比直接 indexOf 改前片段可靠（改前片段落盘后已不在文件里）
      resolveEditLine: async (p, oldText) => this.diffService?.lineForOldText(p, oldText),
      // 用户提示统一走 vscode.window.showWarningMessage（host 层不 import vscode，保持纯逻辑可单测）
      showWarning: (m) => void vscode.window.showWarningMessage(m),
      // 交互增强上行消息落点（T0：入口注入日志实现）
      logBridgeEvent: (e) => this.logBridgeEvent?.(e),
      workspaceRoot: this.workspaceRoot(), // 工作区根目录：openFile 相对路径解析的兜底基准
    };
  }

  /** 剪贴板桥接：扩展宿主写系统剪贴板，完成后回执给 webview（由顶层脚本转发给 iframe） */
  private async copyTextToClipboard(msg: Extract<PanelMessage, { type: 'bridgeCopyText' }>): Promise<void> {
    let ok = false;
    try {
      await vscode.env.clipboard.writeText(msg.text);
      ok = true;
    } catch {
      // 写剪贴板失败：回执 ok=false，iframe 侧会 reject writeText，
      // DSH 会继续走自己的 execCommand('copy') 回退路径。
    }
    try {
      await this.view?.webview.postMessage({ type: 'bridgeCopyTextAck', requestId: msg.requestId, ok });
    } catch {
      // 面板可能已隐藏/销毁，回执发不出去也不影响扩展其它功能。
    }
  }

  /** 剪贴板桥接：扩展宿主读系统剪贴板，完成后回执给 webview（由顶层脚本转发给 iframe） */
  private async readTextFromClipboard(msg: Extract<PanelMessage, { type: 'bridgeReadText' }>): Promise<void> {
    let ok = false;
    let text: string | undefined;
    try {
      // 读取失败或内容为空时都回执 ok=false，iframe 侧放弃本次粘贴
      text = await vscode.env.clipboard.readText();
      ok = typeof text === 'string' && text !== '';
    } catch {
      // 读剪贴板失败（如系统无剪贴板权限）：回执 ok=false，iframe 侧静默放弃
    }
    try {
      await this.view?.webview.postMessage({
        type: 'bridgeReadTextAck',
        requestId: msg.requestId,
        ok,
        text,
      });
    } catch {
      // 面板可能已隐藏/销毁，回执发不出去也不影响扩展其它功能。
    }
  }

  /** 按服务状态渲染对应页面 */
  private render(): void {
    const v = this.view;
    if (!v) return;
    const nonce = Math.random().toString(36).slice(2);
    const { host, port } = this.manager.getTarget();
    const ctx: PageCtx = { nonce, cspSource: v.webview.cspSource, frameHosts: [`http://${host}:${port}`] };
    const s = this.manager.getSnapshot();
    let html: string;
    switch (s.state) {
      case 'ready':
        this.wasConnected = true;
        html = readyPage(s.url ?? `http://${host}:${port}/`, ctx, {
          token: this.bridgeToken,
          enabled: this.bridgeEnabled(), // 由 dsh.bridge.enabled 配置驱动（Task 7 接入）
        });
        break;
      case 'failed':
        html = errorPage(t, ctx, s.error ? t(s.error, s.errorVars) : t('err.loadFailed'));
        break;
      case 'idle':
        html = this.wasConnected ? disconnectedPage(t, ctx) : stoppedPage(t, ctx);
        break;
      default:
        // detecting / starting / waiting / stopping：统一加载中动画页
        html = loadingPage(t, ctx);
    }
    v.webview.html = html;
  }
}
