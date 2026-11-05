import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, type AnswerKey } from '../scripts/eval-score.ts';
import type { Finding } from '../src/store.ts';

const finding = (f: Partial<Finding>): Finding =>
  ({ title: 't', severity: 'medium', confidence: 0.9, path: 'a.ts', line: 10, evidence: 'e', ...f });
const key: AnswerKey = {
  expected: [{ id: 'leak', path: 'a.ts', lines: [8, 12], minSeverity: 'medium', defect: 'token goes anywhere' }],
  acceptableExtras: [{ path: 'b.ts', lines: [1, 5], title: 'fine' }],
  forbidden: [{ path: 'c.ts', lines: [1, 5], title: 'wrong' }],
};

test('a finding on the expected anchor at the minimum severity passes, wherever in the window it lands', () => {
  const s = score(key, [finding({ line: 12, title: 'Token leaks' })]);
  assert.equal(s.outcome, 'pass');
  assert.deepEqual(s.matched, { leak: { title: 'Token leaks', severity: 'medium', severityOk: true } });
});

test('a finding whose start_line..line range overlaps the window counts', () => {
  assert.equal(score(key, [finding({ start_line: 4, line: 8 })]).outcome, 'pass');
});

test('no finding on the anchor, or one below the minimum severity, fails', () => {
  assert.deepEqual(score(key, [finding({ line: 13 })]).missed, ['leak']);
  assert.equal(score(key, [finding({ path: 'other.ts' })]).outcome, 'fail');
  const low = score(key, [finding({ severity: 'low' })]);
  assert.equal(low.outcome, 'fail');
  assert.equal(low.matched.leak?.severityOk, false);
});

test('extras sort into forbidden, acceptable and unreviewed; only forbidden fails the run', () => {
  const s = score(key, [
    finding({}), finding({ path: 'b.ts', line: 2, title: 'ok extra' }),
    finding({ path: 'c.ts', line: 3, title: 'bad extra' }), finding({ path: 'd.ts', title: 'new extra' }),
  ]);
  assert.deepEqual([s.acceptable, s.forbidden, s.unreviewed], [['ok extra'], ['bad extra'], ['new extra']]);
  assert.equal(s.outcome, 'fail');
  assert.equal(score(key, [finding({}), finding({ path: 'd.ts' })]).outcome, 'pass');
});

test('several findings on one anchor take the most severe and are flagged ambiguous', () => {
  const s = score(key, [finding({ title: 'minor', severity: 'low' }), finding({ title: 'major', severity: 'high' })]);
  assert.equal(s.matched.leak?.title, 'major');
  assert.deepEqual(s.ambiguous, ['leak']);
  assert.deepEqual(s.unreviewed, ['minor']);
});

test('one finding satisfies at most one expected defect, even when their windows overlap', () => {
  const two: AnswerKey = { expected: [
    { id: 'leak', path: 'a.ts', lines: [8, 12], minSeverity: 'low', defect: 'token goes anywhere' },
    { id: 'retry', path: 'a.ts', lines: [10, 14], minSeverity: 'low', defect: 'no retry' },
  ] };
  const s = score(two, [finding({ line: 10 })]);
  assert.equal(s.outcome, 'fail');
  assert.deepEqual([Object.keys(s.matched), s.missed], [['leak'], ['retry']]);
});

test('a finding only one defect can use is left to that defect, so overlapping windows still all match', () => {
  const two: AnswerKey = { expected: [
    { id: 'wide', path: 'a.ts', lines: [1, 20], minSeverity: 'low', defect: 'anything in the file' },
    { id: 'narrow', path: 'a.ts', lines: [10, 10], minSeverity: 'low', defect: 'line 10 exactly' },
  ] };
  // Greedy matching would give 'wide' the high finding on line 10 and leave 'narrow' with nothing.
  const s = score(two, [finding({ line: 10, severity: 'high', title: 'on 10' }), finding({ line: 3, title: 'on 3' })]);
  assert.equal(s.outcome, 'pass');
  assert.deepEqual([s.matched.wide?.title, s.matched.narrow?.title], ['on 3', 'on 10']);
});

test('matching prefers findings that meet each minimum severity, so a passing assignment is found when one exists', () => {
  const two: AnswerKey = { expected: [
    // 'first' can use high A or low; 'second' can use high A or high B. Moving 'first' onto low would fail it.
    { id: 'first', path: 'a.ts', lines: [1, 12], minSeverity: 'high', defect: 'needs high' },
    { id: 'second', path: 'a.ts', lines: [10, 20], minSeverity: 'high', defect: 'needs high too' },
  ] };
  const s = score(two, [
    finding({ line: 10, severity: 'high', title: 'high A' }), finding({ line: 3, severity: 'low', title: 'low' }),
    finding({ line: 15, severity: 'high', title: 'high B' }),
  ]);
  assert.equal(s.outcome, 'pass');
  assert.deepEqual(s.unreviewed, ['low']);
});

test('a defect with only a too-low finding left is reported as too low, without taking a passing match', () => {
  const s = score(key, [finding({ severity: 'low', title: 'weak' })]);
  assert.deepEqual([s.outcome, s.matched.leak?.title, s.matched.leak?.severityOk, s.missed], ['fail', 'weak', false, []]);
});

test('a run that never reported is an error, not a fail; an empty key with no findings passes', () => {
  assert.equal(score(key, undefined).outcome, 'error');
  assert.equal(score({ expected: [] }, []).outcome, 'pass');
});
