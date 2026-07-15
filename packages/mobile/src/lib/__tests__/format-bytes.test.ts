// Byte formatting for the offline download estimate (#3616). The unit boundaries
// are the interesting part — this string goes straight into a confirm dialog, so
// a wrong divisor misinforms the exact decision the dialog exists to support.
//
// Every expectation pins an explicit locale: `toLocaleString` with no locale
// follows the host, so unpinned assertions would pass here and fail on a CI box
// running under `de` ("1.000 KB").

import { describe, it, expect } from 'vitest';
import { formatBytes } from '../format-bytes';

describe('formatBytes', () => {
  it('renders the real kilter layout-1 artifact as 270 MB', () => {
    // The 270 MB case this feature exists to warn about, straight from the live
    // manifest. Base-10 — a base-2 divisor would misprint this as "257 MB".
    expect(formatBytes(269873152, 'en-US')).toBe('270 MB');
  });

  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [999, '999 B'],
    [1_000, '1 KB'],
    [999_999, '1,000 KB'],
    [1_000_000, '1 MB'],
    [29_300_000, '29 MB'],
    [999_999_999, '1,000 MB'],
    [1_000_000_000, '1 GB'],
    [1_200_000_000, '1.2 GB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes, 'en-US')).toBe(expected);
  });

  it('keeps one decimal for GB but none below it', () => {
    expect(formatBytes(2_450_000_000, 'en-US')).toBe('2.5 GB');
    expect(formatBytes(47_100_000, 'en-US')).toBe('47 MB');
  });

  it('formats digits in the locale it is given, not the host', () => {
    // The size is interpolated into a translated sentence, so it must follow the
    // app's language: Spanish/German use a decimal comma and a dot for grouping.
    expect(formatBytes(1_200_000_000, 'es')).toBe('1,2 GB');
    expect(formatBytes(999_999, 'de')).toBe('1.000 KB');
  });

  it('clamps corrupt sizes instead of rendering them', () => {
    // A negative/NaN size can only come from a corrupt manifest; "-1 B" in a
    // dialog would be worse than saying zero.
    expect(formatBytes(-1, 'en-US')).toBe('0 B');
    expect(formatBytes(Number.NaN, 'en-US')).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY, 'en-US')).toBe('0 B');
  });
});
