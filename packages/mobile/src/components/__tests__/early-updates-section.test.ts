import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const setEarlyUpdatesChoice = vi.hoisted(() => vi.fn());
vi.mock('../../lib/qa/early-updates', () => ({ setEarlyUpdatesChoice }));

const hapticSelection = vi.hoisted(() => vi.fn());
vi.mock('../../lib/haptics', () => ({ hapticSelection }));

import { buildEarlyUpdatesSection } from '../early-updates-section';
import type { EarlyUpdatesRowState } from '../../lib/qa/use-early-updates';

// The key is the useful assertion: what can silently break is which line a
// state shows, not the translation.
const translate = ((key: string) => key) as unknown as TFunction<'common'>;

const ENVIRONMENT = { surfingBuild: true, surfingReady: true, flagsResolved: true, flag: 'on' } as const;
const onDeferred = vi.fn();

function build(state: EarlyUpdatesRowState) {
  return buildEarlyUpdatesSection(translate, { state, environment: ENVIRONMENT, onDeferred });
}

function toggleRow(state: EarlyUpdatesRowState) {
  const [row] = build(state).rows;
  if (row.kind !== 'toggle') throw new Error('expected a toggle row');
  return row;
}

describe('buildEarlyUpdatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEarlyUpdatesChoice.mockReset().mockResolvedValue('joined');
  });

  it('is one row under its own heading, with the terms in the footer', () => {
    const section = build('off');

    expect(section).toMatchObject({
      key: 'earlyUpdates',
      title: 'mobile.settings.earlyUpdates.sectionTitle',
      footer: 'mobile.settings.earlyUpdates.footer',
    });
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0]).toMatchObject({ kind: 'toggle', label: 'mobile.settings.earlyUpdates.title' });
  });

  it.each([
    ['off', false, 'mobile.settings.earlyUpdates.offSubtitle'],
    ['on', true, 'mobile.settings.earlyUpdates.onSubtitle'],
    // The switch shows the choice; the line says the phone is not there yet.
    ['waiting', true, 'mobile.settings.earlyUpdates.waitingSubtitle'],
    ['leaving', false, 'mobile.settings.earlyUpdates.leavingSubtitle'],
  ] as const)('%s: switch %s, line %s', (state, value, subtitle) => {
    expect(toggleRow(state)).toMatchObject({ value, subtitle });
  });

  it('offers no switch while a preview is running, and says to leave it first', () => {
    // Both use the one request header, so a flip would drop the preview.
    const [row] = build('testing').rows;

    expect(row).toEqual({
      kind: 'info',
      key: 'earlyUpdates',
      label: 'mobile.settings.earlyUpdates.title',
      body: 'mobile.settings.earlyUpdates.testingBody',
    });
  });

  it.each([true, false])('routes a flip to %s through the choice, with what the sync needs', (next) => {
    toggleRow(next ? 'off' : 'on').onValueChange(next);

    expect(setEarlyUpdatesChoice).toHaveBeenCalledExactlyOnceWith(next, ENVIRONMENT);
    expect(hapticSelection).toHaveBeenCalledOnce();
  });

  it.each(['joined', 'left', 'waiting', 'none'])('says nothing extra when the sync ends %s', async (outcome) => {
    setEarlyUpdatesChoice.mockResolvedValue(outcome);
    toggleRow('off').onValueChange(true);
    await Promise.resolve();

    expect(onDeferred).not.toHaveBeenCalled();
  });

  it.each([true, false])('tells the screen when a flip to %s could not be applied yet', async (next) => {
    setEarlyUpdatesChoice.mockResolvedValue('deferred');
    toggleRow(next ? 'off' : 'on').onValueChange(next);

    await vi.waitFor(() => expect(onDeferred).toHaveBeenCalledExactlyOnceWith(next));
  });
});
