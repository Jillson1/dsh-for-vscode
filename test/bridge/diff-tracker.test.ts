// test/bridge/diff-tracker.test.ts — A 组修改跟踪纯逻辑单测
// 覆盖：路径解析、hunk → 记录转换、oldText/newText 定位、撤销编辑构造、修改栈去重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep, isAbsolute } from 'node:path';
import {
  resolveInputPath,
  recordsFromDiffs,
  locateOldText,
  locateNewText,
  verifyRevert,
  buildRevertEdit,
  pathsEqual,
  DiffStack,
  type AppliedDiffInput,
  type ModificationRecord,
} from '../../src/bridge/diff-tracker';

test('resolveInputPath 绝对/相对/cwd/工作区根解析', () => {
  assert.equal(resolveInputPath('/a/b.ts', undefined, '/proj'), '/a/b.ts');
  assert.equal(resolveInputPath('D:/x.ts', undefined, '/proj'), 'D:/x.ts');
  // Windows 上 node:path.resolve('/proj', 'src/a.ts') → 'D:\proj\src/a.ts'：
  // 用 isAbsolute + 尾段断言跨平台校验（文档 11.2 已知差异）
  const fromCwd = resolveInputPath('src/a.ts', '/proj', '/other');
  assert.ok(fromCwd !== null && isAbsolute(fromCwd), `应从 cwd 解析出绝对路径，实际：${fromCwd}`);
  assert.ok(fromCwd.endsWith(`${sep}proj${sep}src${sep}a.ts`) || fromCwd.endsWith('proj/src/a.ts'), `尾段应为 proj/src/a.ts，实际：${fromCwd}`);
  assert.equal(resolveInputPath('https://x/a.ts', undefined, '/proj'), null); // 协议串拒绝
  assert.equal(resolveInputPath('a.ts', undefined, undefined), null); // 无基准
});

test('recordsFromDiffs 每个 hunk 转一条记录并回填行数', () => {
  const input: AppliedDiffInput = {
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [
      { oldText: 'x', newText: 'y' },
      { oldText: 'a\nb\nc', newText: 'd\ne' },
    ],
    callId: 'c-1',
  };
  const records = recordsFromDiffs(input, '/proj');
  assert.equal(records.length, 2);
  assert.ok(isAbsolute(records[0].path), `path 应为绝对路径，实际：${records[0].path}`);
  assert.equal(records[0].oldText, 'x');
  assert.equal(records[0].newText, 'y');
  assert.equal(records[0].callId, 'c-1');
  assert.equal(records[0].lineCount, 1); // 单行
  assert.equal(records[1].lineCount, 3); // 跨 3 行
});

test('recordsFromDiffs 丢弃 oldText 为空的 hunk（write 新建）', () => {
  const input: AppliedDiffInput = {
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [{ oldText: '', newText: 'hi' }],
    callId: 'c-2',
  };
  assert.deepEqual(recordsFromDiffs(input, '/proj'), []);
});

test('recordsFromDiffs 路径无法解析 → 整条丢弃', () => {
  const input: AppliedDiffInput = {
    path: 'https://x/a.ts',
    diffs: [{ oldText: 'x', newText: 'y' }],
    callId: 'c-3',
  };
  assert.deepEqual(recordsFromDiffs(input, '/proj'), []);
});

test('locateOldText 计算 1-based 起始行与字符偏移', () => {
  const content = 'line one\nline two\nline three\n';
  const loc = locateOldText(content, 'line two');
  assert.ok(loc !== null);
  assert.equal(loc.line, 2);
  assert.equal(loc.startOffset, content.indexOf('line two'));
  assert.equal(locateOldText(content, 'missing'), null);
  assert.equal(locateOldText(content, ''), null);
});

test('locateNewText 定位改后片段', () => {
  const content = 'a\nconst x = 2\nb\n';
  const loc = locateNewText(content, 'const x = 2');
  assert.ok(loc !== null);
  assert.equal(loc.line, 2);
  assert.equal(loc.startOffset, content.indexOf('const x = 2'));
  assert.equal(locateNewText(content, 'gone'), null);
});

