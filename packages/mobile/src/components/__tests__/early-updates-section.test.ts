import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const setEarlyUpdatesMembership = vi.hoisted(() => vi.fn());
vi.mock('../../lib/qa/early-updates', () => ({ setEarlyUpdatesMembership }));

const hapticSelection = vi.hoisted(() => vi.fn());
vi.mock('../../lib/haptics', () => ({ hapticSelection }));

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportHandledError }));

vi.mock('../../lib/format-relative-time', () => ({
  formatRelativeTime: (iso: string | null) => (iso ? '2 hours ago' : ''),
}));

import { buildEarlyUpdatesSection } from '../early-updates-section';

// The key (plus any interpolation) is the useful assertion: what can silently
// break is which line a state shows, not the translation.
const translate = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction<'common'>;

const onToggleFailed = vi.fn();

function toggleRow(input: Partial<Parameters<typeof buildEarlyUpdatesSection>[1]> = {}) {
  const section = buildEarlyUpdatesSection(translate, {
    member: false,
    availability: 'unknown',
    lastUpdateAt: null,
    onToggleFailed,
    ...input,
  });
  const [row] = section.rows;
  if (row.kind !== 'toggle') throw new Error('expected a toggle row');
  return { section, row };
}

describe('buildEarlyUpdatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEarlyUpdatesMembership.mockReset();
  });

  it('is one switch under its own heading, with the terms in the footer', () => {
    const { section, row } = toggleRow();

    expect(section).toMatchObject({
      key: 'earlyUpdates',
      title: 'mobile.settings.earlyUpdates.sectionTitle',
      footer: 'mobile.settings.earlyUpdates.footer',
    });
    expect(section.rows).toHaveLength(1);
    expect(row.label).toBe('mobile.settings.earlyUpdates.title');
  });

  it('off: says what joining gets you', () => {
    const { row } = toggleRow({ member: false });

    expect(row.value).toBe(false);
    expect(row.subtitle).toBe('mobile.settings.earlyUpdates.offSubtitle');
  });

  it('on: says when the latest early update landed', () => {
    const { row } = toggleRow({ member: true, availability: 'offered', lastUpdateAt: '2026-10-05T09:00:00.000Z' });

    expect(row.value).toBe(true);
    expect(row.subtitle).toBe('mobile.settings.earlyUpdates.onSubtitleLatest {"when":"2 hours ago"}');
  });

  it('on, but the server has nothing for this binary: waiting, never plain on', () => {
    const { row } = toggleRow({ member: true, availability: 'waiting' });

    expect(row.value).toBe(true);
    expect(row.subtitle).toBe('mobile.settings.earlyUpdates.waitingSubtitle');
  });

  it('on, with no answer from the update server: claims nothing about the branch', () => {
    const { row } = toggleRow({ member: true, availability: 'unknown' });

    expect(row.value).toBe(true);
    expect(row.subtitle).toBe('mobile.settings.earlyUpdates.onSubtitle');
  });

  it('on, with a timestamp that does not parse: falls back to the plain line', () => {
    const { row } = toggleRow({ member: true, availability: 'offered', lastUpdateAt: null });

    expect(row.subtitle).toBe('mobile.settings.earlyUpdates.onSubtitle');
  });

  it('never shows a stale timestamp to someone who is not a member', () => {
    const { row } = toggleRow({ member: false, availability: 'offered', lastUpdateAt: '2026-10-05T09:00:00.000Z' });

    expect(row.subtitle).toBe('mobile.settings.earlyUpdates.offSubtitle');
  });

  it.each([true, false])('routes a flip to %s through the membership switch', (next) => {
    toggleRow({ member: !next }).row.onValueChange(next);

    expect(setEarlyUpdatesMembership).toHaveBeenCalledExactlyOnceWith(next);
    expect(hapticSelection).toHaveBeenCalledOnce();
    expect(onToggleFailed).not.toHaveBeenCalled();
  });

  it('says so, and reports it, when the switch cannot be applied', () => {
    const failure = new Error('Branch surfing is unavailable on this build');
    setEarlyUpdatesMembership.mockImplementation(() => {
      throw failure;
    });

    toggleRow().row.onValueChange(true);

    expect(onToggleFailed).toHaveBeenCalledOnce();
    expect(reportHandledError).toHaveBeenCalledExactlyOnceWith(failure, {
      tags: { source: 'ota', op: 'early-updates-toggle' },
    });
  });
});
