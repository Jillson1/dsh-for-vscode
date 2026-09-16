// test/selection/selection-thread.test.ts — F10 线程生命周期单测（防抖时钟与工厂全部注入）
// 覆盖：防抖、同选区不重建、选区取消/失焦即清理、开关关闭不挂、空白选区不挂。
// 这些规则决定了"会不会到处堆线程"——Comments 线程不会自动消失，必须我们自己收。
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
function makeController(
  opts: { enabled?: boolean; debounceMs?: number; lines?: string[]; suppressed?: () => boolean } = {},
) {
  const lines = opts.lines ?? ['l1', 'l2', 'l3', 'l4', 'l5'];
  let editor = fakeEditor(lines, { start: [1, 0], end: [3, 0] }) as unknown as ReturnType<
    Parameters<SelectionThreadController['infoOf']>[0] extends never ? never : () => never
  >;
  const created: unknown[] = [];
  const disposed: unknown[] = [];
  const logs: string[] = [];
  const controller = new SelectionThreadController({
    activeEditor: () => editor as never,
    // 注入假构造器：单测不需要 vscode 运行时（stub 里没有 Range/MarkdownString）
    uri: (path) => ({ fsPath: path }) as never,
    range: (startLine0, endLine0) => ({ start: { line: startLine0 }, end: { line: endLine0 } }) as never,
    markdown: (text) => ({ value: text }) as never,
    createThread: (uri, range, body) => {
      const thread = { uri, range, body };
      created.push(thread);
      return thread;
    },
    disposeThread: (t) => disposed.push(t),
    enabled: () => opts.enabled ?? true,
    suppressed: () => opts.suppressed?.() ?? false,
    debounceMs: opts.debounceMs ?? 0,
    log: (m) => logs.push(m),
  });
  return {
    controller,
    created,
    disposed,
    logs,
    setEditor: (next: unknown | undefined) => {
      editor = next as never;
    },
    lines,
  };
}

test('有效选区 → 挂一个线程（行范围 0-based 且覆盖末行）', () => {
  const { controller, created } = makeController();
  controller.apply();
  assert.equal(created.length, 1);
  const thread = created[0] as { range: { start: { line: number }; end: { line: number } }; body: { value: string } };
  assert.equal(thread.range.start.line, 1); // 第 2 行 → 0-based 1
  assert.equal(thread.range.end.line, 2); // 第 3 行 → 0-based 2
  assert.match(thread.body.value, /选中 2 行/);
  assert.equal(controller.hasThread(), true);
});

test('同选区同文本重复 apply → 不重建（避免闪烁与滚动跳动）', () => {
  const { controller, created, disposed } = makeController();
  controller.apply();
  controller.apply();
  controller.apply();
  assert.equal(created.length, 1);
  assert.equal(disposed.length, 0);
});

test('选区变化 → 旧线程被释放、新线程建立（单线程复用，不堆积）', () => {
  const { controller, created, disposed, setEditor, lines } = makeController();
  controller.apply();
  // 换成第 4-5 行的选区
  setEditor(fakeEditor(lines, { start: [3, 0], end: [5, 0] }));
  controller.apply();
  assert.equal(created.length, 2);
  assert.equal(disposed.length, 1, '旧线程必须被释放');
  assert.equal(controller.hasThread(), true);
});

test('零长度选区（只是点了一下）→ 清掉线程，不打扰', () => {
  const { controller, created, disposed, setEditor, lines } = makeController();
  controller.apply();
  setEditor(fakeEditor(lines, { start: [2, 3], end: [2, 3] }));
  controller.apply();
  assert.equal(created.length, 1, '不该为光标位置新建线程');
  assert.equal(disposed.length, 1);
  assert.equal(controller.hasThread(), false);
});

test('没有活动编辑器（失焦/关闭）→ 清线程', () => {
  const { controller, disposed, setEditor } = makeController();
  controller.apply();
  setEditor(undefined);
  controller.apply();
  assert.equal(disposed.length, 1);
  assert.equal(controller.hasThread(), false);
});

test('设置关闭 → 不挂线程（dsh.selection.threads.enabled=false）', () => {
  const { controller, created } = makeController({ enabled: false });
  controller.apply();
  assert.equal(created.length, 0);
  assert.equal(controller.hasThread(), false);
});

test('纯空白选区 → 不挂线程', () => {
  const { controller, created } = makeController({ lines: ['    ', '   '] });
  controller.apply();
  assert.equal(created.length, 0);
});

test('onSelectionChanged 走防抖：连续调用只应用一次；dispose 清掉定时器', async () => {
  const { controller, created } = makeController({ debounceMs: 5 });
  controller.onSelectionChanged();
  controller.onSelectionChanged();
  controller.onSelectionChanged();
  assert.equal(created.length, 0, '防抖期间不应立即建立');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created.length, 1, '只有最后一次生效');

  controller.onSelectionChanged();
  controller.dispose(); // 释放后定时器不应再触发
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created.length, 1);
});

test('程序化选区静音窗内：不建线程（跳行定位不该冒出评论线程）', () => {
  let muted = true;
  const { controller, created } = makeController({ suppressed: () => muted });
  controller.apply();
  assert.equal(created.length, 0, '静音期间不应新建线程');
  // 静音结束（用户自己选）→ 正常挂线程
  muted = false;
  controller.apply();
  assert.equal(created.length, 1);
});

test('静音窗内会清掉旧线程（光标已经跳走，线程留着就是错位）', () => {
  let muted = false;
  const { controller, created, disposed } = makeController({ suppressed: () => muted });
  controller.apply();
  assert.equal(created.length, 1);
  muted = true;
  controller.apply();
  assert.equal(disposed.length, 1, '旧线程必须被清掉');
  assert.equal(controller.hasThread(), false);
});

test('currentThread：供"Quick Edit 按钮展开线程"取到活动线程', () => {
  const { controller } = makeController();
  assert.equal(controller.currentThread(), undefined);
  controller.apply();
  assert.ok(controller.currentThread() !== undefined);
});
