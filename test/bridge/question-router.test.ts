// test/bridge/question-router.test.ts — F8 提问 / plan-review 单测
// 契约重点：一次 ask 多问一答（整批回传，不拆）；任一问题被取消则整批不答；
// plan-review 的批准判定只看 intent.approve 标签，绝不靠选项顺序猜。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuestionRouter,
  normalizeQuestions,
  isPlanReview,
  planReviewOf,
  planDocumentText,
  orderPlanOptions,
  buildAnswer,
  titleOf,
  type QuestionItem,
} from '../../src/bridge/question-router';
import type { PanelDownlink } from '../../src/panel/html';

/** 普通单选问题 */
function single(id = 'q1'): QuestionItem {
  return {
    id,
    question: '要改哪个文件？',
    options: [{ label: 'a.ts', description: '主入口' }, { label: 'b.ts' }],
  };
}

/** 多选问题 */
function multi(id = 'q2'): QuestionItem {
  return { id, question: '哪些要保留？', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] };
}

/** 自由文本问题（无选项） */
function freeText(id = 'q3'): QuestionItem {
  return { id, question: '新名称是什么？', detail: '会用于重命名模块' };
}

/** plan-review 问题 */
function planReview(id = 'q4'): QuestionItem {
  return {
    id,
    question: '请审阅这份迁移计划',
    header: '计划审阅',
    detail: '# 步骤\n1. 改 schema\n2. 回填数据',
    options: [{ label: '打回' }, { label: '批准执行' }],
    intent: { kind: 'plan-review', approve: '批准执行' },
  };
}

/** 组装路由器 + 可观察记录 */
function makeRouter(answers: {
  one?: (string | undefined)[];
  many?: (string[] | undefined)[];
  input?: (string | undefined)[];
}) {
  const one = [...(answers.one ?? [])];
  const many = [...(answers.many ?? [])];
  const input = [...(answers.input ?? [])];
  const sent: PanelDownlink[] = [];
  const plans: { title: string; markdown: string }[] = [];
  const notices: string[] = [];
  const logs: string[] = [];
  const router = new QuestionRouter({
    pickOne: async () => one.shift(),
    pickMany: async () => many.shift(),
    input: async () => input.shift(),
    openPlan: async (title, markdown) => {
      plans.push({ title, markdown });
    },
    send: (m) => {
      sent.push(m);
      return true;
    },
    notify: (m) => notices.push(m),
    log: (m) => logs.push(m),
  });
  return { router, sent, plans, notices, logs };
}

/** 取回执里的答案（仅测试用） */
function answerOf(sent: PanelDownlink[]) {
  const msg = sent[0];
  assert.equal(msg?.type, 'bridgeQuestionAnswer');
  return (msg as unknown as { answer: { answers: { id: string; selected: string[]; custom?: string }[] } }).answer;
}

test('normalizeQuestions：丢弃无 id / 无问题正文的项，选项按 label 过滤，intent 需完整', () => {
  const items = normalizeQuestions([
    { id: 'a', question: 'Q1', options: [{ label: 'x' }, { description: 'no label' }, 'junk'] },
    { id: '', question: 'Q2' },
    { id: 'c' },
    null,
    'junk',
    { id: 'd', question: 'Q4', intent: { kind: 'plan-review', approve: 'go' } },
    { id: 'e', question: 'Q5', intent: { kind: 'plan-review' } }, // 缺 approve → 不认
  ]);
  assert.deepEqual(items.map((i) => i.id), ['a', 'd', 'e']);
  assert.deepEqual(items[0]?.options, [{ label: 'x' }]);
  assert.equal(isPlanReview(items[1] as QuestionItem), true);
  assert.equal(isPlanReview(items[2] as QuestionItem), false);
});

