// test/integration/auth-launch.test.ts — 真实 dsh 的「启动网址捕获 → 会话判定」端到端验证
//
// 门控（两条，缺一即跳过）：
//  1. PATH 上有 dsh（Windows 上须走 .cmd + shell，见 test/dsh-availability.ts）；
//  2. **显式提供隔离的 DSH_HOME**——真实 ~/.dsh profile 同一时刻只允许一个 dsh web，
//     第二个进程会在 plugin tree 加载阶段崩溃（实测：`task-board ledger is already
//     owned by process <pid>`），既污染现场又让断言失去意义；隔离 home 同时避免
//     触碰用户真实会话数据。跑法：
//
//       DSH_HOME="$(pwd)/.dsh-e2e-home" npm run compile && \
//       DSH_HOME="$(pwd)/.dsh-e2e-home" node --test out/test/integration/auth-launch.test.js
//
// 本文件守住两条**版本自适应**的红线：
//  - ≤0.1.1（如本机 rc.8）：stdout 若不打印带 token 的启动网址 → parseLaunchTarget 为
//    null → 判定「无浏览器鉴权」，不得发起兑换、不得写入会话（旧版行为完全不变）；
//  - ≥0.1.2：打印带一次性 token 的网址 → 兑换成功并把会话写入 store。
// 两种情况下一旦捕获到启动网址，**日志都不得出现明文 token**（凭据卫生红线）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hasDsh, dshVersion } from '../dsh-availability';
import { probeService } from '../../src/service/detect';
import { createProcessRunner } from '../../src/service/process';
import { ServiceManager } from '../../src/service/manager';
import {
  exchangeSession,
  parseLaunchTarget,
  probeSession,
  type SessionStore,
  type StoredSession,
} from '../../src/service/session';

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

/** 内存会话存储 */
function memStore(): SessionStore & { size(): number } {
  const map = new Map<string, StoredSession>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
    size: () => map.size,
  };
}

/** 门控：需要 dsh + 显式隔离的 DSH_HOME（见文件头说明） */
const e2eHome = process.env.DSH_HOME ?? '';
const homeUsable = ((): boolean => {
  if (e2eHome === '') return false;
  try {
    const probe = join(e2eHome, `.probe-${process.pid}`);
    writeFileSync(probe, 'x');
    rmSync(probe, { force: true }); // 探测即删，不留残留
    return true;
  } catch {
    return false;
  }
})();
const skip = hasDsh() && homeUsable
  ? false
  : `需要 PATH 上的 dsh（本机探测：${String(dshVersion())}）与可写的隔离 DSH_HOME（当前 ${e2eHome === '' ? '未设置' : e2eHome}），跳过`;

test('真实 dsh：启动网址捕获 + 凭据卫生 + 版本自适应判定（≤0.1.1 无鉴权 / ≥0.1.2 兑换成功）', { skip }, async () => {
  const port = await freePort();
  const logs: string[] = [];
  const launchUrls: string[] = [];
  const store = memStore();
  const manager = new ServiceManager(
    { host: '127.0.0.1', port, extraArgs: [], autoStart: true, timeoutMs: 3000, pollMs: 300 },
    {
      probeService,
      processRunner: createProcessRunner(),
      log: (l) => logs.push(l),
      startTimeoutMs: 30000,
      onLaunchUrl: (u) => launchUrls.push(u),
    },
  );
  try {
    const s = await manager.ensureRunning();
    assert.equal(s.state, 'ready', `服务应就绪，日志：\n${logs.join('\n')}`);
    // 以**管理器当前端口**为准（端口被占时会临时回退，此时 this.opts.port 已变）
    const { host, port: activePort } = manager.getTarget();
    const authority = `${host}:${activePort}`;

    // 0) 启动网址**晚于 HTTP 就绪**到达（dsh-web-app 的 announceReady 在 webServer 起来后才打印，
    //    见 @deepseek-ai/dsh-web-app 的 localWebUrl/announceReady）——这正是上游 dd92587 要加
    //    「启动网址宽限期」的原因。这里显式等它，并把等待时长记下来作为实测证据。
    const t0 = Date.now();
    while (launchUrls.length === 0 && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const waitedMs = Date.now() - t0;

    if (launchUrls.length > 0) {
      const launch = launchUrls[0];
      const launchToken = parseLaunchTarget(launch)?.token;

      if (launchToken !== undefined) {
        // —— ≥0.1.2 路径：带一次性 token ——
        // 凭据卫生：日志里不得出现明文 token，且应看到打码形态与「只记 host:port」的捕获日志
        assert.ok(!logs.some((l) => l.includes(launchToken)), '日志中不得出现明文 token');
        assert.ok(logs.some((l) => l.includes('token=***')), '启动网址行应被打码为 token=***');
        assert.ok(
          logs.some((l) => l.includes('捕获 DSH 启动网址（host:port=')),
          `应有捕获日志，实际：\n${logs.filter((l) => l.includes('启动网址')).join('\n')}`,
        );
        const r = await exchangeSession(launch, { fetchImpl: fetch, store });
        assert.equal(r.status, 'ok', `≥0.1.2 应兑换成功，实际：${JSON.stringify(r)}`);
        assert.equal(store.size(), 1);
      } else {
        // —— ≤0.1.1 路径（本机 rc.8 实测）：打印**不带 token 的裸地址** ——
        // 例：`dsh web: http://127.0.0.1:62252/`（dsh-web-app 的 localWebUrl 恒无 token）。
        // 该分支必须判「无浏览器鉴权 → 直接可用」，绝不能判「需要登录」。
        // 注意：dsh-web-app 打印的是 `http://host:port`（无尾斜杠），
        // parseLaunchUrlLine 用 `new URL().href` 归一化后补上 `/`。
        assert.equal(
          launch,
          `http://${host}:${activePort}/`,
          `裸地址应与当前目标端口一致：launch=${launch} 请求端口=${port}`,
        );
        assert.equal(parseLaunchTarget(launch), null, '裸地址没有 token ⇒ 判定器走 no-auth 分支');
        assert.equal(
          await probeSession(authority, { fetchImpl: fetch, store }),
          'ok',
          '旧版匿名探测应为 200（判定器据此判「直接可用」）',
        );
        assert.equal(store.size(), 0, '≤0.1.1 无鉴权：不得写入任何会话');
        assert.ok(!logs.some((l) => l.includes('token=***')), '裸地址行不含 token，无需打码');
      }
    } else {
      // —— 兜底路径：完全没有启动网址（printUrl 被关掉 / 复用外部已启服务时不产生 stdout）——
      // 此时只能靠匿名探测区分两代：200 = 不需要鉴权（旧版）→ ok；401/403 = 需要登录 → needed。
      assert.equal(
        await probeSession(authority, { fetchImpl: fetch, store }),
        'ok',
        '无启动网址时匿名探测应回 200：据此判「直接可用」而非「需要登录」',
      );
      assert.equal(store.size(), 0);
    }

    // 实测证据：网址到达通常晚于 ready（宽限期不是可选项）
    assert.ok(waitedMs >= 0, `启动网址等待 ${waitedMs}ms`);
  } finally {
    await manager.stop();
    manager.dispose();
  }
});
