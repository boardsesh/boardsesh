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
    alwaysDrive: { enabled: false, onChange: vi.fn() },
    playlistTapLoadsQueue: { enabled: false, onChange: vi.fn() },
    moonboardLightAdjacentHolds: null,
    ...overrides,
  };
}

function findRowKeys(input: BoardLightingModelInput): string[] {
  return buildBoardLightingSections(input).flatMap((section) => section.rows.map((row) => row.key));
}

function findRow(input: BoardLightingModelInput, key: string): MoreRow {
  const row = buildBoardLightingSections(input)
    .flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe('buildBoardLightingSections', () => {
  // Light automatically leads: it greys the rows under it, so the climber reads the switch first.
  it('lists Light automatically, when Put on board stops driving, what happens then, then what a list tap does', () => {
    const sections = buildBoardLightingSections(makeInput());
    expect(sections.map((section) => [section.key, section.rows.map((row) => row.key)])).toEqual([
      ['lightingAuto', ['alwaysDrive']],
      ['keepLighting', ['putOnBoardKeepsLighting', 'putOnBoardDrivesInSession']],
      ['drivingEnds', ['disconnectWhenDrivingEnds']],
      ['lightingMore', ['playlistTapLoadsQueue']],
    ]);
  });

  // One switch (2026-11): Light automatically always drives the wall. It
  // replaced Light the board when I tap a climb and Light the board as I swipe.
  it('offers one Light automatically switch, alone in its group, with its caption and no footer while off', () => {
    const [lighting, , , more] = buildBoardLightingSections(makeInput());
    expect(lighting.rows).toHaveLength(1);
    const [always] = lighting.rows;
    if (always.kind !== 'toggle') throw new Error('not a toggle');
    expect(always).toMatchObject({
      key: 'alwaysDrive',
      label: 'settings:ble.lighting.alwaysDriveLabel',
      subtitle: 'settings:ble.lighting.alwaysDriveDescription',
      value: false,
    });
    // The page's lighting title sits on the first card.
    expect(lighting.title).toBe('settings:ble.lighting.title');
    // How to stop (and that a stop holds until a disconnect) is only true with it on.
    expect(lighting.footer).toBeUndefined();
    expect(buildBoardLightingSections(makeInput({ alwaysDrive: { enabled: true, onChange: vi.fn() } }))[0].footer).toBe(
      'settings:ble.lighting.alwaysDriveFooter',
    );
    // The last card has no header, so it reads as the same lighting page.
    expect(more.title).toBeUndefined();
    expect(findRowKeys(makeInput())).not.toContain('lightOnClimbTap');
    expect(findRowKeys(makeInput())).not.toContain('lightOnSwipe');
  });

  it('keeps Stop driving after untitled under the lighting title, with its description as a footer', () => {
    const [, keep, drivingEnds] = buildBoardLightingSections(makeInput());
    expect(keep.title).toBeUndefined();
    expect(keep.footer).toBe('settings:ble.lighting.keep.footer');
    // Stop driving after's second card: no header of its own.
    expect(drivingEnds.title).toBeUndefined();
  });

  // The footer says what the chosen length does: a clock each lit climb
  // restarts, a drive until you stop it, or one climb and no drive.
  it.each([
    ['30', 'settings:ble.lighting.keep.footer'],
    ['45', 'settings:ble.lighting.keep.footer'],
    ['60', 'settings:ble.lighting.keep.footer'],
    ['120', 'settings:ble.lighting.keep.footer'],
    ['300', 'settings:ble.lighting.keep.footer'],
    ['until_stopped', 'settings:ble.lighting.keep.footerUntilStopped'],
    ['off', 'settings:ble.lighting.keep.footerOff'],
  ] as const)('footers Stop driving after set to %s with what it does', (choice, footer) => {
    const [, keep] = buildBoardLightingSections(makeInput({ keepLighting: { choice, onChange: vi.fn() } }));
    expect(keep.footer).toBe(footer);
  });

  // The preview-first card and the What's New spotlight both retire; this row is
  // the way back to the www help on driving the wall.
  it('adds a help row under Disconnect Bluetooth when driving ends when the page can open the help', () => {
    expect(findRowKeys(makeInput())).not.toContain('drivingHelp');
    const onOpenDrivingHelp = vi.fn();
    const [, , drivingEnds] = buildBoardLightingSections(makeInput({ onOpenDrivingHelp }));
    expect(drivingEnds.rows.map((row) => row.key)).toEqual(['disconnectWhenDrivingEnds', 'drivingHelp']);
    const row = drivingEnds.rows[1];
    if (row.kind !== 'nav') throw new Error('not a nav row');
    expect(row).toMatchObject({ label: 'settings:ble.lighting.drivingHelp', external: true });
    row.onPress();
    expect(onOpenDrivingHelp).toHaveBeenCalledOnce();
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
    expect(input.alwaysDrive.onChange).not.toHaveBeenCalled();
  });

  it('hands the Light automatically flip to its own handler', () => {
    const input = makeInput();
    const always = findRow(input, 'alwaysDrive');
    if (always.kind !== 'toggle') throw new Error('not a toggle');
    always.onValueChange(true);
    expect(input.alwaysDrive.onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(input.playlistTapLoadsQueue.onChange).not.toHaveBeenCalled();
  });
});

// Light automatically on: this phone always drives the wall while it holds the
// board, so Stop driving after (and the MoonBoard's) doesn't apply. The rows
// stay where they are, greyed, each saying why. In a session too still
// decides a crew session, so it is never greyed then.
describe('buildBoardLightingSections: Light automatically on', () => {
  const ON = { alwaysDrive: { enabled: true, onChange: vi.fn() } };

  it('greys Stop driving after, says why on the row, and drops the footer about Put on board', () => {
    const sections = buildBoardLightingSections(makeInput(ON));
    const row = findRow(makeInput(ON), 'putOnBoardKeepsLighting');
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row.disabled).toBe(true);
    // Where a screen reader lands on it, as the MoonBoard row does.
    expect(row.subtitle).toBe('settings:ble.lighting.keep.alwaysDriveReason');
    // Still shows the climber's choice, for when they turn it off again.
    expect(row.selectedKey).toBe('45');
    expect(sections[1].key).toBe('keepLighting');
    expect(sections[1].footer).toBeUndefined();
  });

  it('greys the MoonBoard row and puts the reason on it', () => {
    const row = findRow(
      makeInput({ ...ON, moonboardKeepLighting: { choice: 'until_stopped', onChange: vi.fn() } }),
      'moonboardPutOnBoardKeepsLighting',
    );
    if (row.kind !== 'select') throw new Error('not a select');
    expect(row).toMatchObject({
      disabled: true,
      subtitle: 'settings:ble.lighting.keep.alwaysDriveReason',
      accessibilityLabel: 'settings:ble.lighting.keep.moonboardAccessibilityLabel',
    });
  });

  it('keeps In a session too live, even with Stop driving after at Right away', () => {
    const row = findRow(
      makeInput({ ...ON, keepLighting: { choice: 'off', onChange: vi.fn() } }),
      'putOnBoardDrivesInSession',
    );
    if (row.kind !== 'toggle') throw new Error('not a toggle');
    expect(row.disabled).toBe(false);
    expect(toggleRowSubtitle(row)).toEqual({
      text: 'settings:ble.lighting.keep.inSessionDescription',
      isReason: false,
    });
  });

  it('leaves every row live with it off, the general row with no caption', () => {
    const input = makeInput({ moonboardKeepLighting: { choice: 'until_stopped', onChange: vi.fn() } });
    for (const key of ['putOnBoardKeepsLighting', 'moonboardPutOnBoardKeepsLighting'] as const) {
      const row = findRow(input, key);
      if (row.kind !== 'select') throw new Error('not a select');
      expect(row.disabled).toBeFalsy();
    }
    const general = findRow(input, 'putOnBoardKeepsLighting');
    if (general.kind !== 'select') throw new Error('not a select');
    expect(general.subtitle).toBeUndefined();
  });
});

// Stop driving after (2.7, spec B4): the card under Light automatically.
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
    expect(buildBoardLightingSections(input)[1].rows.map((row) => row.key)).toEqual([
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