test('titleOf：header 优先，否则取问题首行并截断', () => {
  assert.equal(titleOf({ id: 'a', question: 'Q', header: '标题' }), '标题');
  assert.equal(titleOf({ id: 'a', question: '第一行\n第二行' }), '第一行');
  assert.equal(titleOf({ id: 'a', question: 'x'.repeat(200) }).length, 61); // 60 + 省略号
});

test('planDocumentText：含标题/问题/选项（标注批准项）/计划正文', () => {
  const text = planDocumentText(planReview());
  assert.match(text, /^# 计划审阅/);
  assert.match(text, /请审阅这份迁移计划/);
  assert.match(text, /批准执行.*（批准）/);
  assert.match(text, /## 计划内容/);
  assert.match(text, /回填数据/);
  assert.match(text, /只读文档/);
});

test('orderPlanOptions：批准项提到最前，但不改标签语义', () => {
  const ordered = orderPlanOptions(planReview());
  assert.equal(ordered[0]?.label, '批准执行');
  assert.equal(ordered.length, 2);
  // 非 plan-review 保持原顺序
  assert.deepEqual(orderPlanOptions(single()).map((o) => o.label), ['a.ts', 'b.ts']);
});

test('buildAnswer：custom 只在非空时出现', () => {
  assert.deepEqual(buildAnswer([{ item: single(), selected: ['a.ts'] }]), {
    answers: [{ id: 'q1', selected: ['a.ts'] }],
  });
  assert.deepEqual(buildAnswer([{ item: freeText(), selected: [], custom: '新名' }]), {
    answers: [{ id: 'q3', selected: [], custom: '新名' }],
  });
  assert.deepEqual(buildAnswer([{ item: freeText(), selected: [], custom: '' }]), {
    answers: [{ id: 'q3', selected: [] }],
  });
});

test('单选：QuickPick 结果回传为 { id, selected:[label] }', async () => {
  const { router, sent } = makeRouter({ one: ['a.ts'] });
  assert.equal(await router.onRequest({ sessionId: 's1', questionId: 'q:1', questions: [single()] }), 'answered');
  assert.deepEqual(answerOf(sent), { answers: [{ id: 'q1', selected: ['a.ts'] }] });
  assert.equal(router.hasAnswered('q:1'), true);
});

test('多选：回传多个标签', async () => {
  const { router, sent } = makeRouter({ many: [['x', 'y']] });
  await router.onRequest({ sessionId: 's1', questionId: 'q:2', questions: [multi()] });
  assert.deepEqual(answerOf(sent), { answers: [{ id: 'q2', selected: ['x', 'y'] }] });
});

test('无选项 → InputBox 自由文本走 custom', async () => {
  const { router, sent } = makeRouter({ input: ['新名字'] });
  await router.onRequest({ sessionId: 's1', questionId: 'q:3', questions: [freeText()] });
  assert.deepEqual(answerOf(sent), { answers: [{ id: 'q3', selected: [], custom: '新名字' }] });
});

test('多问题整批一次作答（顺序与问题一致，不拆次回传）', async () => {
  const { router, sent } = makeRouter({ one: ['a.ts'], many: [['x']], input: ['名字'] });
  await router.onRequest({ sessionId: 's1', questionId: 'q:multi', questions: [single(), multi(), freeText()] });
  assert.equal(sent.length, 1, '整批只回传一次');
  assert.deepEqual(answerOf(sent), {
    answers: [
      { id: 'q1', selected: ['a.ts'] },
      { id: 'q2', selected: ['x'] },
      { id: 'q3', selected: [], custom: '名字' },
    ],
  });
});

test('任一问题被取消 → 整批不回答（部分作答等于替用户决定）', async () => {
  const { router, sent, logs } = makeRouter({ one: ['a.ts'], many: [undefined] });
  assert.equal(await router.onRequest({ sessionId: 's1', questionId: 'q:cancel', questions: [single(), multi()] }), 'skipped');
  assert.deepEqual(sent, []);
  assert.equal(router.hasAnswered('q:cancel'), false);
  assert.ok(logs.some((l) => l.includes('整批放弃')));
});

test('plan-review：先开只读计划文档，批准 → selected=[approve 标签]', async () => {
  const { router, sent, plans } = makeRouter({ one: ['批准执行'] });
  await router.onRequest({ sessionId: 's1', questionId: 'q:plan', questions: [planReview()] });
  assert.equal(plans.length, 1, '必须先呈现计划正文');
  assert.equal(plans[0]?.title, '计划审阅');
  assert.match(plans[0]?.markdown ?? '', /回填数据/);
  assert.deepEqual(answerOf(sent), { answers: [{ id: 'q4', selected: ['批准执行'] }] });
});

test('plan-review：打回 → selected=[打回]，可附理由到 custom（理由留空不带 custom）', async () => {
  const withReason = makeRouter({ one: ['打回'], input: ['第 2 步会锁表'] });
  await withReason.router.onRequest({ sessionId: 's1', questionId: 'q:plan1', questions: [planReview()] });
  assert.deepEqual(answerOf(withReason.sent), {
    answers: [{ id: 'q4', selected: ['打回'], custom: '第 2 步会锁表' }],
  });

  const noReason = makeRouter({ one: ['打回'], input: [undefined] });
  await noReason.router.onRequest({ sessionId: 's1', questionId: 'q:plan2', questions: [planReview()] });
  // 理由输入被取消 ≠ 取消打回：打回这个决定本身已经作出了
  assert.deepEqual(answerOf(noReason.sent), { answers: [{ id: 'q4', selected: ['打回'] }] });
});

test('plan-review：选择框被取消 → 不回答（不把"没选"当成批准或打回）', async () => {
  const { router, sent } = makeRouter({ one: [undefined] });
  assert.equal(await router.onRequest({ sessionId: 's1', questionId: 'q:plan3', questions: [planReview()] }), 'skipped');
  assert.deepEqual(sent, []);
});

test('面板不可达 → 不记账 + 明确告知（不假装已回答）', async () => {
  const sent: PanelDownlink[] = [];
  const notices: string[] = [];
  const router = new QuestionRouter({
    pickOne: async () => 'a.ts',
    pickMany: async () => [],
    input: async () => 'x',
    openPlan: async () => {},
    send: () => false,
    notify: (m) => notices.push(m),
    log: () => {},
  });
  assert.equal(await router.onRequest({ sessionId: 's1', questionId: 'q:down', questions: [single()] }), 'skipped');
  assert.deepEqual(sent, []);
  assert.equal(router.hasAnswered('q:down'), false);
  assert.ok(notices.some((n) => n.includes('未能回传')));
});

test('同一 questionId 已作答 → 不重复弹（重放/重连不打扰）', async () => {
  let asked = 0;
  const router = new QuestionRouter({
    pickOne: async () => {
      asked += 1;
      return 'a.ts';
    },
    pickMany: async () => [],
    input: async () => 'x',
    openPlan: async () => {},
    send: () => true,
    notify: () => {},
    log: () => {},
  });
  await router.onRequest({ sessionId: 's1', questionId: 'q:dup', questions: [single()] });
  assert.equal(await router.onRequest({ sessionId: 's1', questionId: 'q:dup', questions: [single()] }), 'skipped');
  assert.equal(asked, 1);
  // forget 后可再次询问（会话切换场景）
  router.forget('q:dup');
  await router.onRequest({ sessionId: 's1', questionId: 'q:dup', questions: [single()] });
  assert.equal(asked, 2);
  assert.equal(router.pendingCount(), 0);
});

test('planReviewOf：从混合批次里挑出计划审阅问题（没有则 undefined）', () => {
  assert.equal(planReviewOf([single(), planReview()])?.id, 'q4');
  assert.equal(planReviewOf([single(), multi()]), undefined);
  assert.equal(planReviewOf([]), undefined);
});
