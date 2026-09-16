// test/changes/change-nav-model.test.ts — F2 导航纯逻辑单测
// 覆盖：行号序列归一（过滤/去重/升序）、next/prev 推进与环绕、边界、计数文案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  navSequence,
  stepLine,
  indexOfLine,
  formatCounter,
} from '../../src/changes/change-nav-model';

test('navSequence：过滤非法值、去重、升序', () => {
  assert.deepEqual(navSequence([5, 2, 2, 9]), [2, 5, 9]);
  assert.deepEqual(navSequence([]), []);
  // 非法值（NaN / Infinity / 0 / 负数）一律丢弃；小数向下取整
  assert.deepEqual(navSequence([Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 2.7]), [2]);
  assert.deepEqual(navSequence([1, 1, 1]), [1]);
});

test('stepLine：next 取第一个更大的行，末尾环绕到首行', () => {
  const lines = [3, 7, 12];
  assert.equal(stepLine(lines, 3, 'next'), 7);
  assert.equal(stepLine(lines, 7, 'next'), 12);
  assert.equal(stepLine(lines, 12, 'next'), 3, '末尾应环绕到首行');
  // 当前行落在两处之间（用户手改后行号漂移）
  assert.equal(stepLine(lines, 5, 'next'), 7);
});

test('stepLine：prev 取最后一个更小的行，开头环绕到末行', () => {
  const lines = [3, 7, 12];
  assert.equal(stepLine(lines, 12, 'prev'), 7);
  assert.equal(stepLine(lines, 7, 'prev'), 3);
  assert.equal(stepLine(lines, 3, 'prev'), 12, '开头应环绕到末行');
  assert.equal(stepLine(lines, 5, 'prev'), 3);
});

test('stepLine：游标缺失时 next 取首行、prev 取末行；空序列返回 undefined', () => {
  assert.equal(stepLine([4, 9], undefined, 'next'), 4);
  assert.equal(stepLine([4, 9], undefined, 'prev'), 9);
  assert.equal(stepLine([], undefined, 'next'), undefined);
  assert.equal(stepLine([], 5, 'prev'), undefined);
});

test('stepLine：wrap=false 时到边界即停（不环绕）', () => {
  assert.equal(stepLine([3, 7], 7, 'next', false), undefined);
  assert.equal(stepLine([3, 7], 3, 'prev', false), undefined);
  assert.equal(stepLine([3, 7], 3, 'next', false), 7);
});

test('indexOfLine / formatCounter：序号与计数文案', () => {
  const lines = [3, 7, 12];
  assert.equal(indexOfLine(lines, 3), 1);
  assert.equal(indexOfLine(lines, 12), 3);
  // 当前行不在序列中（尚未游走 / 已被手改）→ undefined，计数显示 0/N
  assert.equal(indexOfLine(lines, 5), undefined);
  assert.equal(indexOfLine(lines, undefined), undefined);

  assert.equal(formatCounter(lines, 7), '2/3');
  assert.equal(formatCounter(lines, 99), '0/3');
  assert.equal(formatCounter(lines, undefined), '0/3');
  assert.equal(formatCounter([], undefined), '0/0');
});
