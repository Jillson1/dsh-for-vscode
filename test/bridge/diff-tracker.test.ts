// test/bridge/diff-tracker.test.ts — A/B 组修改跟踪纯逻辑单测
// 覆盖：路径解析、hunk → 记录转换、oldText/newText 定位、撤销编辑构造、修改栈去重、
// 行级红绿 diff（diffLines / redGreenLines）。
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
  diffLines,
  redGreenLines,
  mergeLineMarks,
  diffNature,
  summarizeDiff,
  deletedLines,
  addedLines,
  planDiscard,
  writtenContentMatches,
  userAppendedPart,
  decorationTargetLine,
  snapMarksToContent,
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

test('recordsFromDiffs 保留 oldText 为空的 hunk（write 新建，全绿高亮）', () => {
  const input: AppliedDiffInput = {
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [{ oldText: '', newText: 'hi' }],
    callId: 'c-2',
  };
  const records = recordsFromDiffs(input, '/proj');
  assert.equal(records.length, 1);
  assert.equal(records[0].oldText, '');
  assert.equal(records[0].newText, 'hi');
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

// ─────────────────────────────────────────────────────────────────────────────
// B 组：行级红绿 diff（Cursor 风格）
// ─────────────────────────────────────────────────────────────────────────────

test('diffLines 纯新增：oldText 空 → 全 add', () => {
  const out = diffLines('', 'a\nb');
  assert.deepEqual(out, [
    { type: 'add', newLine: 1 },
    { type: 'add', newLine: 2 },
  ]);
});

test('diffLines 纯删除：newText 空 → 全 del', () => {
  const out = diffLines('a\nb', '');
  assert.deepEqual(out, [
    { type: 'del', oldLine: 1 },
    { type: 'del', oldLine: 2 },
  ]);
});

test('diffLines 单行替换 → del + add', () => {
  const out = diffLines('x', 'y');
  assert.deepEqual(out, [
    { type: 'del', oldLine: 1 },
    { type: 'add', newLine: 1 },
  ]);
});

test('diffLines 多行替换带上下文（首尾相同行保留 ctx）', () => {
  const out = diffLines('a\nOLD\nb', 'a\nNEW\nb');
  assert.deepEqual(out, [
    { type: 'ctx', oldLine: 1, newLine: 1 },
    { type: 'del', oldLine: 2 },
    { type: 'add', newLine: 2 },
    { type: 'ctx', oldLine: 3, newLine: 3 },
  ]);
});

test('diffLines 纯插入：NEW 行夹在上下文中间 → add 在中间', () => {
  const out = diffLines('a\nb', 'a\nNEW\nb');
  assert.deepEqual(out, [
    { type: 'ctx', oldLine: 1, newLine: 1 },
    { type: 'add', newLine: 2 },
    { type: 'ctx', oldLine: 2, newLine: 3 },
  ]);
});

test('redGreenLines 替换场景：del 投影到替换锚点（第一个 new 行）', () => {
  // newText 起始行 = 5；oldText 'OLD1\nOLD2' 换成 newText 'NEW'：
  // del 两行都投影到 newText 的第 1 行（文件第 5 行），add 也标在第 5 行
  const marks = redGreenLines('OLD1\nOLD2', 'NEW', 5);
  assert.deepEqual(marks, [
    { line: 5, kind: 'del' },
    { line: 5, kind: 'add' },
  ]);
});

test('redGreenLines 纯新增：全绿精确行', () => {
  const marks = redGreenLines('', 'a\nb\nc', 3);
  assert.deepEqual(marks, [
    { line: 3, kind: 'add' },
    { line: 4, kind: 'add' },
    { line: 5, kind: 'add' },
  ]);
});

test('redGreenLines 纯删除：投影到 hunk 末尾（newStart+newCount-1）', () => {
  // newText 为空、起始行 2 → 删除行投影到 max(1, 2+0-1)=1
  const marks = redGreenLines('a\nb', '', 2);
  assert.deepEqual(marks, [{ line: 1, kind: 'del' }]);
});

test('redGreenLines 输出按行号升序且同点去重', () => {
  const marks = redGreenLines('a\nb', 'c\nd', 10);
  // del 投影到锚点 10（第一个 add 行），add 标 10、11 → 排序后 del+add 在 10，add 在 11
  assert.deepEqual(marks, [
    { line: 10, kind: 'del' },
    { line: 10, kind: 'add' },
    { line: 11, kind: 'add' },
  ]);
});

test('recordsFromDiffs write 新建（oldText 空串）也保留（全绿高亮）', () => {
  const input: AppliedDiffInput = {
    path: 'src/n.ts',
    cwd: '/proj',
    diffs: [{ oldText: '', newText: 'hi\nworld' }],
    callId: 'c-write-1',
  };
  const records = recordsFromDiffs(input, '/proj');
  assert.equal(records.length, 1);
  assert.equal(records[0].oldText, '');
  assert.equal(records[0].lineCount, 2); // 按 newText 行数
});

test('buildRevertEdit edit 纯插入（oldText 空）→ 还原为移除插入内容', () => {
  const record: ModificationRecord = {
    callId: 'c-edit-ins',
    path: '/proj/n.ts',
    oldText: '',
    newText: 'inserted',
    line: 1,
    lineCount: 1,
    ts: 0,
    tool: 'edit',
  };
  const edit = buildRevertEdit('inserted\n', record);
  assert.ok(edit !== null);
  assert.equal(edit.currentText, 'inserted');
  assert.equal(edit.replacement, ''); // 空串 = 删除该片段
});

// ─────────────────────────────────────────────────────────────────────────────
// 丢弃语义：write 新建 → 删除文件；其余 → 文本还原
// ─────────────────────────────────────────────────────────────────────────────

test('planDiscard write 新建（tool=write + 空 oldText）→ delete-file', () => {
  const rec: ModificationRecord = {
    callId: 'c-w',
    path: '/proj/new.md',
    oldText: '',
    newText: 'hi',
    line: 1,
    lineCount: 1,
    ts: 0,
    tool: 'write',
  };
  assert.deepEqual(planDiscard(rec), { kind: 'delete-file' });
});

test('planDiscard write 覆盖（有真实改前片段）→ revert-text', () => {
  const rec: ModificationRecord = {
    callId: 'c-w2',
    path: '/proj/a.ts',
    oldText: 'old',
    newText: 'new',
    line: 1,
    lineCount: 1,
    ts: 0,
    tool: 'write',
  };
  assert.deepEqual(planDiscard(rec), { kind: 'revert-text' });
});

test('planDiscard edit（含纯插入）→ revert-text', () => {
  const base = { callId: 'c-e', path: '/proj/a.ts', line: 1, lineCount: 1, ts: 0, tool: 'edit' };
  assert.deepEqual(planDiscard({ ...base, oldText: 'x', newText: 'y' }), { kind: 'revert-text' });
  assert.deepEqual(planDiscard({ ...base, oldText: '', newText: 'y' }), { kind: 'revert-text' });
});

test('planDiscard 未知工具（tool 缺省）+ 空 oldText → refuse（防文本还原清空文件）', () => {
  const rec: ModificationRecord = {
    callId: 'c-u',
    path: '/proj/a.ts',
    oldText: '',
    newText: 'y',
    line: 1,
    lineCount: 1,
    ts: 0,
  };
  assert.deepEqual(planDiscard(rec), { kind: 'refuse' });
});

test('planDiscard 未知工具但 oldText 非空 → revert-text（有锚点，安全）', () => {
  const rec: ModificationRecord = {
    callId: 'c-u2',
    path: '/proj/a.ts',
    oldText: 'x',
    newText: 'y',
    line: 1,
    lineCount: 1,
    ts: 0,
  };
  assert.deepEqual(planDiscard(rec), { kind: 'revert-text' });
});

test('recordsFromDiffs 透传 tool 到记录', () => {
  const input: AppliedDiffInput = {
    path: 'src/a.ts',
    cwd: '/proj',
    diffs: [{ oldText: 'x', newText: 'y' }],
    callId: 'c-1',
    tool: 'edit',
  };
  assert.equal(recordsFromDiffs(input, '/proj')[0].tool, 'edit');
});

test('locateNewText 兼容 CRLF/LF：LF 片段在 CRLF 文件里也能定位', () => {
  // 磁盘文件 CRLF，DSH 侧片段 LF → 原 indexOf 失败，归一后命中第 3 行
  const content = 'a\r\nb\r\nconst x = 2\r\nc\r\n';
  const loc = locateNewText(content, 'const x = 2');
  assert.ok(loc !== null);
  assert.equal(loc.line, 3);
  assert.equal(loc.startOffset, content.indexOf('const x = 2'));
});

test('locateNewText 兼容 CRLF/LF：多行片段换行差异', () => {
  const content = 'l1\r\nl2\r\nl3\r\n';
  const loc = locateNewText(content, 'l1\nl2\nl3');
  assert.ok(loc !== null);
  assert.equal(loc.line, 1);
});

test('locateOldText 兼容 CRLF/LF', () => {
  const content = 'x\r\ny\r\nz\r\n';
  const loc = locateOldText(content, 'y');
  assert.ok(loc !== null);
  assert.equal(loc.line, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// decorationTargetLine：定位不到就返回 null（真机缺陷回归）
// 缺陷现象：恢复出来的 write 新建记录 line 是占位值 1，applyDecoration 回退到 rec.line
// → 用户改过文件后，整份文件从第 1 行起被标成"新增"（错误的整片高亮）。
// ─────────────────────────────────────────────────────────────────────────────

test('decorationTargetLine 命中 → 返回 1-based 行号', () => {
  const content = 'l1\nl2\nconst x = 2\nl4\n';
  assert.equal(decorationTargetLine(content, 'const x = 2'), 3);
});

test('decorationTargetLine newText 已不在文档中 → null（不误标，不回退占位行）', () => {
  // 记录来自 write 新建（newText = 当时整份内容），用户后来改了文件 → 定位不到
  const content = '用户改过的全新内容\n第二行\n';
  assert.equal(decorationTargetLine(content, '# 原始标题\n\n原始正文\n'), null);
});

test('decorationTargetLine newText 为空 → null（无锚点不落高亮）', () => {
  assert.equal(decorationTargetLine('a\nb\n', ''), null);
});

test('decorationTargetLine 兼容 CRLF/LF：LF 片段在 CRLF 文档里可定位', () => {
  assert.equal(decorationTargetLine('a\r\nconst x = 2\r\n', 'const x = 2'), 2);
});

test('decorationTargetLine 入参非字符串 → null（防御）', () => {
  assert.equal(decorationTargetLine(undefined as unknown as string, 'x'), null);
  assert.equal(decorationTargetLine('x', undefined as unknown as string), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// snapMarksToContent：删除标记落在空行上 → 吸附到 hunk 内有内容的行
// 真机缺陷：删除文件末尾的段落时，del 投影锚点落在结尾空行，而 VS Code 对空行的
// 背景装饰几乎不可见 → 用户看到"这次删除完全没有高亮"。
// ─────────────────────────────────────────────────────────────────────────────

test('snapMarksToContent 非空行的标记原样保留', () => {
  const marks = [{ line: 2, kind: 'del' as const }];
  assert.deepEqual(snapMarksToContent('a\nb\nc\n', marks, 1), marks);
});

test('snapMarksToContent 空行标记向上吸附到最近的有内容行（真机用例）', () => {
  // 真机：newText="\n## 关键判别标准\n\n" → del 锚点落在结尾空行，应吸附到标题行
  const content = 'l1\nl2\n\n## 关键判别标准\n\n\n\n';
  const out = snapMarksToContent(content, [{ line: 7, kind: 'del' as const }], 3);
  assert.equal(out.length, 1);
  assert.equal(content.split('\n')[out[0]!.line - 1], '## 关键判别标准');
  assert.equal(out[0]!.kind, 'del');
});

test('snapMarksToContent 不越过 hunk 下界（floorLine）', () => {
  // floor=3：第 3、4 行都是空行 → 不得吸到第 1 行（越出 hunk），保持原样
  const out = snapMarksToContent('x\n\n\n\n', [{ line: 4, kind: 'del' as const }], 3);
  assert.equal(out[0]!.line, 4);
});

test('snapMarksToContent hunk 内全空行 → 保持原样（不乱标）', () => {
  const out = snapMarksToContent('x\n\n\n', [{ line: 3, kind: 'del' as const }], 2);
  assert.equal(out[0]!.line, 3);
});

test('snapMarksToContent 空内容 / 空标记数组 → 安全返回', () => {
  assert.deepEqual(snapMarksToContent('', [{ line: 1, kind: 'del' }], 1), [{ line: 1, kind: 'del' }]);
  assert.deepEqual(snapMarksToContent('a\n', [], 1), []);
});

test('snapMarksToContent CRLF 文档里的空行也认得出来', () => {
  const content = 'a\r\n\r\n标题\r\n';
  const out = snapMarksToContent(content, [{ line: 2, kind: 'del' as const }], 1);
  assert.equal(out[0]!.line, 1); // 第 2 行是空行 → 吸到第 1 行
});

// ─────────────────────────────────────────────────────────────────────────────
// hover 文案分型：DSH 新增 / DSH 修改 / DSH 删除
// ─────────────────────────────────────────────────────────────────────────────

test('diffNature 纯新增 → add（DSH 新增）', () => {
  assert.equal(diffNature('', 'a\nb'), 'add');
  assert.equal(diffNature('a', 'a\nNEW'), 'add'); // 尾部追加
  assert.equal(diffNature('a\nb', 'a\nNEW\nb'), 'add'); // 中间插入
});

test('diffNature 纯删除 → del（DSH 删除）', () => {
  assert.equal(diffNature('a\nb', 'a'), 'del'); // 尾部删除
  assert.equal(diffNature('a\nb\nc', 'a\nc'), 'del'); // 中间删除
});

test('diffNature 有增有删 → modify（DSH 修改）', () => {
  assert.equal(diffNature('x', 'y'), 'modify');
  assert.equal(diffNature('a\nOLD\nb', 'a\nNEW\nb'), 'modify');
});

test('summarizeDiff 统计增删行数', () => {
  assert.deepEqual(summarizeDiff('a\nOLD\nb', 'a\nNEW\nb'), { added: 1, deleted: 1 });
  assert.deepEqual(summarizeDiff('a', 'a\nN1\nN2'), { added: 2, deleted: 0 });
  assert.deepEqual(summarizeDiff('a\nD1\nD2', 'a'), { added: 0, deleted: 2 });
});

test('deletedLines / addedLines 取出对应行文本', () => {
  assert.deepEqual(deletedLines('a\nOLD\nb', 'a\nb'), ['OLD']);
  assert.deepEqual(addedLines('a\nb', 'a\nNEW\nb'), ['NEW']);
  assert.deepEqual(deletedLines('a\nb', 'a\nb'), []); // 无变化
  assert.deepEqual(addedLines('', 'l1\nl2'), ['l1', 'l2']); // write 新建
});

// ─────────────────────────────────────────────────────────────────────────────
// CRLF 撤销区间：currentText 必须取文件实际片段（否则残留尾部字符）
// ─────────────────────────────────────────────────────────────────────────────

test('buildRevertEdit CRLF 文件多行插入还原：区间长度按文件实际片段，不留残字', () => {
  const record: ModificationRecord = {
    callId: 'c-crlf',
    path: '/p/a.md',
    oldText: 'B',
    newText: 'A\nB',
    line: 1,
    lineCount: 2,
    ts: 0,
    tool: 'edit',
  };
  const content = 'X\r\nA\r\nB\r\nY\r\n'; // 文件 CRLF，newText 为 LF
  const edit = buildRevertEdit(content, record);
  assert.ok(edit !== null);
  assert.equal(edit.currentText, 'A\r\nB'); // 文件实际片段（含 \r）
  assert.equal(edit.startOffset, content.indexOf('A\r\nB'));
  const result = content.slice(0, edit.startOffset) + edit.replacement + content.slice(edit.startOffset + edit.currentText.length);
  assert.equal(result, 'X\r\nB\r\nY\r\n'); // 若区间短 1 字符会残留 'B' 尾巴
});

test('buildRevertEdit 还原文本换行风格对齐文件（CRLF 文件不混入裸 LF）', () => {
  const record: ModificationRecord = {
    callId: 'c-crlf2',
    path: '/p/a.md',
    oldText: 'O1\nO2',
    newText: 'N',
    line: 1,
    lineCount: 1,
    ts: 0,
    tool: 'edit',
  };
  const edit = buildRevertEdit('N\r\n', record);
  assert.ok(edit !== null);
  assert.equal(edit.replacement, 'O1\r\nO2');
});

test('buildRevertEdit LF 文件保持 LF（不对齐成 CRLF）', () => {
  const record: ModificationRecord = {
    callId: 'c-lf',
    path: '/p/a.md',
    oldText: 'O1\nO2',
    newText: 'N',
    line: 1,
    lineCount: 1,
    ts: 0,
    tool: 'edit',
  };
  const edit = buildRevertEdit('N\n', record);
  assert.ok(edit !== null);
  assert.equal(edit.replacement, 'O1\nO2');
});

// ─────────────────────────────────────────────────────────────────────────────
// write 新建删除前置校验：文件是否仍等于 DSH 写入内容
// ─────────────────────────────────────────────────────────────────────────────

test('writtenContentMatches 完全相同 → true', () => {
  assert.equal(writtenContentMatches('a\nb\n', 'a\nb\n'), true);
});

test('writtenContentMatches 只容忍换行风格差异（CRLF/LF）', () => {
  assert.equal(writtenContentMatches('a\r\nb', 'a\nb'), true);   // 仅换行风格不同
  assert.equal(writtenContentMatches('a\nb\n\n', 'a\nb'), false); // 末尾多空行 = 用户编辑过
});

test('writtenContentMatches 用户追加/修改内容 → false（应走删除确认）', () => {
  assert.equal(writtenContentMatches('a\nb\nmy note\n', 'a\nb'), false);
  assert.equal(writtenContentMatches('a\nB\n', 'a\nb'), false);
  assert.equal(writtenContentMatches('', 'a\nb'), false); // 文件被清空
  assert.equal(writtenContentMatches('anything', ''), false); // 写入内容为空：一律不匹配
});

// ─────────────────────────────────────────────────────────────────────────────
// 「丢弃 DSH 内容、保留我的新增」：只在纯追加时可拆分
// ─────────────────────────────────────────────────────────────────────────────

test('userAppendedPart 纯追加（含 CRLF 差异）→ 返回用户追加部分', () => {
  const written = 'a\nb';
  assert.equal(userAppendedPart('a\nb\nmy note\n', written), 'my note\n');
  assert.equal(userAppendedPart('a\r\nb\r\nmy note\r\n', written), 'my note\r\n');
  assert.equal(userAppendedPart('a\nb\n\n\nmy note', written), 'my note'); // 衔接处多余空行被吃掉
});

test('userAppendedPart 用户改动了 DSH 原文（非纯追加）→ null', () => {
  assert.equal(userAppendedPart('a\nB\nmy note', 'a\nb'), null); // 中间被改
  assert.equal(userAppendedPart('prefix\na\nb\nnote', 'a\nb'), null); // 前面被插内容
});

test('userAppendedPart 无追加 / 仅空白 → null', () => {
  assert.equal(userAppendedPart('a\nb', 'a\nb'), null);
  assert.equal(userAppendedPart('a\nb\n\n', 'a\nb'), null);
  assert.equal(userAppendedPart('a\nb', ''), null); // 写入内容为空：不可拆分
});

// ─────────────────────────────────────────────────────────────────────────────
// 同行 add+del 合并为 modify（避免红绿装饰互相覆盖，只剩红色）
// ─────────────────────────────────────────────────────────────────────────────

test('mergeLineMarks 同行 add+del → 单条 modify', () => {
  assert.deepEqual(mergeLineMarks([{ line: 5, kind: 'del' }, { line: 5, kind: 'add' }]), [
    { line: 5, kind: 'modify' },
  ]);
});

test('mergeLineMarks 仅 add / 仅 del 保持原样', () => {
  assert.deepEqual(mergeLineMarks([{ line: 3, kind: 'add' }]), [{ line: 3, kind: 'add' }]);
  assert.deepEqual(mergeLineMarks([{ line: 4, kind: 'del' }]), [{ line: 4, kind: 'del' }]);
});

test('mergeLineMarks 多行混合：逐行判定并按行号升序', () => {
  const merged = mergeLineMarks([
    { line: 7, kind: 'add' },
    { line: 6, kind: 'del' },
    { line: 7, kind: 'del' },
    { line: 8, kind: 'add' },
  ]);
  assert.deepEqual(merged, [
    { line: 6, kind: 'del' },
    { line: 7, kind: 'modify' },
    { line: 8, kind: 'add' },
  ]);
});

test('writtenContentMatches 末尾按回车（纯换行）也算被改动 → 不静默删除', () => {
  assert.equal(writtenContentMatches('a\nb\n', 'a\nb'), false); // 末尾多一个回车
  assert.equal(writtenContentMatches('a\nb\r\n', 'a\nb'), false); // CRLF 的末尾回车同样算
});

test('writtenContentMatches 仅换行风格不同（CRLF vs LF）仍视为未改动', () => {
  assert.equal(writtenContentMatches('a\r\nb', 'a\nb'), true);
});
