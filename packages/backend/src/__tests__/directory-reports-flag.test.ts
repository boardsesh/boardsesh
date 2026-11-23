import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import {
  __resetDirectoryReportsFlagForTests,
  DIRECTORY_REPORTS_FLAG_CACHE_MS,
  isDirectoryReportsEnabled,
  readDirectoryReportsFlagAnswer,
} from '../services/directory-reports-flag';

/**
 * The `directory-reports` server flag fails closed (docs/product/directory-reports.md,
 * "The `directory-reports` flag"): a flag PostHog leaves out is off, and an
 * outage keeps the last answer for one interval only.
 */

const environment = { POSTHOG_PROJECT_KEY: 'phc_test' };

function answer(enabled: boolean): Response {
  return new Response(JSON.stringify({ flags: { 'directory-reports': { enabled } } }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetDirectoryReportsFlagForTests();
});

describe('readDirectoryReportsFlagAnswer', () => {
  it('reads the flag, reads a missing flag as off, and an unusable answer as none', () => {
    expect(readDirectoryReportsFlagAnswer({ flags: { 'directory-reports': { enabled: true } } })).toBe(true);
    expect(readDirectoryReportsFlagAnswer({ flags: { 'directory-reports': { enabled: false } } })).toBe(false);
    expect(readDirectoryReportsFlagAnswer({ featureFlags: { 'directory-reports': 'variant' } })).toBe(true);
    expect(readDirectoryReportsFlagAnswer({ flags: {} })).toBe(false);
    expect(readDirectoryReportsFlagAnswer({ featureFlags: { 'another-flag': true } })).toBe(false);
    expect(readDirectoryReportsFlagAnswer({ flags: {}, errorsWhileComputingFlags: true })).toBeNull();
    expect(readDirectoryReportsFlagAnswer({})).toBeNull();
    expect(readDirectoryReportsFlagAnswer('not json')).toBeNull();
  });
});

describe('isDirectoryReportsEnabled', () => {
  it('keeps the last answer through one interval of outage, then reads off until PostHog answers', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T12:00:00Z') });
    const fetchFlags = vi.fn(async () => answer(true));
    vi.stubGlobal('fetch', fetchFlags);
    const nextInterval = () => vi.setSystemTime(Date.now() + DIRECTORY_REPORTS_FLAG_CACHE_MS + 1);

    expect(await isDirectoryReportsEnabled(environment)).toBe(true);

    fetchFlags.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    nextInterval();
    expect(await isDirectoryReportsEnabled(environment)).toBe(true);
    nextInterval();
    expect(await isDirectoryReportsEnabled(environment)).toBe(false);
    nextInterval();
    expect(await isDirectoryReportsEnabled(environment)).toBe(false);

    fetchFlags.mockImplementation(async () => answer(true));
    nextInterval();
    expect(await isDirectoryReportsEnabled(environment)).toBe(true);
  });

  it('a flag deleted from PostHog reads off at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T12:00:00Z') });
    const fetchFlags = vi.fn(async () => answer(true));
    vi.stubGlobal('fetch', fetchFlags);
    expect(await isDirectoryReportsEnabled(environment)).toBe(true);

    fetchFlags.mockImplementation(async () => new Response(JSON.stringify({ flags: {} }), { status: 200 }));
    vi.setSystemTime(Date.now() + DIRECTORY_REPORTS_FLAG_CACHE_MS + 1);
    expect(await isDirectoryReportsEnabled(environment)).toBe(false);
  });
});
