// test/selection/selection-thread.test.ts — F10 选区线程生命周期单测（工厂全部注入）
//
// **2026-09-17 语义变更**：线程从"选区一变就自动挂"改为**按需创建**
// （用户要求去掉行号左侧那个常驻按钮；点 ✨ Quick Edit 才建线程并展开）。
// 因此这里的核心断言变成：选区变化**只清不建**；只有 openForCurrentSelection() 才创建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionThreadController } from '../../src/selection/selection-thread';

/** 假编辑器：只暴露线程控制器需要的字段 */
function fakeEditor(lines: string[], sel: { start: [number, number]; end: [number, number] }, path = 'D:/w/a.ts') {
  const text = lines.join('\n');
  return {
    document: {
      uri: { fsPath: path },
      getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
        if (range === undefined) return text;
        // 简化实现：按行切片（足够覆盖这些测试的选区形态）
        const slice = lines.slice(range.start.line, range.end.line + 1);
        if (slice.length === 0) return '';
        slice[0] = (slice[0] as string).slice(range.start.character);
        if (range.end.line - range.start.line === 0) return (slice[0] as string).slice(0, range.end.character - range.start.character);
        const last = slice.length - 1;
        slice[last] = (slice[last] as string).slice(0, range.end.character);
        return slice.join('\n');
      },
    },
    selection: { start: { line: sel.start[0], character: sel.start[1] }, end: { line: sel.end[0], character: sel.end[1] } },
  } as unknown as Parameters<SelectionThreadController['infoOf']>[0];
}

/** 组装控制器 + 可观察记录；编辑器可变，便于模拟选区变化 */
function makeController(opts: { enabled?: boolean; lines?: string[]; suppressed?: () => boolean } = {}) {
  const lines = opts.lines ?? ['l1', 'l2', 'l3', 'l4', 'l5'];
  let editor = fakeEditor(lines, { start: [1, 0], end: [3, 0] }) as unknown as ReturnType<
    Parameters<SelectionThreadController['infoOf']>[0] extends never ? never : () => never
  >;
  const created: Array<{ range: { start: { line: number }; end: { line: number } } }> = [];
  const disposed: unknown[] = [];
  const expanded: unknown[] = [];
  const logs: string[] = [];
  const controller = new SelectionThreadController({
    activeEditor: () => editor as never,
    // 注入假构造器：单测不需要 vscode 运行时（stub 里没有 Range/MarkdownString）
    uri: (path) => ({ fsPath: path }) as never,
    range: (startLine0, endLine0) => ({ start: { line: startLine0 }, end: { line: endLine0 } }) as never,
    markdown: (text) => ({ value: text }) as never,
    createThread: (uri, range, body) => {
      const thread = { uri, range, body };
      created.push(thread as never);
      return thread;
    },
    disposeThread: (t) => disposed.push(t),
    expandThread: (t) => expanded.push(t),
    enabled: () => opts.enabled ?? true,
    suppressed: () => opts.suppressed?.() ?? false,
    log: (m) => logs.push(m),
  });
  return {
    controller,
    created,
    disposed,
    expanded,
    logs,
    setEditor: (next: unknown | undefined) => {
      editor = next as never;
    },
    lines,
  };
}

test('选区变化只清不建：不再随选区自动挂线程（本次语义变更的核心）', () => {
  const { controller, created } = makeController();
  controller.onSelectionChanged();
  controller.onSelectionChanged();
  assert.equal(created.length, 0, '选区变化不应创建线程（否则行号左侧会常驻按钮）');
  assert.equal(controller.hasThread(), false);
});

test('按需创建：openForCurrentSelection 建线程，行范围 0-based 且覆盖末行', () => {
  const { controller, created, expanded } = makeController();
  const thread = controller.openForCurrentSelection();
  assert.ok(thread !== undefined);
  assert.equal(created.length, 1);
  // 选区 0-based [1,0]→[3,0]：终点落在第 3 行的第 0 列，即"只选到第 2 行末尾"，
  // 因此被选中的行是 1-based 2..3 → Range 取 0-based 1..2（不含末尾零宽那一行）
  assert.deepEqual(created[0]?.range, { start: { line: 1 }, end: { line: 2 } });
  assert.equal(expanded.length, 1, '按需创建时应当直接展开（让输入框亮出来）');
});

test('同选区重复 open → 复用不重建（避免闪烁），但仍会确保展开', () => {
  const { controller, created, expanded } = makeController();
  controller.openForCurrentSelection();
  controller.openForCurrentSelection();
  controller.openForCurrentSelection();
  assert.equal(created.length, 1, '同一选区只应有一个线程');
  assert.equal(expanded.length, 3, '每次调用都确保处于展开态');
});

test('选区变化 → 旧线程被释放（线程不会堆在错误的位置上）', () => {
  const { controller, created, disposed } = makeController();
  controller.openForCurrentSelection();
  assert.equal(created.length, 1);
  controller.onSelectionChanged();
  assert.equal(disposed.length, 1, '旧线程必须被释放');
  assert.equal(controller.hasThread(), false);
});

test('零长度选区（只是点了一下）→ open 返回 undefined，不建线程', () => {
  const { controller, created, setEditor, lines } = makeController();
  setEditor(fakeEditor(lines, { start: [2, 1], end: [2, 1] }));
  assert.equal(controller.openForCurrentSelection(), undefined);
  assert.equal(created.length, 0);
});

test('没有活动编辑器（失焦/关闭）→ open 返回 undefined', () => {
  const { controller, created, setEditor } = makeController();
  setEditor(undefined);
  assert.equal(controller.openForCurrentSelection(), undefined);
  assert.equal(created.length, 0);
});

test('设置关闭 → open 返回 undefined（dsh.selection.threads.enabled=false，上层退化为 InputBox）', () => {
  const { controller, created } = makeController({ enabled: false });
  assert.equal(controller.openForCurrentSelection(), undefined);
  assert.equal(created.length, 0);
});

test('纯空白选区 → open 返回 undefined', () => {
  const { controller, created, setEditor } = makeController({ lines: ['    ', '   '] });
  setEditor(fakeEditor(['    ', '   '], { start: [0, 0], end: [1, 3] }));
  assert.equal(controller.openForCurrentSelection(), undefined);
  assert.equal(created.length, 0);
});

test('程序化选区静音窗内 → open 返回 undefined（点卡片路径跳行不该冒出线程）', () => {
  let muted = true;
  const { controller, created } = makeController({ suppressed: () => muted });
  assert.equal(controller.openForCurrentSelection(), undefined, '静音期间不应创建线程');
  muted = false;
  assert.ok(controller.openForCurrentSelection() !== undefined, '静音结束后可正常按需创建');
  assert.equal(created.length, 1);
});

test('静音窗内选区变化会清掉旧线程（光标已经跳走，线程留着就是错位）', () => {
  let muted = false;
  const { controller, created, disposed } = makeController({ suppressed: () => muted });
  controller.openForCurrentSelection();
  assert.equal(created.length, 1);
  muted = true;
  controller.onSelectionChanged();
  assert.equal(disposed.length, 1, '旧线程必须被清掉');
  assert.equal(controller.hasThread(), false);
});

test('clear / dispose 清掉线程且幂等', () => {
  const { controller, disposed } = makeController();
  controller.openForCurrentSelection();
  controller.clear();
  controller.clear(); // 幂等：不重复 dispose
  assert.equal(disposed.length, 1);
  assert.equal(controller.currentThread(), undefined);
  assert.equal(controller.hasThread(), false);

  controller.openForCurrentSelection();
  controller.dispose();
  assert.equal(controller.hasThread(), false);
});
