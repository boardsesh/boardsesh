import { describe, it, expect, beforeEach, vi } from 'vitest';

// androidSafeSnapPoints branches on Platform.OS at call time; mock a mutable Platform
// so each describe can pin the OS it exercises (order-independent).
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { Platform } from 'react-native';
import { androidSafeSnapPoints } from '../sheet-snap-points';

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

describe('androidSafeSnapPoints (androidOpensExpanded, Android)', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('collapses a multi-detent sheet to its single last detent when opted in', () => {
    expect(androidSafeSnapPoints(['50%', '90%'], true)).toEqual(['90%']);
    expect(androidSafeSnapPoints(['20%', '50%', '90%'], true)).toEqual(['90%']);
  });

  it('leaves a multi-detent sheet unchanged when not opted in', () => {
    expect(androidSafeSnapPoints(['50%', '90%'], false)).toEqual(['50%', '90%']);
  });

  it('leaves an already single-detent sheet unchanged when opted in', () => {
    expect(androidSafeSnapPoints(['90%'], true)).toEqual(['90%']);
  });

  it('does not fall through to the small-single-detent padding branch when opted in', () => {
    expect(androidSafeSnapPoints(['65%'], true)).toEqual(['65%']);
  });

  it('collapses a multi-detent sheet with numeric (px) detents to the last one', () => {
    expect(androidSafeSnapPoints([300, 600], true)).toEqual([600]);
  });
});

describe('androidSafeSnapPoints (androidOpensExpanded, iOS/web passthrough)', () => {
  it('leaves a multi-detent sheet unchanged on iOS, regardless of the opt-in', () => {
    platform.OS = 'ios';
    expect(androidSafeSnapPoints(['50%', '90%'], true)).toEqual(['50%', '90%']);
  });

  it('leaves a multi-detent sheet unchanged on web, regardless of the opt-in', () => {
    platform.OS = 'web';
    expect(androidSafeSnapPoints(['50%', '90%'], true)).toEqual(['50%', '90%']);
  });
});
