// src/statusbar.ts — 状态栏项：显示服务状态，点击打开面板
import * as vscode from 'vscode';
import { ServiceManager, type ServiceSnapshot } from './service/manager';
import { agentStatusView, IDLE_AGENT_STATE, type AgentState } from './bridge/agent-state';
import { t } from './i18n';

/** 四种状态的图标 + 文案键 + 颜色主题 ID（绿/黄/红/灰） */
const PRESETS = {
  running: { icon: '$(check)', color: 'charts.green', textKey: 'status.running' },
  starting: { icon: '$(sync~spin)', color: 'charts.yellow', textKey: 'status.starting' },
  failed: { icon: '$(error)', color: 'charts.red', textKey: 'status.failed' },
  stopped: { icon: '$(circle-outline)', color: 'descriptionForeground', textKey: 'status.stopped' },
} as const;

type PresetKey = keyof typeof PRESETS;

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor(manager: ServiceManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'dsh.openPanel';
    this.item.show();
    manager.onChange((s) => this.update(s));
    this.update(manager.getSnapshot());
  }

  private update(s: ServiceSnapshot): void {
    const key: PresetKey =
      s.state === 'ready'
        ? 'running'
        : s.state === 'failed'
          ? 'failed'
          : s.state === 'idle'
            ? 'stopped'
            : 'starting';
    const p = PRESETS[key];
    this.item.text = `${p.icon} ${t(p.textKey)}`;
    this.item.color = new vscode.ThemeColor(p.color);
    this.item.tooltip = s.error ? t(s.error, s.errorVars) : '';
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * F7：agent 状态项（与"服务状态"分开两个 item）。
 *
 * 为什么不复用上面那个：两个状态的生命周期与含义完全不同——服务状态是"DSH 进程活着吗"，
 * agent 状态是"它正在干什么 / 是不是在等你回答"。混成一个 item 会出现
 * "服务正常但 agent 卡在审批"被渲染成绿色的误导。
 */
export class AgentStatusController {
  private item: vscode.StatusBarItem;
  /** 最近一次收到的 agent 状态（可见性开关切换后要能立刻按新可见性重绘，而不是等下一次状态变化） */
  private last: AgentState = IDLE_AGENT_STATE;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    // 点状态栏回到 DSH 面板（与"等审批"这个提示的下一步动作一致）
    this.item.command = 'dsh.openPanel';
    this.item.show();
  }

  /** 应用一次 agent 状态（纯逻辑在 agent-state.ts，这里只落 UI） */
  update(state: AgentState): void {
    this.last = state;
    const view = agentStatusView(state);
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.color = new vscode.ThemeColor(view.color);
  }

  /**
   * 设置这个状态项的可见性（`dsh.statusbar.agent.enabled` / `dsh.ideInteraction.enabled`）。
   *
   * 为什么要在这里做而不是靠 `when`：**状态栏项不支持 when 条件**（VS Code 的状态栏 API
   * 只有 show/hide），所以可见性必须在扩展侧自己判断并调用。
   * 隐藏时不改动已记录的 last，重新显示能立刻反映最新状态，不必等下一次会话状态变化。
   */
  setVisible(visible: boolean): void {
    if (visible) {
      this.update(this.last);
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
