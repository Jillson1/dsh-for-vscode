// test/integration/dsh.test.ts — 真实 dsh web 集成测试
//
// 门控（两条，缺一即跳过）：
//  1. PATH 上有 dsh —— 注意 Windows 上必须按平台选择可执行形式（见 test/dsh-availability.ts）：
//     原先写的 `spawnSync('dsh', ['--version']).status === 0` 在 Windows 上恒为 false
//     （Node 不解析 npm 的 POSIX shim；'dsh.cmd' 在 shell:false 下又抛 EINVAL），
//     导致本文件**在 Windows 上一直静默跳过、等于没跑**；
//  2. **显式提供隔离的 DSH_HOME** —— 真实 ~/.dsh profile 同时只允许一个 dsh web，
//     第二个进程会在 plugin tree 加载阶段崩溃（实测：task-board ledger 被占用锁）。
//
// 测试用随机空闲端口，避免打扰 3080。跑法：
//   DSH_HOME="$(pwd)/.dsh-e2e-home" node --test out/test/integration/dsh.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hasDsh as hasDshCmd } from '../dsh-availability';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';

/** 取一个当前空闲的随机端口 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** 隔离的 DSH_HOME 是否可用（探测文件即写即删，不留残留） */
const homeUsable = ((): boolean => {
  const home = process.env.DSH_HOME ?? '';
  if (home === '') return false;
  try {
    const probe = join(home, `.probe-${process.pid}`);
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
})();

/** 门控：需要 dsh + 显式隔离 DSH_HOME（见文件头说明） */
const skip = hasDshCmd() && homeUsable
  ? false
  : `需要 PATH 上的 dsh 与可写的隔离 DSH_HOME（当前 ${process.env.DSH_HOME ?? '未设置'}），跳过`;

test('真实 dsh web：启动/复用/停止/意外退出全流程', { skip }, async () => {
  const port = await freePort();
  const runner = createProcessRunner();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    { probeService, processRunner: runner, log: () => {}, startTimeoutMs: 20000 },
  );
  try {
    // 1) 自动启动
    const s1 = await manager.ensureRunning();
    assert.equal(s1.state, 'ready');
    assert.equal(s1.owned, true);
    assert.equal(s1.url, `http://127.0.0.1:${port}/`);
    assert.equal(await probeService('127.0.0.1', port, 3000), 'dsh');

    // 2) 幂等复用（不重复启动）：第二次 ensureRunning 后 lastChild 仍指向同一子进程
    const firstChild = runner.lastChild;
    const s2 = await manager.ensureRunning();
    assert.equal(s2.state, 'ready');
    assert.equal(runner.lastChild, firstChild);

    // 3) 停止：服务消失
    await manager.stop();
    assert.equal(await probeService('127.0.0.1', port, 3000), 'down');

    // 4) 再次启动（自愈）
    const s3 = await manager.ensureRunning();
    assert.equal(s3.state, 'ready');

    // 5) 意外退出检测：直接杀进程 → 状态回 idle
    runner.lastChild?.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(manager.getSnapshot().state, 'idle');
    assert.equal(await probeService('127.0.0.1', port, 3000), 'down');
  } finally {
    await manager.stop(); // 清理：确保不残留 dsh 进程
    manager.dispose();
  }
});
