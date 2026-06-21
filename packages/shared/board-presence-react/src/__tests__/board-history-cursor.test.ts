import { describe, it, expect } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { boardHistoryCursor } from '../types';

describe('boardHistoryCursor', () => {
  it('stringifies a raw seq number', () => {
    expect(boardHistoryCursor(900)).toBe('900');
  });

  it('stringifies the seq of a climb', () => {
    const climb = { climbUuid: 'c1', sentAt: '2026-06-09T00:00:00.000Z', seq: 42 } as BoardPresenceClimb;
    expect(boardHistoryCursor(climb)).toBe('42');
  });
});
