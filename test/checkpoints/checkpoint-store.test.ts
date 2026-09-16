// test/checkpoints/checkpoint-store.test.ts — F9 检查点存储单测（内存 fs 注入）
// 覆盖：工作区枚举、按 mtime 倒序取最新 N 份、坏 manifest 跳过、matchWorkspace 的"每工作区只读一份"、
// files 截断、blob 读取路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointStore, ledgerRoot, normalizePath, type CheckpointFs } from '../../src/checkpoints/checkpoint-store';
import { LEDGER_FORMAT_VERSION } from '../../src/checkpoints/checkpoint-model';

/** 内存 fs：files 用 posix 风格路径作 key（与实现的 join 结果一致） */
function memFs(files: Record<string, string>, mtimes: Record<string, number> = {}): CheckpointFs & { reads: string[] } {
  const reads: string[] = [];
  const dirs = new Set<string>();
  for (const key of Object.keys(files)) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  // 生产用 node:path.join（Windows 产出反斜杠），fake fs 统一按 '/' 查找，
  // 否则测试会在"路径分隔符"上失败——那是测试桩的问题，不是被测逻辑的问题
  const norm = (p: string): string => p.replace(/\\/g, '/');
  return {
    reads,
    async readdir(rawPath: string) {
      const path = norm(rawPath);
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const children = new Set<string>();
      for (const key of [...Object.keys(files), ...dirs]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length)
        if (rest === '') continue
        children.add(rest.split('/')[0] as string)
      }
      return [...children].sort();
    },
    async readFile(rawPath: string) {
      const path = norm(rawPath);
      reads.push(path);
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    async mtimeMs(rawPath: string) {
      return mtimes[norm(rawPath)];
    },
  };
}

/** 一份 manifest 文本 */
function manifestText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: LEDGER_FORMAT_VERSION,
    id: over.id ?? 'rp_1',
    kind: 'turn',
    workspace: over.workspace ?? 'E:\\w',
    sessionId: 'sess-1',
    turn: over.turn ?? 1,
    turnStartSeq: 4,
    createdAt: 1700000000000,
    fileCount: 1,
    totalBytes: 10,
    entries: { 'src/a.ts': { kind: 'file', blob: 'aa'.repeat(32), size: 10 } },
  });
}

test('ledgerRoot / normalizePath：路径规则', () => {
  assert.match(ledgerRoot('C:\\home\\.dsh'), /change-ledger[\\/]v1$/);
  assert.equal(normalizePath('E:\\W\\'), normalizePath('e:/w'));
});

test('workspaces：只列出目录名，忽略隐藏项', async () => {
  const fs = memFs({ 'root/workspaces/aaa/manifests/x.json': '{}', 'root/workspaces/.tmp/y': '' });
  const store = new CheckpointStore({ root: 'root', fs });
  assert.deepEqual(await store.workspaces(), ['aaa']);
});

test('checkpoints：按 mtime 倒序取最新 N 份，并报出被跳过的份数', async () => {
  const fs = memFs(
    {
      'root/workspaces/h/manifests/old.json': manifestText({ id: 'rp_old' }),
      'root/workspaces/h/manifests/mid.json': manifestText({ id: 'rp_mid' }),
      'root/workspaces/h/manifests/new.json': manifestText({ id: 'rp_new' }),
    },
    {
      'root/workspaces/h/manifests/old.json': 100,
      'root/workspaces/h/manifests/mid.json': 200,
      'root/workspaces/h/manifests/new.json': 300,
    },
  );
  const store = new CheckpointStore({ root: 'root', fs });
  const list = await store.checkpoints('h', 2);
  assert.deepEqual(
    list.checkpoints.map((c) => c.id),
    ['rp_new', 'rp_mid'],
  );
  assert.equal(list.total, 3);
  assert.equal(list.skipped, 1);
});

test('checkpoints：JSON 坏 / 版本不认识 → 跳过而不是抛（一个坏文件不该毁掉整棵树）', async () => {
  const logs: string[] = [];
  const fs = memFs(
    {
      'root/workspaces/h/manifests/bad-json.json': '{not json',
      'root/workspaces/h/manifests/bad-version.json': JSON.stringify({ version: 99, id: 'x', workspace: 'E:\\w', entries: {} }),
      'root/workspaces/h/manifests/ok.json': manifestText({ id: 'rp_ok' }),
    },
    {},
  );
  const store = new CheckpointStore({ root: 'root', fs, log: (m) => logs.push(m) });
  const list = await store.checkpoints('h');
  assert.deepEqual(list.checkpoints.map((c) => c.id), ['rp_ok']);
  assert.ok(logs.some((l) => l.includes('解析失败')));
  assert.ok(logs.some((l) => l.includes('格式不认')));
});

test('checkpoints：账本不存在 → 空结果（不是错误）', async () => {
  const store = new CheckpointStore({ root: 'root', fs: memFs({}) });
  assert.deepEqual(await store.checkpoints('missing'), { checkpoints: [], total: 0, skipped: 0 });
});

test('matchWorkspace：命中大小写不同的同一路径，且每个工作区只读一份 manifest', async () => {
  const fs = memFs({
    'root/workspaces/h1/manifests/a.json': manifestText({ workspace: 'E:\\other' }),
    'root/workspaces/h1/manifests/b.json': manifestText({ workspace: 'E:\\other' }),
    'root/workspaces/h2/manifests/c.json': manifestText({ workspace: 'E:\\Target' }),
    'root/workspaces/h2/manifests/d.json': manifestText({ workspace: 'E:\\Target' }),
  });
  const store = new CheckpointStore({ root: 'root', fs });
  assert.equal(await store.matchWorkspace('e:\\target\\'), 'h2');
  // h1 只读一份就去读 h2（共 2 次读文件），不是把所有 manifest 读完
  assert.equal(fs.reads.length, 2);
  assert.equal(await store.matchWorkspace('E:\\nope'), null);
});

test('files：按路径排序并截断', async () => {
  const store = new CheckpointStore({ root: 'root', fs: memFs({}) });
  const entries: Record<string, { kind: string; blob?: string }> = {};
  for (let i = 0; i < 5; i += 1) entries[`f${i}.ts`] = { kind: 'file', blob: `b${i}` };
  const cp = {
    id: 'rp',
    kind: 'turn',
    workspace: 'E:\\w',
    createdAt: 0,
    fileCount: 5,
    totalBytes: 0,
    entries,
  };
  const { files, truncated } = store.files(cp, 3);
  assert.deepEqual(
    files.map((f) => f.path),
    ['f0.ts', 'f1.ts', 'f2.ts'],
  );
  assert.equal(truncated, 2);
});

test('blobText：按 sha 前两位分桶读取', async () => {
  const sha = 'ab'.repeat(32);
  const fs = memFs({ [`root/workspaces/h/blobs/ab/${sha}`]: 'file-content' });
  const store = new CheckpointStore({ root: 'root', fs });
  assert.equal(await store.blobText('h', sha), 'file-content');
  await assert.rejects(() => store.blobText('h', 'cd'.repeat(32)));
});
