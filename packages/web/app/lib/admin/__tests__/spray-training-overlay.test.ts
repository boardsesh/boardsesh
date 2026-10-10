import { describe, it, expect } from 'vite-plus/test';
import type {
  SprayTrainingCandidateData,
  SprayTrainingHoldData,
  SprayTrainingStatsData,
} from '@boardsesh/graphql/operations';
import {
  buildHoldShape,
  buildOverlayMarks,
  candidateKind,
  holdKind,
  msUntilExpiry,
  percentOf,
  summariseStats,
} from '../spray-training-overlay';

const hold = (overrides: Partial<SprayTrainingHoldData> = {}): SprayTrainingHoldData => ({
  id: 1,
  cx: 100,
  cy: 200,
  r: 10,
  outline: null,
  source: 'MANUAL',
  autoReview: null,
  ...overrides,
});

const candidate = (overrides: Partial<SprayTrainingCandidateData> = {}): SprayTrainingCandidateData => ({
  index: 0,
  cx: 5,
  cy: 6,
  r: 7,
  outline: null,
  fate: 'DELETED',
  ...overrides,
});

describe('buildHoldShape', () => {
  it('scales an outline ring by the radius around the centre', () => {
    expect(buildHoldShape({ cx: 100, cy: 200, r: 10, outline: [1, 0, 0, 1, -1, 0] })).toEqual({
      geometry: 'polygon',
      points: '110,200 100,210 90,200',
    });
  });

  it.each([
    ['null', null],
    ['too short', [1, 0, 0, 1]],
    ['odd length', [1, 0, 0, 1, -1, 0, 5]],
    ['non-finite', [1, 0, Number.NaN, 1, -1, 0]],
  ])('falls back to the circle for a %s outline', (_name, outline) => {
    expect(buildHoldShape({ cx: 1, cy: 2, r: 3, outline })).toEqual({ geometry: 'circle', cx: 1, cy: 2, r: 3 });
  });
});

describe('holdKind', () => {
  it('maps source and review to a kind', () => {
    expect(holdKind({ source: 'MANUAL', autoReview: null })).toBe('manual');
    expect(holdKind({ source: 'AUTO', autoReview: 'ACCEPTED' })).toBe('accepted');
    expect(holdKind({ source: 'AUTO', autoReview: 'CONFIRMED' })).toBe('confirmed');
    expect(holdKind({ source: 'AUTO', autoReview: 'EDITED' })).toBe('edited');
    expect(holdKind({ source: 'AUTO', autoReview: null })).toBe('auto');
  });
});

describe('candidateKind', () => {
  it('only deleted and never-shown suggestions are drawn', () => {
    expect(candidateKind({ fate: 'DELETED' })).toBe('deleted');
    expect(candidateKind({ fate: 'NOT_SHOWN' })).toBe('notShown');
    expect(candidateKind({ fate: 'KEPT' })).toBeNull();
    expect(candidateKind({ fate: 'EDITED' })).toBeNull();
    expect(candidateKind({ fate: 'UNKNOWN' })).toBeNull();
  });
});

describe('buildOverlayMarks', () => {
  it('lists holds first, then drawable suggestions', () => {
    const marks = buildOverlayMarks({
      holds: [hold({ id: 7 })],
      candidates: [candidate({ index: 0, fate: 'KEPT' }), candidate({ index: 1, fate: 'NOT_SHOWN' })],
    });
    expect(marks.map((mark) => [mark.key, mark.kind])).toEqual([
      ['hold-7', 'manual'],
      ['candidate-1', 'notShown'],
    ]);
  });
});

describe('percentOf and summariseStats', () => {
  it('rounds and guards a zero denominator', () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(5, 0)).toBe(0);
  });

  it('builds the card numbers', () => {
    const stats: SprayTrainingStatsData = {
      holdCount: 20,
      editedHoldCount: 5,
      acceptedHoldCount: 10,
      deletedCandidateCount: 3,
    };
    expect(summariseStats(stats)).toEqual({
      holdCount: 20,
      editedPercent: 25,
      acceptedPercent: 50,
      deletedSuggestions: 3,
    });
  });
});

describe('msUntilExpiry', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  it('counts down and clamps at zero', () => {
    expect(msUntilExpiry('2026-10-07T12:15:00Z', now)).toBe(15 * 60 * 1000);
    expect(msUntilExpiry('2026-10-07T11:00:00Z', now)).toBe(0);
  });
  it('is null without a usable date', () => {
    expect(msUntilExpiry(null, now)).toBeNull();
    expect(msUntilExpiry('nope', now)).toBeNull();
  });
});
