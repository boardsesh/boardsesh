import assert from 'node:assert/strict';
import test from 'node:test';
import { getGradeLabel } from '../grade-lookup';

void test('MoonBoard labels difficulty 16 on its own scale', () => {
  assert.equal(getGradeLabel(16, 'moonboard'), '6a/V2');
});

void test('every other board, and no board, keeps the shared label for 16', () => {
  assert.equal(getGradeLabel(16), '6a/V3');
  assert.equal(getGradeLabel(16, null), '6a/V3');
  assert.equal(getGradeLabel(16, 'kilter'), '6a/V3');
  assert.equal(getGradeLabel(16, 'tension'), '6a/V3');
});

void test('MoonBoard and the shared scale agree away from 16', () => {
  assert.equal(getGradeLabel(15, 'moonboard'), getGradeLabel(15));
  assert.equal(getGradeLabel(17, 'moonboard'), getGradeLabel(17));
});

void test('a numeric id that the driver hands back as a string still resolves', () => {
  // ROUND(...::numeric) arrives as "16" from postgres.js despite the `number` type.
  const idFromDriver = '16' as unknown as number;
  assert.equal(getGradeLabel(idFromDriver, 'moonboard'), '6a/V2');
  assert.equal(getGradeLabel(idFromDriver), '6a/V3');
});

void test('null and unknown ids give an empty label', () => {
  assert.equal(getGradeLabel(null, 'moonboard'), '');
  assert.equal(getGradeLabel(99), '');
});
