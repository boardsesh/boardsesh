import { describe, expect, it } from 'vitest';
import { formatLook, formatStatus, variantAvailability } from '../controls/status-text';
import type { BoardMotionVariant } from '../types';

const variant: BoardMotionVariant = {
  id: 'v',
  letter: 'A',
  name: 'V',
  summary: '',
  params: [],
  createTransition: () => ({ revealMode: 'swap' }),
};

describe('status text', () => {
  it('formats each path', () => {
    expect(formatStatus({ path: 'loading' })).toBe('Loading…');
    expect(formatStatus({ path: 'gpu', apiVersion: 7, prepareMs: 42.2, uploadMs: null })).toBe(
      'GPU · API 7 · prepare 42 ms',
    );
    expect(formatStatus({ path: 'gpu', apiVersion: 7, prepareMs: 42.2, uploadMs: 3.4 })).toBe(
      'GPU · API 7 · prepare 42 ms · upload 3 ms',
    );
    expect(formatStatus({ path: 'gpu', apiVersion: 7, prepareMs: null, uploadMs: null })).toBe('GPU · API 7');
    expect(formatStatus({ path: 'png', apiVersion: 1, reason: 'simulator' })).toBe('PNG · simulator');
    expect(
      formatStatus({ path: 'gpu', apiVersion: 7, prepareMs: null, uploadMs: null, look: { state: 'on', holds: 24 } }),
    ).toBe('GPU · API 7 · look on (24 holds)');
  });
  it('says whether the native look is drawing, and why not', () => {
    expect(formatLook({ state: 'on', holds: 22, reachOff: 'Low Power' })).toBe(
      'look on (22 holds) · reach off (Low Power)',
    );
    expect(formatLook({ state: 'off', reason: 'Reduce Motion' })).toBe('look off (Reduce Motion)');
    expect(formatLook({ state: 'ready' })).toBe('look ready');
    expect(formatLook({ state: 'waiting' })).toBe('look sent, no answer yet');
    expect(formatLook({ state: 'unsupported', swapLookVersion: 1 })).toBe(
      'look off (unsupported build: swapLookVersion 1)',
    );
  });
  it('greys out variants the binary cannot run', () => {
    expect(variantAvailability(variant, 1)).toEqual({ available: true });
    expect(variantAvailability({ ...variant, requiresNativeApi: 7 }, 1).available).toBe(false);
    expect(variantAvailability({ ...variant, requiresNativeApi: 7 }, 7).available).toBe(true);
    expect(variantAvailability({ ...variant, requiresNativeLab: 'x' }, 9).available).toBe(false);
    expect(variantAvailability({ ...variant, requiresNativeLab: 'x' }, 9, 1).available).toBe(false);
  });
  it('greys out swap-look variants unless the binary draws the look (iOS swapLookVersion 1)', () => {
    const look = { ...variant, requiresNativeApi: 7, requiresNativeLab: 'swap-look' };
    expect(variantAvailability(look, 7)).toEqual({
      available: false,
      reason: 'needs the native swap look (iOS, swapLookVersion 2); this build has 0',
    });
    expect(variantAvailability(look, 7, 1).available).toBe(false);
    expect(variantAvailability(look, 7, 2)).toEqual({ available: true });
    expect(variantAvailability(look, 6, 2).available).toBe(false);
  });
});