test('buildRevertEdit 把 newText 替换回 oldText', () => {
  // edit 落盘后文件内容 = 含 newText；撤销 = newText 片段 → oldText
  const record: ModificationRecord = {
    callId: 'c-1',
    path: '/proj/a.ts',
    oldText: 'const x = 1',
    newText: 'const x = 2',
    line: 2,
    lineCount: 1,
    ts: 0,
  };
  const content = 'a\nconst x = 2\nb\n';
  const edit = buildRevertEdit(content, record);
  assert.ok(edit !== null);
  assert.equal(edit.path, '/proj/a.ts');
  assert.equal(edit.startOffset, content.indexOf('const x = 2'));
  assert.equal(edit.currentText, 'const x = 2');
  assert.equal(edit.replacement, 'const x = 1');
});

test('buildRevertEdit newText 不在文件中 → null（文件被改动）', () => {
  const record: ModificationRecord = {
    callId: 'c-1',
    path: '/proj/a.ts',
    oldText: 'const OLD = 1',
    newText: 'const NEW_VALUE = 2',
    line: 1,
    lineCount: 1,
    ts: 0,
  };
  // newText 不在文件内容中（已被用户改写）→ null；单字符片段易误命中，用唯一长串
  assert.equal(buildRevertEdit('completely different content\n', record), null);
});

test('verifyRevert 校验 newText 仍在文件中', () => {
  const record: ModificationRecord = {
    callId: 'c-1',
    path: '/proj/a.ts',
    oldText: 'x',
    newText: 'y',
    line: 1,
    lineCount: 1,
    ts: 0,
  };
  assert.ok(verifyRevert('y\n', record) !== null);
  assert.equal(verifyRevert('z\n', record), null);
});

test('DiffStack 按 callId 去重', () => {
  const s = new DiffStack();
  const r: ModificationRecord = { callId: 'c-1', path: '/p', oldText: 'x', newText: 'y', line: 1, lineCount: 1, ts: 0 };
  assert.equal(s.push(r), true);
  assert.equal(s.push(r), false); // 同 callId 幂等
  assert.equal(s.size, 1);
  assert.equal(s.get('c-1'), r);
  assert.equal(s.remove('c-1'), r);
  assert.equal(s.size, 0);
});

test('DiffStack forPath 按路径过滤、保持插入序', () => {
  const s = new DiffStack();
  const mk = (callId: string, path: string): ModificationRecord =>
    ({ callId, path, oldText: 'x', newText: 'y', line: 1, lineCount: 1, ts: 0 });
  s.push(mk('c-1', '/p/a.ts'));
  s.push(mk('c-2', '/p/b.ts'));
  s.push(mk('c-3', '/p/a.ts'));
  assert.deepEqual(s.forPath('/p/a.ts').map((r) => r.callId), ['c-1', 'c-3']);
  assert.deepEqual(s.all().map((r) => r.callId), ['c-1', 'c-2', 'c-3']);
  s.clear();
  assert.equal(s.size, 0);
});

test('pathsEqual 大小写不敏感（win32）', () => {
  assert.equal(pathsEqual('E:\\proj\\a.ts', 'e:\\proj\\A.ts'), true);
  assert.equal(pathsEqual('/p/a.ts', '/p/a.ts'), true);
});

test('DiffStack forPath 大小写不敏感匹配（插件 path vs VS Code fsPath）', () => {
  const s = new DiffStack();
  const mk = (callId: string, path: string): ModificationRecord =>
    ({ callId, path, oldText: 'x', newText: 'y', line: 1, lineCount: 1, ts: 0 });
  s.push(mk('c-1', 'E:\\proj\\a.ts'));
  // 查询用不同大小写的 fsPath 也应命中
  assert.deepEqual(s.forPath('e:\\proj\\A.ts').map((r) => r.callId), ['c-1']);
});
