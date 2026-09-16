// test/bridge/change-book.test.ts — F1 变更账本单测
// 覆盖：增删/去重/覆盖/裁剪、持久化（序列化 → 反序列化 → 恢复）、坏数据拒绝、
// stale 判定、keep/keepAll/clearFile/removeByCallId、onChange 订阅、revert 委托。
// 账本刻意不 import vscode（Memento / executor 都是注入接口），因此可直接用 node:test 验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChangeBook,
  CHANGE_BOOK_KEY,
  MAX_RECORDS_PER_SESSION,
  contentHash,
  isStale,
  type ChangeRecord,
  type MementoLike,
  type RevertOutcome,
} from '../../src/bridge/change-book';

/** 内存 Memento（VS Code workspaceState 的结构替身） */
function memMemento(initial?: unknown): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set(CHANGE_BOOK_KEY, initial);
  return {
    store,
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    update(key: string, value: unknown): void {
      store.set(key, value);
    },
  };
}

/** 一条最小可用的记录输入 */
function input(over: Partial<Parameters<ChangeBook['add']>[0]> = {}) {
  return {
    callId: 'c1',
    sessionId: 's1',
    absPath: 'D:/w/src/a.ts',
    oldText: 'x',
    newText: 'y',
    tool: 'edit',
    ...over,
  };
}

test('add / records / latest / files / count 基本语义', () => {
  const book = new ChangeBook();
  // 时间显式化：latest 取的是"记录时间最新"，用真实 Date.now() 会让断言依赖执行顺序
  assert.equal(book.add(input({ time: 1000 })), true);
  assert.equal(book.add(input({ callId: 'c2', absPath: 'D:/w/src/b.ts', time: 2000 })), true);
  assert.equal(book.count(), 2);
  assert.equal(book.count('s1'), 2);
  assert.deepEqual(book.sessions(), ['s1']);
  assert.deepEqual(book.files('s1'), ['D:/w/src/a.ts', 'D:/w/src/b.ts']);
  // 按文件过滤
  assert.equal(book.records('s1', 'D:/w/src/a.ts').length, 1);
  // latest 取全局最新（按 time，而非插入顺序）
  assert.equal(book.latest('s1')?.callId, 'c2');
  // 反过来再补一条更早的：latest 仍应是 c2
  book.add(input({ callId: 'c0', absPath: 'D:/w/src/z.ts', time: 500 }));
  assert.equal(book.latest('s1')?.callId, 'c2');
  // 未知会话返回空
  assert.deepEqual(book.records('nope'), []);
  assert.equal(book.latest('nope'), undefined);
});

test('同 callId 覆盖（不是新增），字段以最后一次为准', () => {
  const book = new ChangeBook();
  assert.equal(book.add(input({ newText: 'first' })), true);
  // 覆盖：同 session + 同 callId
  assert.equal(book.add(input({ newText: 'second', tool: 'write' })), false);
  const recs = book.records('s1');
  assert.equal(recs.length, 1, '同 callId 不应产生第二条记录');
  assert.equal(recs[0]?.newText, 'second');
  assert.equal(recs[0]?.tool, 'write');
});

test('会话 id 缺失 → 落到 local 兜底桶；callId / absPath 为空则拒绝入库', () => {
  const book = new ChangeBook();
  book.add(input({ sessionId: undefined }));
  assert.deepEqual(book.sessions(), ['local']);
  assert.equal(book.add(input({ callId: '' })), false);
  assert.equal(book.add(input({ callId: 'c9', absPath: '' })), false);
  assert.equal(book.count(), 1);
});

test('工具名归一：edit/write 保留，其余记为 unknown', () => {
  const book = new ChangeBook();
  book.add(input({ callId: 'c1', tool: 'edit' }));
  book.add(input({ callId: 'c2', tool: 'write' }));
  book.add(input({ callId: 'c3', tool: 'multi-edit' }));
  book.add(input({ callId: 'c4', tool: undefined }));
  assert.deepEqual(
    book.records('s1').map((r) => r.tool),
    ['edit', 'write', 'unknown', 'unknown'],
  );
});

test('单会话超限按 time 裁剪最旧（账本不会无限膨胀）', () => {
  const book = new ChangeBook();
  for (let i = 0; i < MAX_RECORDS_PER_SESSION + 5; i += 1) {
    book.add(input({ callId: `c${i}`, time: 1000 + i }));
  }
  const recs = book.records('s1');
  assert.equal(recs.length, MAX_RECORDS_PER_SESSION);
  // 最旧的 5 条被裁掉
  assert.equal(recs[0]?.callId, 'c5');
  assert.equal(recs[recs.length - 1]?.callId, `c${MAX_RECORDS_PER_SESSION + 4}`);
});

