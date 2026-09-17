// test/bridge/diff-service-recording.test.ts — 变更集总开关（dsh.changes.enabled）的门控单测
//
// 覆盖 T8.5 新增的粗粒度开关：`DiffService` 的 record / adoptFromBook 在开关关闭时**整体早退**。
// 为什么值得单测：这是唯一一处"关闭后仍可能偷偷读文件、写账本"的入口——
// 一旦失效，用户会看到"我已经关掉了，但每个 edit 还在读文件、账本还在涨"，
// 而这种问题在真机上很难被发现（界面上什么都没显示，行为却已经发生）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffService } from '../../src/bridge/diff-service';
import { ChangeBook, type ChangeRecord } from '../../src/bridge/change-book';

// 说明：这里只走门控的早退分支，不触碰真实的装饰/编辑器 API，
// 因此依赖面用 `as never` 的极简桩即可（真正的装饰行为由 diff-tracker 的单测覆盖）。

/** 组装 DiffService；readFileText 计数用于断言"关闭时一次都没读盘" */
function makeService(opts: { enabled: boolean; book: ChangeBook }) {
  let reads = 0;
  const svc = new DiffService({
    // visibleTextEditors 必须存在：record 在"开启"分支会去找编辑器补高亮（对照组会走到那里）
    window: { visibleTextEditors: [] } as never,
    workspace: {} as never,
    languages: {} as never,
    commands: {} as never,
    Uri: { file: (p: string) => ({ fsPath: p }) } as never,
    Position: class {} as never,
    Range: class {} as never,
    WorkspaceEdit: class {} as never,
    MarkdownString: class {} as never,
    Hover: class {} as never,
    readFileText: async () => {
      reads += 1;
      return 'l1\nl2\nl3\n';
    },
    workspaceRoot: 'D:/w',
    book: opts.book,
    recordingEnabled: () => opts.enabled,
    log: () => undefined,
  });
  return { svc, reads: () => reads };
}

const INPUT = { path: 'D:/w/a.ts', callId: 'c1', diffs: [{ oldText: 'l1', newText: 'l1x' }] };

function recordOf(callId: string): ChangeRecord {
  return {
    callId,
    sessionId: 's1',
    turn: 0,
    tool: 'edit',
    path: 'D:/w/a.ts',
    absPath: 'D:/w/a.ts',
    oldText: 'l1',
    newText: 'l1x',
    time: 1000,
    source: 'replay',
    fileHashAtRecord: 'h',
  };
}

test('变更集关闭：record 不读文件、不入栈、不写账本', async () => {
  const book = new ChangeBook();
  const { svc, reads } = makeService({ enabled: false, book });
  await svc.record(INPUT);
  assert.equal(reads(), 0, '关闭后不应读盘（省掉整条链路的开销）');
  assert.equal(svc.recordCount(), 0, '关闭后不应入栈');
  assert.equal(book.count(), 0, '关闭后不应写账本');
});

test('变更集关闭：adoptFromBook 不把账本灌回修改栈（否则 Reload 后凭空出现高亮）', () => {
  const book = new ChangeBook();
  const { svc } = makeService({ enabled: false, book });
  assert.equal(svc.adoptFromBook([recordOf('c1')]), 0);
  assert.equal(svc.recordCount(), 0);
});

test('变更集开启：同一次上报正常入栈并记账（对照组，防止门控写反成"永远关闭"）', async () => {
  const book = new ChangeBook();
  const { svc, reads } = makeService({ enabled: true, book });
  await svc.record(INPUT);
  assert.equal(reads(), 1, '开启时应读盘定位');
  assert.equal(svc.recordCount(), 1, '开启时应入栈');
  assert.equal(book.count(), 1, '开启时应写账本');
});

test('变更集开启：adoptFromBook 正常采纳', () => {
  const book = new ChangeBook();
  const { svc } = makeService({ enabled: true, book });
  assert.equal(svc.adoptFromBook([recordOf('c1')]), 1);
  assert.equal(svc.recordCount(), 1);
});

test('未注入 recordingEnabled 时默认开启（既有调用方与测试不受影响）', async () => {
  const book = new ChangeBook();
  const svc = new DiffService({
    // visibleTextEditors 必须存在：record 在"开启"分支会去找编辑器补高亮（对照组会走到那里）
    window: { visibleTextEditors: [] } as never,
    workspace: {} as never,
    languages: {} as never,
    commands: {} as never,
    Uri: { file: (p: string) => ({ fsPath: p }) } as never,
    Position: class {} as never,
    Range: class {} as never,
    WorkspaceEdit: class {} as never,
    MarkdownString: class {} as never,
    Hover: class {} as never,
    readFileText: async () => 'l1\nl2\nl3\n',
    workspaceRoot: 'D:/w',
    book,
    log: () => undefined,
  });
  await svc.record(INPUT);
  assert.equal(book.count(), 1);
});

test('clearAllRecords：清空栈与高亮（返回清掉的条数）', async () => {
  const book = new ChangeBook();
  const { svc } = makeService({ enabled: true, book });
  await svc.record(INPUT);
  assert.equal(svc.recordCount(), 1);
  assert.equal(svc.clearAllRecords(), 1);
  assert.equal(svc.recordCount(), 0);
});
