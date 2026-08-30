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

// `androidContentSized` sheets (the tick sheets) never reach here on Android —
// `Sheet` / `ModalSheet` route them into `@expo/ui`'s content-fitting path with
// NO snap points. `androidSafeSnapPoints` is only asked to pad a small single
// detent; a multi-detent tick config that did reach it is passed through
// untouched (it is never used on that path).
describe('androidSafeSnapPoints (content-fitting sheets are handled upstream)', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('passes a multi-detent tick config through untouched', () => {
    expect(androidSafeSnapPoints(['65%', '92%'])).toEqual(['65%', '92%']);
    expect(androidSafeSnapPoints(['80%', '92%'])).toEqual(['80%', '92%']);
  });
});
