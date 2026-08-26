import { describe, expect, it } from 'vitest';
import { findWrittenRiskScore, parseRisk } from '../risk';

describe('parseRisk', () => {
  it.each([
    ['Risk: 3/5 — touches the queue reducer', 3, 'touches the queue reducer'],
    ['risk 4/5 - BLE write path', 4, 'BLE write path'],
    ['**Risk:** 2/5: isolated UI', 2, 'isolated UI'],
    ['Risk: 1/5', 1, null],
    ['- Risk: 5/5 – migration with backfill', 5, 'migration with backfill'],
  ])('parses %j', (line, level, reason) => {
    expect(parseRisk(`## Risk\n${line}`)).toEqual({ level, reason });
  });

  it('prefers the ## Risk section but falls back to anywhere in the body', () => {
    expect(parseRisk('## Summary\nRisk: 2/5 — copy only\n## Test plan\n1. x')).toEqual({
      level: 2,
      reason: 'copy only',
    });
    expect(parseRisk('## Summary\nRisk: 2/5 — first\n## Risk\nRisk: 4/5 — section wins')).toEqual({
      level: 4,
      reason: 'section wins',
    });
  });

  it('ignores the template placeholder and commented-out examples', () => {
    expect(parseRisk('## Risk\n<!-- Risk: 3/5 — example -->\nRisk: /5 —')).toBeNull();
    expect(parseRisk(null)).toBeNull();
  });

  it('ignores a risk line inside a code fence, in the section and in the body', () => {
    expect(parseRisk('## Risk\n```\nRisk: 3/5 — example\n```')).toBeNull();
    expect(parseRisk('## Summary\n```md\nRisk: 2/5 — copy only\n```\n## Risk\nRisk: /5 —')).toBeNull();
    expect(parseRisk('## Summary\n```\nRisk: 1/5 — fenced\n```\nRisk: 4/5 — real')).toEqual({
      level: 4,
      reason: 'real',
    });
  });

  it('rejects out-of-range scores', () => {
    expect(parseRisk('## Risk\nRisk: 6/5 — too much')).toBeNull();
    expect(parseRisk('## Risk\nRisk: 0/5')).toBeNull();
  });
});

describe('findWrittenRiskScore', () => {
  it('reports the written score even when out of range', () => {
    expect(findWrittenRiskScore('## Risk\nRisk: 6/5')).toBe(6);
    expect(findWrittenRiskScore('## Risk\nRisk: 3/5')).toBe(3);
    expect(findWrittenRiskScore('## Risk\nRisk: /5 —')).toBeNull();
  });
});