test('keep / keepAll / clearFile / removeByCallId', () => {
  const book = new ChangeBook();
  book.add(input({ callId: 'c1', absPath: 'D:/w/src/a.ts' }));
  book.add(input({ callId: 'c2', absPath: 'D:/w/src/a.ts' }));
  book.add(input({ callId: 'c3', absPath: 'D:/w/src/b.ts' }));
  book.add(input({ callId: 'c4', sessionId: 's2', absPath: 'D:/w/src/c.ts' }));

  assert.equal(book.keep('s1', 'c1'), true);
  assert.equal(book.keep('s1', 'nope'), false);
  assert.equal(book.count('s1'), 2);

  // 按文件批量保留
  assert.equal(book.keepAll('s1', 'D:/w/src/a.ts'), 1);
  assert.equal(book.count('s1'), 1);

  // clearFile 等同对该文件逐条 keep
  book.add(input({ callId: 'c5', absPath: 'D:/w/src/b.ts' }));
  assert.equal(book.clearFile('s1', 'D:/w/src/b.ts'), 2);
  assert.equal(book.count('s1'), 0);
  // 空会话会被清理掉（不留空桶）
  assert.deepEqual(book.sessions(), ['s2']);

  // 跨会话按 callId 移除（DiffService 只有 callId 时的入口）
  assert.equal(book.removeByCallId('c4'), true);
  assert.equal(book.removeByCallId('c4'), false);
  assert.equal(book.count(), 0);
});

test('持久化：写入 memento → 新实例恢复（含字段完整性与分组）', () => {
  const memento = memMemento();
  const first = new ChangeBook(memento);
  first.add(input({ callId: 'c1', turn: 3, source: 'replay', fileHashAtRecord: 'abc', path: 'src/a.ts', time: 111 }));
  first.add(input({ callId: 'c2', sessionId: 's2', absPath: 'D:/w/src/b.ts', tool: 'write', time: 222 }));

  // 持久化形状：{ version: 1, sessions: { id: { pathKey: records[] } } }
  const raw = memento.store.get(CHANGE_BOOK_KEY) as { version: number; sessions: Record<string, unknown> };
  assert.equal(raw.version, 1);
  assert.deepEqual(Object.keys(raw.sessions).sort(), ['s1', 's2']);

  // 新实例（模拟 Reload）恢复
  const restored = new ChangeBook(memento);
  assert.deepEqual(restored.sessions(), ['s1', 's2']);
  const rec = restored.records('s1')[0] as ChangeRecord;
  assert.equal(rec.callId, 'c1');
  assert.equal(rec.turn, 3);
  assert.equal(rec.source, 'replay');
  assert.equal(rec.fileHashAtRecord, 'abc');
  assert.equal(rec.path, 'src/a.ts');
  assert.equal(rec.absPath, 'D:/w/src/a.ts');
  assert.equal(rec.time, 111);
  assert.equal(restored.count(), 2);
});

test('坏数据拒绝：版本不符 / 形状异常 / 单条缺必填 —— 整块丢弃而不是半信半疑地读', () => {
  // 版本不符
  const wrongVersion = memMemento({ version: 2, sessions: { s1: { k: [{ callId: 'c1', absPath: 'x' }] } } });
  assert.equal(new ChangeBook(wrongVersion).count(), 0);

  // 非对象 / sessions 非对象
  assert.equal(new ChangeBook(memMemento('nope')).count(), 0);
  assert.equal(new ChangeBook(memMemento({ version: 1, sessions: 'nope' })).count(), 0);

  // 单条缺必填（callId / absPath）→ 该条被丢弃，其余保留
  const partial = memMemento({
    version: 1,
    sessions: {
      s1: {
        k: [
          { callId: 'ok', absPath: 'D:/w/a.ts' },
          { callId: '', absPath: 'D:/w/b.ts' },
          { absPath: 'D:/w/c.ts' },
          'garbage',
          null,
        ],
      },
    },
  });
  const book = new ChangeBook(partial);
  assert.equal(book.count(), 1);
  assert.equal(book.records('s1')[0]?.callId, 'ok');
});

test('stale 判定：哈希不一致 = 文件已被外部修改；哈希未知一律不判 stale', () => {
  const book = new ChangeBook();
  book.add(input({ callId: 'c1', absPath: 'D:/w/a.ts', fileHashAtRecord: contentHash('hello') }));
  book.add(input({ callId: 'c2', absPath: 'D:/w/b.ts', fileHashAtRecord: '' }));

  assert.deepEqual(book.staleFor('D:/w/a.ts', contentHash('hello')).map((r) => r.callId), []);
  assert.deepEqual(book.staleFor('D:/w/a.ts', contentHash('changed')).map((r) => r.callId), ['c1']);
  // 哈希未知（空串）：不判 stale（宁可不动手，也不误报"被改过"）
  assert.deepEqual(book.staleFor('D:/w/b.ts', contentHash('anything')), []);

  const rec = book.records('s1', 'D:/w/a.ts')[0] as ChangeRecord;
  assert.equal(isStale(rec, contentHash('hello')), false);
  assert.equal(isStale(rec, contentHash('other')), true);
  assert.equal(isStale(rec, ''), false);
});

test('contentHash 稳定且为 16 位十六进制', () => {
  const h = contentHash('hello');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, contentHash('hello'));
  assert.notEqual(h, contentHash('hello '));
});

