import { describe, it, expect } from 'vitest';
import { sanitizeErrorForAnalytics } from '../sanitize-error';

describe('sanitizeErrorForAnalytics', () => {
  it('uses the message of an Error instance', () => {
    expect(sanitizeErrorForAnalytics(new Error('Could not connect'))).toBe('Could not connect');
  });

  it('stringifies non-Error values', () => {
    expect(sanitizeErrorForAnalytics('plain string')).toBe('plain string');
    expect(sanitizeErrorForAnalytics(42)).toBe('42');
  });

  it('redacts absolute file paths with line numbers', () => {
    expect(sanitizeErrorForAnalytics(new Error('Failed at /Users/me/proj/RNBle.m:142'))).toBe('Failed at <path>');
  });

  it('redacts device-style absolute paths', () => {
    expect(sanitizeErrorForAnalytics('Could not open /dev/ttyUSB0')).toBe('Could not open <path>');
  });

  it('leaves ordinary slashed text alone', () => {
    expect(sanitizeErrorForAnalytics('retry and/or reconnect')).toBe('retry and/or reconnect');
  });

  it('caps overly long messages', () => {
    const long = 'x'.repeat(500);
    const result = sanitizeErrorForAnalytics(long, 200);
    expect(result.length).toBe(201); // 200 chars + the ellipsis
    expect(result.endsWith('…')).toBe(true);
  });
});
