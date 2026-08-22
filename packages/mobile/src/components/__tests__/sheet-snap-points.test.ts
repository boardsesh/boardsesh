import { describe, it, expect, beforeEach, vi } from 'vitest';

// androidSafeSnapPoints branches on Platform.OS at call time; mock a mutable Platform
// so each describe can pin the OS it exercises (order-independent).
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { Platform } from 'react-native';
import { androidSafeSnapPoints, androidInitialPresentIndex } from '../sheet-snap-points';

const platform = Platform as { OS: string };

describe('androidSafeSnapPoints (Android)', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('adds a full-screen detent to a small single detent so it opens partial (arms partialExpand)', () => {
    expect(androidSafeSnapPoints(['55%'])).toEqual(['55%', '100%']);
    expect(androidSafeSnapPoints(['36%'])).toEqual(['36%', '100%']);
  });

  it('leaves a large single detent (>= 75%) unchanged — expanded is the right match', () => {
    expect(androidSafeSnapPoints(['80%'])).toEqual(['80%']);
    expect(androidSafeSnapPoints(['75%'])).toEqual(['75%']);
    expect(androidSafeSnapPoints(['90%'])).toEqual(['90%']);
  });

  it('leaves a non-% (px) single detent unchanged', () => {
    expect(androidSafeSnapPoints([200])).toEqual([200]);
    expect(androidSafeSnapPoints(['200'])).toEqual(['200']);
  });

  it('leaves an already multi-detent sheet unchanged', () => {
    expect(androidSafeSnapPoints(['50%', '90%'])).toEqual(['50%', '90%']);
  });

  it('leaves an empty snap-point list unchanged', () => {
    expect(androidSafeSnapPoints([])).toEqual([]);
  });
});

describe('androidSafeSnapPoints (iOS passthrough)', () => {
  beforeEach(() => {
    platform.OS = 'ios';
  });

  it('returns a small single detent unchanged (iOS honours the exact detent)', () => {
    expect(androidSafeSnapPoints(['55%'])).toEqual(['55%']);
    expect(androidSafeSnapPoints(['36%'])).toEqual(['36%']);
  });
});

describe('androidInitialPresentIndex (Android)', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('resolves to the last detent when opted in with multiple detents', () => {
    expect(androidInitialPresentIndex(['50%', '90%'], true)).toBe(1);
    expect(androidInitialPresentIndex(['20%', '50%', '90%'], true)).toBe(2);
  });

  it('resolves to 0 when not opted in, even with multiple detents', () => {
    expect(androidInitialPresentIndex(['50%', '90%'], false)).toBe(0);
  });

  it('resolves to 0 when opted in but there is only a single detent', () => {
    expect(androidInitialPresentIndex(['90%'], true)).toBe(0);
  });
});

describe('androidInitialPresentIndex (iOS/web)', () => {
  beforeEach(() => {
    platform.OS = 'ios';
  });

  it('always resolves to 0, regardless of the opt-in', () => {
    expect(androidInitialPresentIndex(['50%', '90%'], true)).toBe(0);
    expect(androidInitialPresentIndex(['50%', '90%'], false)).toBe(0);
  });
});