test('onChange 在增/删/清空时触发，dispose 后不再触发', () => {
  const book = new ChangeBook();
  let hits = 0;
  const sub = book.onChange(() => {
    hits += 1;
  });
  book.add(input({ callId: 'c1' }));
  assert.equal(hits, 1);
  book.keep('s1', 'c1');
  assert.equal(hits, 2);
  book.add(input({ callId: 'c2' }));
  book.clear();
  assert.equal(hits, 4);
  sub.dispose();
  book.add(input({ callId: 'c3' }));
  assert.equal(hits, 4, 'dispose 后不应再收到通知');
});

test('订阅者抛错不影响账本写入（重绘失败不该让记录丢失）', () => {
  const book = new ChangeBook();
  book.onChange(() => {
    throw new Error('boom');
  });
  assert.equal(book.add(input({ callId: 'c1' })), true);
  assert.equal(book.count(), 1);
});

test('revert：未注入 executor → failed；成功 → 移除记录；失败 → 保留记录', async () => {
  const noExecutor = new ChangeBook();
  noExecutor.add(input({ callId: 'c1' }));
  assert.deepEqual(await noExecutor.revert('s1', 'c1'), { status: 'failed', reason: 'no revert executor' });
  assert.equal(noExecutor.count(), 1, '未执行成功不得移除记录');

  const outcome: { next: RevertOutcome } = { next: { status: 'reverted' } };
  const book = new ChangeBook(undefined, async () => outcome.next);
  book.add(input({ callId: 'c1' }));
  // 记录不存在 → missing
  assert.equal((await book.revert('s1', 'nope')).status, 'missing');
  // 执行成功 → 记录被移除
  assert.equal((await book.revert('s1', 'c1')).status, 'reverted');
  assert.equal(book.count(), 0);
  // 执行失败（锚点失效）→ 记录保留，便于用户看清原因并重试
  book.add(input({ callId: 'c2' }));
  outcome.next = { status: 'anchor-missing', reason: 'newText no longer in file' };
  assert.equal((await book.revert('s1', 'c2')).status, 'anchor-missing');
  assert.equal(book.count(), 1);
});

test('revertAll：逐条执行、逐条报告（F4 批量语义的账本半边）', async () => {
  const book = new ChangeBook(undefined, async (_s, callId) =>
    callId === 'c2' ? { status: 'refused', reason: 'tool unknown && old content empty' } : { status: 'reverted' },
  );
  book.add(input({ callId: 'c1' }));
  book.add(input({ callId: 'c2' }));
  book.add(input({ callId: 'c3' }));

  const session = await book.revertAll('s1');
  const file = await book.revertAll('s1', 'D:/w/src/a.ts');
  assert.equal(session.length, 3);
  assert.equal(file.length, 1, '已被撤掉的记录不再出现在批量目标里');
  assert.deepEqual(
    session.map((o) => o.status),
    ['reverted', 'refused', 'reverted'],
  );
  assert.equal(book.count(), 1, '失败的那条必须留在账本里');
});

test('refreshHash：补正"记录时哈希"且不影响其他字段（running→settled 双广播的修正口）', () => {
  const book = new ChangeBook();
  book.add(input({ callId: 'c1', fileHashAtRecord: contentHash('old'), time: 1000 }));
  // 命中：只换哈希，其余保持
  assert.equal(book.refreshHash('c1', contentHash('new'), 2000), true);
  const rec = book.records('s1')[0] as ChangeRecord;
  assert.equal(rec.fileHashAtRecord, contentHash('new'));
  assert.equal(rec.time, 2000);
  assert.equal(rec.newText, 'y');
  // 不传 time：保持原时间
  book.refreshHash('c1', contentHash('newer'));
  assert.equal((book.records('s1')[0] as ChangeRecord).time, 2000);
  // 未命中
  assert.equal(book.refreshHash('nope', 'x'), false);
  // 空哈希 = 未知：stale 判定从此不再报警
  book.refreshHash('c1', '');
  assert.deepEqual(book.staleFor('D:/w/src/a.ts', contentHash('whatever')), []);
});

test('recordsForPath / allPaths：跨会话按路径查询（F2 导航与 F3 树的"文件"维度）', () => {
  const book = new ChangeBook();
  book.add(input({ callId: 'c1', sessionId: 's1', absPath: 'D:/w/src/a.ts', time: 300 }));
  book.add(input({ callId: 'c2', sessionId: 's2', absPath: 'D:/w/src/a.ts', time: 100 }));
  book.add(input({ callId: 'c3', sessionId: 's1', absPath: 'D:/w/src/b.ts', time: 200 }));

  // 跨会话按路径取，时间升序（用户按 F8 游走的是"这个文件上的变更"，不分会话）
  assert.deepEqual(
    book.recordsForPath('D:/w/src/a.ts').map((r) => r.callId),
    ['c2', 'c1'],
  );
  assert.deepEqual(book.recordsForPath('D:/w/none.ts'), []);
  // 全部路径去重升序
  assert.deepEqual(book.allPaths(), ['D:/w/src/a.ts', 'D:/w/src/b.ts']);
  assert.deepEqual(new ChangeBook().allPaths(), []);
});
