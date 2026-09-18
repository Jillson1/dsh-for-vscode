// test/bridge/locate-layered.test.ts — layered locate (locateTextDetailed) unit tests
//
// Background (real-machine defect, 2026-09-18): when one file is edited many times in quick
// succession, the lines *between* the anchor lines of earlier records get other edits inserted,
// so `indexOf(whole block)` must fail -- measured on real data: 167 of 532 records could not be
// located, and 74 of them were "nearly every line still exists, but not contiguously".
// User-visible symptom: "edit/write lost their highlight".
//
// This file locks the tier semantics and the confidence grading that decides whether the UI may
// offer the destructive "discard / keep" buttons:
//   exact / eol        = verbatim hit      -> normal colors + action buttons
//   ws / gap / near    = recovered by tiers -> dimmed + only "show diff"
// It also locks "all tiers failed => null" (better no mark than a mark in the wrong place).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  locateTextDetailed,
  locateNewText,
  resolveRecordMarks,
  allowsInPlaceAction,
  NEAR_MIN_SCORE,
} from '../../src/bridge/diff-tracker';

test('exact: verbatim hit -> confidence=exact / score=1', () => {
  const content = 'l1\nl2\nl3\nl4\n';
  const r = locateTextDetailed(content, 'l2\nl3');
  assert.equal(r?.confidence, 'exact');
  assert.equal(r?.score, 1);
  assert.equal(r?.line, 2);
});

test('eol: only the newline style differs -> confidence=eol', () => {
  const content = 'a\r\nb\r\nc\r\n';
  const r = locateTextDetailed(content, 'b\nc');
  assert.equal(r?.confidence, 'eol');
  assert.equal(r?.line, 2);
});

test('ws: indentation-only difference -> confidence=ws, located', () => {
  // Multi-line anchor: a single line like 'beta' inside '  beta' is still an exact *substring*
  // hit and legitimately stays exact. Uniform re-indentation is the real ws case.
  const content = 'a\n    keep1\n    keep2\nafter\n';
  const r = locateTextDetailed(content, 'keep1\nkeep2');
  assert.equal(r?.confidence, 'ws');
  assert.equal(r?.line, 2);
});

test('ws: whole block re-indented uniformly -> still located as ws', () => {
  const content = 'a\n    keep1\n    keep2\nafter\n';
  const r = locateTextDetailed(content, 'keep1\nkeep2');
  assert.equal(r?.confidence, 'ws');
  assert.equal(r?.line, 2);
});

test('gap: other edits inserted between the anchor lines -> located (core fix)', () => {
  const content = ['head', 'keep1', 'INSERTED BY LATER EDIT', 'keep2', 'keep3', 'tail'].join('\n');
  const anchor = 'keep1\nkeep2\nkeep3';
  assert.equal(content.indexOf(anchor), -1, 'precondition: the block is no longer contiguous');
  const r = locateTextDetailed(content, anchor);
  assert.equal(r?.confidence, 'gap', 'must degrade to gap instead of failing');
  assert.equal(r?.line, 2, 'lands on the first anchor line');
  assert.ok((r?.score ?? 0) >= 0.9, 'all lines present, only insertions -> high score');
});

test('gap: fewer insertions score higher, never above 1', () => {
  const tight = ['a', 'x', 'b', 'c', 'd'].join('\n');
  const loose = ['a', 'x', 'y', 'z', 'b', 'c', 'd'].join('\n');
  const anchor = 'a\nb\nc\nd';
  const t = locateTextDetailed(tight, anchor);
  const l = locateTextDetailed(loose, anchor);
  assert.equal(t?.confidence, 'gap');
  assert.equal(l?.confidence, 'gap');
  assert.ok((t?.score ?? 0) > (l?.score ?? 0), 'denser hit must score higher');
  assert.ok((t?.score ?? 0) <= 1 && (l?.score ?? 0) <= 1);
});

test('gap: single-line anchors never take the gap tier (too little information)', () => {
  // A single-line anchor that no longer matches verbatim must not be "found" by scanning for
  // any equal line: it falls through to the similarity tier instead.
  const content = ['alpha', 'completely different', 'gamma'].join('\n');
  const r = locateTextDetailed(content, 'beta-not-in-file');
  assert.equal(r, null, 'no tier may invent a position for a missing single line');
});

test('near: a rewritten line breaks gap, so the window tier picks the closest block', () => {
  const content = ['unchanged head', 'fn alpha():', '    return 1', 'fn beta():', 'tail'].join('\n');
  const anchor = 'fn alpha():\n    return 2\nfn beta():';
  const r = locateTextDetailed(content, anchor);
  assert.equal(r?.confidence, 'near');
  assert.ok((r?.score ?? 0) >= NEAR_MIN_SCORE && (r?.score ?? 1) < 1);
  assert.equal(r?.line, 2);
});

test('near: similarity below threshold -> null (no mark beats a wrong mark)', () => {
  const content = ['completely', 'different', 'content', 'here'].join('\n');
  const anchor = 'fn alpha():\n    return 2\nfn beta():';
  assert.equal(locateTextDetailed(content, anchor), null);
});

test('near tier is disabled for short anchors', () => {
  const content = ['x1', 'x2', 'x3'].join('\n');
  assert.equal(locateTextDetailed(content, 'nothing\nsimilar'), null);
});

test('empty input yields null; whitespace-only anchors only match verbatim', () => {
  assert.equal(locateTextDetailed('abc', ''), null);
  assert.equal(locateTextDetailed('', 'abc'), null);
  // A whitespace-only anchor carries no line information: the only honest answer is "found verbatim"
  // (content really does contain those spaces) or "not found" -- never a fuzzy guess.
  assert.equal(locateTextDetailed('   \n  ', '   ')?.confidence, 'exact', 'verbatim hit is allowed');
  assert.equal(locateTextDetailed('aaa\nbbb', '   '), null, 'must not "find" whitespace that is not there');
});

test('confidence grading: only exact / eol may be acted on in place', () => {
  assert.equal(allowsInPlaceAction('exact'), true);
  assert.equal(allowsInPlaceAction('eol'), true);
  assert.equal(allowsInPlaceAction('ws'), false, 'whitespace-only match must not offer discard/keep');
  assert.equal(allowsInPlaceAction('gap'), false);
  assert.equal(allowsInPlaceAction('near'), false);
  assert.equal(allowsInPlaceAction(null), false);
});

test('resolveRecordMarks: returns marks plus confidence (the UI grading input)', () => {
  const content = ['head', 'kept', 'INSERTED', 'committed', 'tail'].join('\n');
  const rec = { oldText: 'kept', newText: 'kept\ncommitted' };
  const r = resolveRecordMarks(content, rec);
  // 'kept' still exists verbatim on its own line, so the ws tier legitimately wins here;
  // what matters for the UI is only that it is a *recovered* (low-confidence) tier.
  assert.ok(r.confidence === 'ws' || r.confidence === 'gap', 'must be a recovered tier');
  assert.equal(allowsInPlaceAction(r.confidence), false, 'recovered tiers must not offer discard/keep');
  assert.ok(r.marks.length > 0, 'must produce drawable marks');
  // Same single source of truth: the legacy locateNewText agrees on the line
  const loc = locateNewText(content, rec.newText);
  assert.equal(loc?.line, 2);
});

test('resolveRecordMarks: all tiers failed -> empty marks (caller must skip the record)', () => {
  const content = 'nothing relevant here\n';
  const r = resolveRecordMarks(content, { oldText: 'aaaa', newText: 'bbbb\ncccc\ndddd' });
  assert.equal(r.marks.length, 0);
  assert.equal(r.confidence, null);
});
