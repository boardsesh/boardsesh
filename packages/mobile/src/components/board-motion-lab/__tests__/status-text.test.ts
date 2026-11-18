import { describe, expect, it } from 'vitest';
import { formatStatus, variantAvailability } from '../controls/status-text';
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
  });
  it('greys out variants the binary cannot run', () => {
    expect(variantAvailability(variant, 1)).toEqual({ available: true });
    expect(variantAvailability({ ...variant, requiresNativeApi: 7 }, 1).available).toBe(false);
    expect(variantAvailability({ ...variant, requiresNativeApi: 7 }, 7).available).toBe(true);
    expect(variantAvailability({ ...variant, requiresNativeLab: 'x' }, 9).available).toBe(false);
  });
});
