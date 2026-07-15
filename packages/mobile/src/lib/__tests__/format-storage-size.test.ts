import { describe, it, expect } from 'vitest';
import { formatStorageSize } from '../format-storage-size';

describe('formatStorageSize', () => {
  it('formats megabytes whole', () => {
    expect(formatStorageSize(412_000_000)).toBe('412 MB');
    expect(formatStorageSize(1_500_000)).toBe('2 MB');
  });

  it('formats gigabytes with one decimal below 10 GB', () => {
    expect(formatStorageSize(1_200_000_000)).toBe('1.2 GB');
    expect(formatStorageSize(3_100_000_000)).toBe('3.1 GB');
  });

  it('drops the decimal on large capacities', () => {
    expect(formatStorageSize(128_000_000_000)).toBe('128 GB');
  });

  it('formats kilobytes', () => {
    expect(formatStorageSize(4_000)).toBe('4 KB');
  });

  // A storage screen shouldn't render "437 B" — it reads as broken, not as precise.
  it('floors sub-kilobyte values to 1 KB', () => {
    expect(formatStorageSize(437)).toBe('1 KB');
  });

  it('renders nothing-at-all as zero', () => {
    expect(formatStorageSize(0)).toBe('0 MB');
    expect(formatStorageSize(-1)).toBe('0 MB');
    expect(formatStorageSize(Number.NaN)).toBe('0 MB');
  });
});
