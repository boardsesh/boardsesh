import { describe, expect, it, vi } from 'vitest';
import { buildBoardLightingSections, type BoardLightingModelInput } from '../board-lighting-model';
import type { MoreRow } from '../../../MoreForm.types';
import { toggleRowSubtitle } from '../../../MoreForm.logic';

function makeInput(overrides: Partial<BoardLightingModelInput> = {}): BoardLightingModelInput {
  return {
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    keepLighting: { choice: '45', onChange: vi.fn() },
    moonboardKeepLighting: null,
    drivesInSession: { enabled: true, onChange: vi.fn() },
    disconnectWhenDrivingEnds: { enabled: false, onChange: vi.fn() },
    lightOnSwipe: { enabled: true, onChange: vi.fn() },
    lightOnClimbTap: { enabled: false, onChange: vi.fn() },
    playlistTapLoadsQueue: { enabled: false, onChange: vi.fn() },
    moonboardLightAdjacentHolds: null,
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
  it('lists when Put on board stops driving, what happens then, what lights the board on its own, then what a list tap does', () => {
    const sections = buildBoardLightingSections(makeInput());
    expect(sections.map((section) => [section.key, section.rows.map((row) => row.key)])).toEqual([
      ['keepLighting', ['putOnBoardKeepsLighting', 'putOnBoardDrivesInSession']],
      ['drivingEnds', ['disconnectWhenDrivingEnds']],
      ['lightingAuto', ['lightOnClimbTap', 'lightOnSwipe']],
      ['lightingMore', ['playlistTapLoadsQueue']],
    ]);
  });

  // Six climbers in six read the old side-by-side pair as two independent
  // switches. The swipe switch only matters once a climb is on the wall, so it
  // sits under the tap switch in a group of its own, and its subtitle says so.
  it('nests the swipe switch under the tap switch, alone in their group, with its caption', () => {
    const [, , lighting, more] = buildBoardLightingSections(makeInput());
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
    const [keep, drivingEnds, lighting] = buildBoardLightingSections(makeInput());
    expect(keep.title).toBe('settings:ble.lighting.title');
    expect(keep.footer).toBe('settings:ble.lighting.keep.footer');
    // Stop driving after's second card: no header of its own.
    expect(drivingEnds.title).toBeUndefined();
    expect(lighting.title).toBe('settings:ble.lighting.autoTitle');
    expect(lighting.footer).toBe('settings:ble.lighting.description');
  });

  // 2.7: auto-disconnect is gone; this switch is what frees the board now.
  it('offers Disconnect Bluetooth when driving ends under Stop driving after, off unless the climber chose it', () => {
    const input = makeInput();
    const row = findRow(input, 'disconnectWhenDrivingEnds');
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    expect(row).toMatchObject({
      label: 'settings:ble.lighting.drivingEnds.label',
      subtitle: 'settings:ble.lighting.drivingEnds.description',
      value: false,
    });
    row.onValueChange(true);
    expect(input.disconnectWhenDrivingEnds.onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(input.drivesInSession.onChange).not.toHaveBeenCalled();
    const on = findRow(
      makeInput({ disconnectWhenDrivingEnds: { enabled: true, onChange: vi.fn() } }),
      'disconnectWhenDrivingEnds',
    );
    if (on.kind !== 'toggle') throw new Error('not a toggle');
    expect(on.value).toBe(true);
    const sectionKeys = buildBoardLightingSections(input).flatMap((section) => section.rows.map((r) => r.key));
    expect(sectionKeys).not.toContain('autoDisconnectBle');
    expect(sectionKeys).not.toContain('autoDisconnectTimeoutSeconds');
  });

  it('adds the MoonBoard extra-LED switch only for a MoonBoard, after the playlist switch', () => {
    expect(buildBoardLightingSections(makeInput())[3].rows.map((row) => row.key)).toEqual(['playlistTapLoadsQueue']);
    const withMoonboard = buildBoardLightingSections(
      makeInput({ moonboardLightAdjacentHolds: { enabled: true, onChange: vi.fn() } }),
    );
    expect(withMoonboard[3].rows.map((row) => row.key)).toEqual([
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

// Stop driving after (2.7, spec B4): the first card.
describe('buildBoardLightingSections: Stop driving after', () => {
  it('offers Right away, 30 s, 45 s, 1, 2 and 5 minutes, and Until I stop', () => {
    const row = findRow(makeInput(), 'putOnBoardKeepsLighting');
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row.label).toBe('settings:ble.lighting.keep.label');
    expect(row.selectedKey).toBe('45');
    expect(row.options).toEqual([
      { key: 'off', label: 'settings:ble.lighting.keep.off' },
      { key: '30', label: 'settings:ble.lighting.keep.options.30' },
      { key: '45', label: 'settings:ble.lighting.keep.options.45' },
      { key: '60', label: 'settings:ble.lighting.keep.options.60' },
      { key: '120', label: 'settings:ble.lighting.keep.options.120' },
      { key: '300', label: 'settings:ble.lighting.keep.options.300' },
      { key: 'until_stopped', label: 'settings:ble.lighting.keep.untilStopped' },
    ]);
  });

  it('hands a known choice to its handler and ignores anything else', () => {
    const input = makeInput();
    const row = findRow(input, 'putOnBoardKeepsLighting');
    if (row.kind !== 'select') throw new Error('not a select');
    row.onSelect('until_stopped');
    row.onSelect('300');
    row.onSelect('90');
    expect(input.keepLighting.onChange).toHaveBeenCalledTimes(2);
    expect(vi.mocked(input.keepLighting.onChange).mock.calls).toEqual([['until_stopped'], ['300']]);
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
    // Named on its own for the rotor, Voice Control and TalkBack (spec B4).
    expect(row.accessibilityLabel).toBe('settings:ble.lighting.keep.moonboardAccessibilityLabel');
    expect(row.subtitle).toBe('settings:ble.lighting.keep.moonboardDescription');
    expect(row.selectedKey).toBe('until_stopped');
    row.onSelect('30');
    expect(onChange).toHaveBeenCalledWith('30');
    expect(input.keepLighting.onChange).not.toHaveBeenCalled();
  });

  it('greys In a session too with its reason while the general choice is Right away, whatever the MoonBoard says', () => {
    const on = findRow(makeInput(), 'putOnBoardDrivesInSession');
    if (on.kind !== 'toggle') throw new Error('not a toggle');
    expect(on).toMatchObject({
      label: 'settings:ble.lighting.keep.inSessionLabel',
      accessibilityLabel: 'settings:ble.lighting.keep.inSessionAccessibilityLabel',
      subtitle: 'settings:ble.lighting.keep.inSessionDescription',
      value: true,
      disabled: false,
    });
    expect(toggleRowSubtitle(on)).toEqual({ text: 'settings:ble.lighting.keep.inSessionDescription', isReason: false });
    const off = findRow(
      makeInput({
        keepLighting: { choice: 'off', onChange: vi.fn() },
        moonboardKeepLighting: { choice: 'until_stopped', onChange: vi.fn() },
      }),
      'putOnBoardDrivesInSession',
    );
    if (off.kind !== 'toggle') throw new Error('not a toggle');
    expect(off).toMatchObject({ disabledReason: 'settings:ble.lighting.keep.inSessionOffReason', disabled: true });
    // The reason replaces the description while greyed out.
    expect(toggleRowSubtitle(off)).toEqual({ text: 'settings:ble.lighting.keep.inSessionOffReason', isReason: true });
  });

  it('hands the session switch its own handler', () => {
    const input = makeInput();
    const row = findRow(input, 'putOnBoardDrivesInSession');
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    row.onValueChange(false);
    expect(input.drivesInSession.onChange).toHaveBeenCalledWith(false);
  });
});
