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

void test('null and legacy missing-grade sentinels give an empty label without warning', (context) => {
  const warning = context.mock.method(console, 'warn', () => {});

  assert.equal(getGradeLabel(null, 'moonboard'), '');
  for (const difficultyId of [0, 1, '0', '1']) {
    assert.equal(getGradeLabel(difficultyId as number, 'kilter'), '');
    assert.equal(getGradeLabel(difficultyId as number, 'tension'), '');
  }
  assert.equal(warning.mock.callCount(), 0);
});

void test('unknown ids still warn once per id and give an empty label', (context) => {
  const warning = context.mock.method(console, 'warn', () => {});

  for (const difficultyId of [2, 99]) {
    assert.equal(getGradeLabel(difficultyId), '');
    assert.equal(getGradeLabel(difficultyId), '');
  }
  assert.equal(warning.mock.callCount(), 2);
  assert.match(String(warning.mock.calls[0].arguments[0]), /Unknown difficulty ID: 2/);
  assert.match(String(warning.mock.calls[1].arguments[0]), /Unknown difficulty ID: 99/);
});

void test('valid grade boundaries keep their labels', () => {
  assert.equal(getGradeLabel(10), '4a/V0');
  assert.equal(getGradeLabel(33), '8c+/V16');
});
