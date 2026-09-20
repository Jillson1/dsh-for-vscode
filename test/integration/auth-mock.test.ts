// test/integration/auth-mock.test.ts — DSH ≥0.1.2 鉴权协议的最小集成验证
//
// 与 test/integration/dsh.test.ts 同一套门控思路：**环境不具备时自动跳过**。
// 这里依赖的是本地鉴权复现器 `.dsh-auth-mock/server.mjs`（本机验证用，不入库；
// 源码见《DSH鉴权适配开发方案.md》附录 D）。启动方式：
//
//   node .dsh-auth-mock/server.mjs      # 监听 127.0.0.1:3939
//
// 它复刻了 dsh 0.1.2 的关键行为：GET /?token=abc → 303 + Set-Cookie(HttpOnly;
// SameSite=Strict)；无 cookie → 401（body 含 'dsh web authentication required'）；
// 带 cookie → 200。因此本文件能在**不装 0.1.5 的机器上**守住鉴权链路的回归。
//
// 跳过是逐用例动态判定的（模块顶层不能用 await：构建目标是 cjs）。
// 断言分层：探测层（S1）在这里直接验证；S2/S3 落地后本文件继续扩展
// （stdout 网址解析 → 兑换会话 → 经代办访问 200）。
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { probeService } from '../../src/service/detect';
import {
  exchangeSession,
  probeSession,
  type SessionStore,
  type StoredSession,
} from '../../src/service/session';

/** 内存会话存储（与 test/session.test.ts 同形，便于本地断言不落 globalState） */
function memStore(): SessionStore {
  const map = new Map<string, StoredSession>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

/** 复现器监听端口（与 .dsh-auth-mock/server.mjs 的 PORT 常量一致） */
const MOCK_PORT = 3939;
/** 复现器认可的一次性 token（server.mjs 中对 token === 'abc' 才发 cookie） */
const MOCK_TOKEN = 'abc';
/** 复现器基址 */
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

/** 缓存的在线判定（避免每个用例重复探测） */
let mockUpCache: boolean | undefined;

/** 复现器是否在线：探测结果为 'dsh' 才算（未启动时为 'down'） */
async function mockUp(): Promise<boolean> {
  if (mockUpCache === undefined) {
    mockUpCache = (await probeService('127.0.0.1', MOCK_PORT, 800)) === 'dsh';
  }
  return mockUpCache;
}

/** 复现器未启动时跳过本用例；返回 true 表示应继续执行 */
async function ensureMock(t: TestContext): Promise<boolean> {
  if (await mockUp()) return true;
  t.skip(`本地鉴权复现器未启动（node .dsh-auth-mock/server.mjs，端口 ${MOCK_PORT}），跳过`);
  return false;
}

test('S1 验收门④：需要登录的 DSH（401 + dsh web 特征）被识别为 dsh，而非 foreign', async (t) => {
  if (!(await ensureMock(t))) return;
  // 复现器无 cookie 时对任意路径回 401，body 为 `dsh web authentication required; …`
  // 改造前：401 → 'foreign' → manager 认为端口被占 → 换端口级联 + 15s 超时误报
  // 改造后：401 且 body 含 'dsh web' → 'dsh' → 正常判 ready
  assert.equal(await probeService('127.0.0.1', MOCK_PORT, 2000), 'dsh');
});

test('复现器协议契约：未带 cookie 的首页确实是 401 且 body 含 dsh web 特征', async (t) => {
  if (!(await ensureMock(t))) return;
  const res = await fetch(`${MOCK_BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.ok(body.includes('dsh web'), `401 body 应含 DSH 鉴权特征，实际: ${body}`);
});

test('复现器协议契约：带合法 token 返回 303 + dsh-auth-* 的 SameSite=Strict cookie', async (t) => {
  if (!(await ensureMock(t))) return;
  const res = await fetch(`${MOCK_BASE}/?token=${MOCK_TOKEN}`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''];
  const cookie = setCookies.find((c) => c.startsWith('dsh-auth-')) ?? '';
  assert.notEqual(cookie, '', `应下发 dsh-auth-* cookie，实际: ${JSON.stringify(setCookies)}`);
  assert.ok(/SameSite=Strict/i.test(cookie), '会话 cookie 必须是 SameSite=Strict（这正是必须走本地代办的根因）');
  assert.ok(/HttpOnly/i.test(cookie), '会话 cookie 必须是 HttpOnly');
});

test('复现器协议契约：带上会话 cookie 后首页返回 200（浏览器/代办正确回送的判据）', async (t) => {
  if (!(await ensureMock(t))) return;
  const res = await fetch(`${MOCK_BASE}/`, {
    redirect: 'manual',
    headers: { cookie: 'dsh-auth-mock=v1.mock' },
  });
  assert.equal(res.status, 200);
});

// —— 会话判定器「无启动网址」分支的区分依据（S2）——
// ≤0.1.1（本机 rc.8 实测）**从不打印启动网址**，≥0.1.2 但由外部启动时扩展也读不到 stdout：
// 两种情况都是「无启动网址」，必须靠一次**匿名探测**区分——200=不需要鉴权（旧版，直接可用），
// 401/403=需要登录（≥0.1.2，显示引导页）。这两条断言把两个分支都钉住。
test('判定器依据①：需要登录的服务匿名探测 → expired（⇒ 判「需要登录」）', async (t) => {
  if (!(await ensureMock(t))) return;
  const store = memStore();
  const probe = await probeSession(`127.0.0.1:${MOCK_PORT}`, { fetchImpl: fetch, store });
  assert.equal(probe, 'expired', '复现器无 cookie 时回 401，判定器必须据此走「需要登录」分支');
});

test('判定器依据②：会话有效时匿名探测 → ok（⇒ 判「直接可用」）', async (t) => {
  if (!(await ensureMock(t))) return;
  const store = memStore();
  const authority = `127.0.0.1:${MOCK_PORT}`;
  const r = await exchangeSession(`${MOCK_BASE}/?token=${MOCK_TOKEN}`, { fetchImpl: fetch, store });
  assert.equal(r.status, 'ok', `兑换应成功，实际：${JSON.stringify(r)}`);
  const probe = await probeSession(authority, { fetchImpl: fetch, store });
  assert.equal(probe, 'ok', '带会话探测应回 200');
});
