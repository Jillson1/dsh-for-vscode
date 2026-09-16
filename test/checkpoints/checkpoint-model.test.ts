// test/checkpoints/checkpoint-model.test.ts — F9 检查点纯模型单测
// 覆盖：manifest 窄化与版本闸门、漂移比较（含"blob 缺失不误报"）、标签/时间文案、blob 路径与 diff 标题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeManifest,
  compareToCurrent,
  checkpointLabel,
  formatStamp,
  blobRelativePath,
  diffTitles,
  sha256Hex,
  LEDGER_FORMAT_VERSION,
  MAX_COMPARE_FILES,
} from '../../src/checkpoints/checkpoint-model';

/** 一份合法 manifest（默认：第 3 轮、两个文件） */
function manifest(over: Record<string, unknown> = {}) {
  return {
    version: LEDGER_FORMAT_VERSION,
    id: 'rp_1',
    kind: 'turn',
    workspace: 'E:\\w',
    sessionId: 'sess-1',
    turn: 3,
    turnStartSeq: 12,
    createdAt: new Date(2026, 7, 26, 14, 22).getTime(),
    fileCount: 2,
    totalBytes: 2048,
    entries: {
      'src/a.ts': { kind: 'file', blob: 'aa'.repeat(32), size: 10 },
      'src/b.ts': { kind: 'file', blob: 'bb'.repeat(32), size: 20 },
    },
    ...over,
  };
}

test('sanitizeManifest：合法 manifest 保留关键字段', () => {
  const cp = sanitizeManifest(manifest());
  assert.ok(cp !== null);
  assert.equal(cp.id, 'rp_1');
  assert.equal(cp.kind, 'turn');
  assert.equal(cp.turn, 3);
  assert.equal(cp.turnStartSeq, 12);
  assert.equal(cp.fileCount, 2);
  assert.deepEqual(Object.keys(cp.entries), ['src/a.ts', 'src/b.ts']);
  assert.equal(cp.entries['src/a.ts']?.blob, 'aa'.repeat(32));
});

test('sanitizeManifest：版本闸门与必填缺失一律整条丢弃（宁可看不到，也不半信半疑地显示）', () => {
  assert.equal(sanitizeManifest(null), null);
  assert.equal(sanitizeManifest(manifest({ version: 2 })), null, '版本不认识');
  assert.equal(sanitizeManifest(manifest({ version: undefined })), null);
  assert.equal(sanitizeManifest(manifest({ id: '' })), null);
  assert.equal(sanitizeManifest(manifest({ workspace: undefined })), null);
  assert.equal(sanitizeManifest(manifest({ entries: 'nope' })), null);
  assert.equal(sanitizeManifest(manifest({ entries: null })), null);
});

test('sanitizeManifest：entries 里的坏项被丢弃，缺省字段回退安全值', () => {
  const cp = sanitizeManifest(
    manifest({
      entries: {
        'ok.ts': { kind: 'file', blob: 'cc'.repeat(32) },
        'no-kind.ts': { blob: 'dd'.repeat(32) },
        '': { kind: 'file' },
        'junk.ts': 'not-an-object',
        'null.ts': null,
      },
      createdAt: 'yesterday',
      fileCount: 'many',
      totalBytes: undefined,
      turn: 'x',
    }),
  );
  assert.ok(cp !== null);
  assert.deepEqual(Object.keys(cp.entries).sort(), ['no-kind.ts', 'ok.ts']);
  assert.equal(cp.entries['no-kind.ts']?.kind, 'file', '缺 kind 回退 file');
  assert.equal(cp.createdAt, 0);
  assert.equal(cp.fileCount, 0);
  assert.equal(cp.totalBytes, 0);
  assert.equal(cp.turn, undefined);
});

test('compareToCurrent：内容不同 → modified；文件不存在 → deleted；一致 → 不出现在结果里', () => {
  const entries = {
    'src/same.ts': { kind: 'file', blob: 'aa'.repeat(32) },
    'src/changed.ts': { kind: 'file', blob: 'bb'.repeat(32) },
    'src/gone.ts': { kind: 'file', blob: 'cc'.repeat(32) },
  };
  const current = new Map<string, string>([
    ['src/same.ts', 'aa'.repeat(32)],
    ['src/changed.ts', 'ff'.repeat(32)],
    // src/gone.ts 缺失
  ]);
  const { drifts, truncated, compared } = compareToCurrent(entries, current);
  assert.deepEqual(
    drifts.map((d) => `${d.path}:${d.kind}`),
    ['src/changed.ts:modified', 'src/gone.ts:deleted'],
  );
  assert.equal(compared, 3);
  assert.equal(truncated, 0);
  // 漂移项带上检查点里的 blob（diff 的旧侧要用）
  assert.equal(drifts[0]?.blob, 'bb'.repeat(32));
});

test('compareToCurrent：blob 缺失的条目跳过而不是误报为"已删除"', () => {
  const entries = { 'dir': { kind: 'tree' }, 'src/a.ts': { kind: 'file', blob: 'aa'.repeat(32) } };
  const current = new Map<string, string>([['src/a.ts', 'aa'.repeat(32)]]);
  const { drifts } = compareToCurrent(entries, current);
  assert.deepEqual(drifts, [], '目录条目没有 blob：既不能比较，也不该报删除');
});

test('compareToCurrent：超过上限时截断并如实报出剩余数', () => {
  const entries: Record<string, { kind: string; blob: string }> = {};
  const current = new Map<string, string>();
  for (let i = 0; i < MAX_COMPARE_FILES + 5; i += 1) {
    entries[`f${String(i).padStart(4, '0')}.ts`] = { kind: 'file', blob: 'aa'.repeat(32) };
    current.set(`f${String(i).padStart(4, '0')}.ts`, 'aa'.repeat(32));
  }
  const { compared, truncated } = compareToCurrent(entries, current);
  assert.equal(compared, MAX_COMPARE_FILES);
  assert.equal(truncated, 5);
});

test('checkpointLabel / formatStamp：轮次与时间文案', () => {
  const cp = sanitizeManifest(manifest());
  assert.ok(cp !== null);
  assert.equal(formatStamp(cp.createdAt), '08-26 14:22');
  assert.equal(checkpointLabel(cp), '第 3 轮 · 08-26 14:22 · 2 文件');
  // 非 turn 类检查点退回 kind
  const rescue = sanitizeManifest(manifest({ kind: 'rescue', turn: undefined }));
  assert.ok(rescue !== null);
  assert.match(checkpointLabel(rescue), /^rescue · 08-26 14:22/);
});

test('blobRelativePath / diffTitles / sha256Hex', () => {
  const sha = 'ab'.repeat(32);
  assert.equal(blobRelativePath(sha), `ab/${sha}`);
  const cp = sanitizeManifest(manifest());
  assert.ok(cp !== null);
  assert.deepEqual(diffTitles(cp, 'src/a.ts'), { left: 'src/a.ts (第 3 轮前)', right: 'src/a.ts (现在)' });
  // sha256 与 node:crypto 一致
  assert.equal(sha256Hex('hello').length, 64);
  assert.equal(sha256Hex('hello'), sha256Hex('hello'));
});
