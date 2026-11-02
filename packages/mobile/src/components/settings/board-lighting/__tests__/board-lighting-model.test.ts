import { describe, expect, it, vi } from 'vitest';
import { buildBoardLightingSections, type BoardLightingModelInput } from '../board-lighting-model';
import type { MoreRow } from '../../../MoreForm.types';

function makeInput(overrides: Partial<BoardLightingModelInput> = {}): BoardLightingModelInput {
  return {
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    keepLighting: { choice: '45', onChange: vi.fn() },
    moonboardKeepLighting: null,
    drivesInSession: { enabled: true, onChange: vi.fn() },
    lightOnSwipe: { enabled: true, onChange: vi.fn() },
    lightOnClimbTap: { enabled: false, onChange: vi.fn() },
    playlistTapLoadsQueue: { enabled: false, onChange: vi.fn() },
    moonboardLightAdjacentHolds: null,
    autoDisconnect: { enabled: true, onChange: vi.fn() },
    autoDisconnectTimeout: {
      seconds: 30,
      options: [
        { seconds: 10, label: '10 seconds' },
        { seconds: 30, label: '30 seconds' },
      ],
      onChange: vi.fn(),
    },
    ...overrides,
  };
}

function findRow(input: BoardLightingModelInput, key: string): MoreRow {
  const row = buildBoardLightingSections(input)
    .flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildBoardLightingSections', () => {
  it('lists what Put on board keeps lighting, then what lights the board on its own, then what a list tap does, then Bluetooth', () => {
    const sections = buildBoardLightingSections(makeInput());
    expect(sections.map((section) => [section.key, section.rows.map((row) => row.key)])).toEqual([
      ['keepLighting', ['putOnBoardKeepsLighting', 'putOnBoardDrivesInSession']],
      ['lightingAuto', ['lightOnClimbTap', 'lightOnSwipe']],
      ['lightingMore', ['playlistTapLoadsQueue']],
      ['bluetooth', ['autoDisconnectBle', 'autoDisconnectTimeoutSeconds']],
    ]);
  });

  // Six climbers in six read the old side-by-side pair as two independent
  // switches. The swipe switch only matters once a climb is on the wall, so it
  // sits under the tap switch in a group of its own, and its subtitle says so.
  it('nests the swipe switch under the tap switch, alone in their group, with its caption', () => {
    const [, lighting, more] = buildBoardLightingSections(makeInput());
    expect(lighting.rows.map((row) => row.key)).toEqual(['lightOnClimbTap', 'lightOnSwipe']);
    const [tap, swipe] = lighting.rows;
    if (tap.kind !== 'toggle' || swipe.kind !== 'toggle') throw new Error('not toggles');
    expect(tap.label).toBe('settings:ble.lighting.onTapLabel');
    expect(tap.subtitle).toBe('settings:ble.lighting.onTapDescription');
    expect(swipe.label).toBe('settings:ble.lighting.onSwipeLabel');
    expect(swipe.subtitle).toBe('settings:ble.lighting.onSwipeDescription');
    // The second card has no header, so it reads as the same lighting page.
    expect(more.title).toBeUndefined();
  });

  it('titles the groups, since they sit on the Board page under the look, and keeps their descriptions as footers', () => {
    // Auto-disconnect off, so its footer has nothing to add about keep-lighting.
    const [keep, lighting, , bluetooth] = buildBoardLightingSections(
      makeInput({ autoDisconnect: { enabled: false, onChange: vi.fn() } }),
    );
    expect(keep.title).toBe('settings:ble.lighting.title');
    expect(keep.footer).toBe('settings:ble.lighting.keep.footer');
    expect(lighting.title).toBe('settings:ble.lighting.autoTitle');
    expect(lighting.footer).toBe('settings:ble.lighting.description');
    expect(bluetooth.title).toBe('settings:ble.sectionTitle');
    expect(bluetooth.footer).toBe('settings:ble.autoDisconnect.description');
  });

  it('adds the MoonBoard extra-LED switch only for a MoonBoard, after the playlist switch', () => {
    expect(buildBoardLightingSections(makeInput())[2].rows.map((row) => row.key)).toEqual(['playlistTapLoadsQueue']);
    const withMoonboard = buildBoardLightingSections(
      makeInput({ moonboardLightAdjacentHolds: { enabled: true, onChange: vi.fn() } }),
    );
    expect(withMoonboard[2].rows.map((row) => row.key)).toEqual([
      'playlistTapLoadsQueue',
      'moonboardLightAdjacentHolds',
    ]);
    const onChange = vi.fn();
    const row = findRow(
      makeInput({ moonboardLightAdjacentHolds: { enabled: true, onChange } }),
      'moonboardLightAdjacentHolds',
    );
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    expect(row.value).toBe(true);
    row.onValueChange(false);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('selects a timeout by its seconds and ignores anything else', () => {
    const onChange = vi.fn();
    const input = makeInput();
    input.autoDisconnectTimeout.onChange = onChange;
    const row = findRow(input, 'autoDisconnectTimeoutSeconds');
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row.selectedKey).toBe('30');
    expect(row.options).toEqual([
      { key: '10', label: '10 seconds' },
      { key: '30', label: '30 seconds' },
    ]);
    row.onSelect('10');
    row.onSelect('999');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it('offers the playlist-tap switch after the lighting pair, off unless the climber chose it', () => {
    const input = makeInput();
    const row = findRow(input, 'playlistTapLoadsQueue');
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    expect(row.label).toBe('settings:ble.lighting.playlistTapLoadsQueueLabel');
    expect(row.subtitle).toBe('settings:ble.lighting.playlistTapLoadsQueueDescription');
    expect(row.value).toBe(false);
    row.onValueChange(true);
    expect(input.playlistTapLoadsQueue.onChange).toHaveBeenCalledWith(true);
    expect(input.lightOnClimbTap.onChange).not.toHaveBeenCalled();
  });

  it('hands each switch flip to its own handler', () => {
    const input = makeInput();
    const swipe = findRow(input, 'lightOnSwipe');
    if (swipe.kind !== 'toggle') throw new Error('not a toggle');
    swipe.onValueChange(false);
    expect(input.lightOnSwipe.onChange).toHaveBeenCalledWith(false);
    expect(input.lightOnClimbTap.onChange).not.toHaveBeenCalled();
  });
});

// After Put on board, keep lighting (2.7, spec B4): the new first card.
describe('buildBoardLightingSections: keep lighting', () => {
  it('offers Off, 30 s, 45 s, 1 minute and Until I stop, the timed ones worded as auto-disconnect words them', () => {
    const row = findRow(makeInput(), 'putOnBoardKeepsLighting');
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row.label).toBe('settings:ble.lighting.keep.label');
    expect(row.selectedKey).toBe('45');
    expect(row.options).toEqual([
      { key: 'off', label: 'settings:ble.lighting.keep.off' },
      { key: '30', label: 'settings:ble.autoDisconnect.timeoutOptions.30' },
      { key: '45', label: 'settings:ble.autoDisconnect.timeoutOptions.45' },
      { key: '60', label: 'settings:ble.autoDisconnect.timeoutOptions.60' },
      { key: 'until_stopped', label: 'settings:ble.lighting.keep.untilStopped' },
    ]);
  });

  it('hands a known choice to its handler and ignores anything else', () => {
    const input = makeInput();
    const row = findRow(input, 'putOnBoardKeepsLighting');
    if (row.kind !== 'select') throw new Error('not a select');
    row.onSelect('until_stopped');
    row.onSelect('90');
    expect(input.keepLighting.onChange).toHaveBeenCalledTimes(1);
    expect(input.keepLighting.onChange).toHaveBeenCalledWith('until_stopped');
  });

  it("puts the MoonBoard's own choice right under it, with its reason on the row, only where a MoonBoard is in view", () => {
    const onChange = vi.fn();
    const input = makeInput({ moonboardKeepLighting: { choice: 'until_stopped', onChange } });
    expect(buildBoardLightingSections(input)[0].rows.map((row) => row.key)).toEqual([
      'putOnBoardKeepsLighting',
      'moonboardPutOnBoardKeepsLighting',
      'putOnBoardDrivesInSession',
    ]);
    const row = findRow(input, 'moonboardPutOnBoardKeepsLighting');
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row.label).toBe('settings:ble.lighting.keep.moonboardLabel');
    expect(row.subtitle).toBe('settings:ble.lighting.keep.moonboardDescription');
    expect(row.selectedKey).toBe('until_stopped');
    row.onSelect('30');
    expect(onChange).toHaveBeenCalledWith('30');
    expect(input.keepLighting.onChange).not.toHaveBeenCalled();
  });

  it('greys In a session too with its reason while the general choice is Off, whatever the MoonBoard says', () => {
    const on = findRow(makeInput(), 'putOnBoardDrivesInSession');
    if (on.kind !== 'toggle') throw new Error('not a toggle');
    expect(on).toMatchObject({
      label: 'settings:ble.lighting.keep.inSessionLabel',
      subtitle: 'settings:ble.lighting.keep.inSessionDescription',
      value: true,
      disabled: false,
    });
    const off = findRow(
      makeInput({
        keepLighting: { choice: 'off', onChange: vi.fn() },
        moonboardKeepLighting: { choice: 'until_stopped', onChange: vi.fn() },
      }),
      'putOnBoardDrivesInSession',
    );
    if (off.kind !== 'toggle') throw new Error('not a toggle');
    expect(off).toMatchObject({ subtitle: 'settings:ble.lighting.keep.inSessionOffReason', disabled: true });
  });

  it('hands the session switch its own handler', () => {
    const input = makeInput();
    const row = findRow(input, 'putOnBoardDrivesInSession');
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    row.onValueChange(false);
    expect(input.drivesInSession.onChange).toHaveBeenCalledWith(false);
  });

  // [case, keep, MoonBoard keep, auto-disconnect on, timeout s, footer says it cuts lighting]
  it.each<[string, '45' | 'off' | '30' | 'until_stopped', '30' | 'until_stopped' | null, boolean, number, boolean]>([
    ['auto-disconnect sooner than the window', '45', null, true, 30, true],
    ['auto-disconnect as long as the window', '45', null, true, 45, false],
    ['auto-disconnect later than the window', '30', null, true, 60, false],
    ['auto-disconnect off', '45', null, false, 10, false],
    ['keep lighting Off', 'off', null, true, 10, false],
    ['Until I stop, any timeout', 'until_stopped', null, true, 600, true],
    ["the MoonBoard's Until I stop", 'off', 'until_stopped', true, 600, true],
  ])(
    'says in the Bluetooth footer when auto-disconnect cuts lighting short: %s',
    (_name, keep, moon, enabled, seconds, cuts) => {
      const input = makeInput({
        keepLighting: { choice: keep, onChange: vi.fn() },
        moonboardKeepLighting: moon ? { choice: moon, onChange: vi.fn() } : null,
        autoDisconnect: { enabled, onChange: vi.fn() },
      });
      input.autoDisconnectTimeout = {
        seconds,
        options: [{ seconds, label: `${seconds} s` }],
        onChange: vi.fn(),
      };
      const bluetooth = buildBoardLightingSections(input).find((section) => section.key === 'bluetooth');
      expect(bluetooth?.footer).toBe(
        cuts
          ? `settings:ble.autoDisconnect.description settings:ble.autoDisconnect.cutsLighting {"timeout":"${seconds} s"}`
          : 'settings:ble.autoDisconnect.description',
      );
    },
  );
});
