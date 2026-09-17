// test/config-defaults.test.ts — 「全新安装后开关默认是开的」这条契约的守卫测试
//
// 为什么单独测它：`readConfig()` 走的是 `vscode.workspace.getConfiguration('dsh').get(...)`。
// 用户**从未改过**任何一个 dsh.* 设置时，这些 get 全部返回 `undefined`——
// 此时必须回退到 DEFAULTS（全开）。一旦某天有人把新开关的规范化写成"undefined 即关闭"，
// 或者把默认值写成 false，表现就是"装完插件功能全是关的"，而这在真机上非常容易被误判成
// "功能没做完/桥接坏了"。本测试把这条契约钉死。
//
// 桩行为见 test/vscode-stub.ts：getConfiguration().get() 恒返回 undefined，
// 恰好等价于"全新安装、settings.json 里没有任何 dsh.* 键"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, DEFAULTS, type DshConfig } from '../src/config';

/** 本轮新增的 5 个粗粒度总开关（缺一不可） */
const MASTER_SWITCHES = [
  'changesEnabled',
  'checkpointsEnabled',
  'ideInteractionEnabled',
  'quickEditEnabled',
  'statusbarAgentEnabled',
] as const;

/** 上一轮已有的细分开关（同样必须默认开） */
const FINE_SWITCHES = [
  'notifyOnTurnComplete',
  'selectionThreadsEnabled',
  'selectionLensEnabled',
  'quickEditConfirmBeforeSend',
  'interactionOnlyWhenPanelHidden',
] as const;

test('全新安装（settings 里没有任何 dsh.* 键）：全部开关默认开启', () => {
  const { config, errors } = readConfig();
  assert.deepEqual(errors, [], '缺省读取不应产生任何配置错误');
  for (const key of [...MASTER_SWITCHES, ...FINE_SWITCHES]) {
    assert.equal(config[key as keyof DshConfig], true, `${key} 必须默认开启`);
  }
});

test('DEFAULTS 自身：全部开关为 true（回退目标不能是关的）', () => {
  for (const key of [...MASTER_SWITCHES, ...FINE_SWITCHES]) {
    assert.equal(DEFAULTS[key as keyof DshConfig], true, `DEFAULTS.${key} 必须为 true`);
  }
});

test('贡献点默认值与代码默认值一致（package.json ↔ config.ts 不许漂移）', async () => {
  // 直接从仓库根读 package.json：VS Code 设置面板显示的是贡献点里的 default，
  // 实际行为用的是 DEFAULTS——两者不一致时，用户会看到"勾是开的但功能没生效"。
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default: unknown }> } };
  };
  const props = pkg.contributes.configuration.properties;
  const expected: Record<string, boolean> = {
    'dsh.changes.enabled': DEFAULTS.changesEnabled,
    'dsh.checkpoints.enabled': DEFAULTS.checkpointsEnabled,
    'dsh.ideInteraction.enabled': DEFAULTS.ideInteractionEnabled,
    'dsh.quickEdit.enabled': DEFAULTS.quickEditEnabled,
    'dsh.statusbar.agent.enabled': DEFAULTS.statusbarAgentEnabled,
    'dsh.notify.onTurnComplete': DEFAULTS.notifyOnTurnComplete,
    'dsh.selection.threads.enabled': DEFAULTS.selectionThreadsEnabled,
    'dsh.selection.lens.enabled': DEFAULTS.selectionLensEnabled,
    'dsh.quickEdit.confirmBeforeSend': DEFAULTS.quickEditConfirmBeforeSend,
    'dsh.interaction.onlyWhenPanelHidden': DEFAULTS.interactionOnlyWhenPanelHidden,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(props[key] !== undefined, `${key} 必须在 contributes.configuration 里 declare`);
    assert.equal(props[key]?.default, value, `${key} 的贡献点默认值必须与 config.ts 一致`);
  }
});
