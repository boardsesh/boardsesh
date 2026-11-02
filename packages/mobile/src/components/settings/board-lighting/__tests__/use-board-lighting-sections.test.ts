// @vitest-environment jsdom
// Settings › Board's lighting half, as the hook wires it: where a MoonBoard is
// in view the MoonBoard's own keep-lighting row shows, and each row writes its
// own setting (2.7, spec B4).
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoreRow } from '../../../MoreForm.types';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../../../../settings';

const inView = vi.hoisted(() => ({
  activeIsMoonboard: false,
  savedBoardTypes: [] as string[],
  connectedBoardName: null as string | null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../hooks/use-active-board-is-moonboard', () => ({
  useActiveBoardIsMoonboard: () => inView.activeIsMoonboard,
}));
vi.mock('../../../../settings/offline-boards', () => ({
  useOfflineBoards: () => inView.savedBoardTypes.map((boardType, index) => ({ uuid: `board-${index}`, boardType })),
}));
vi.mock('../../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () =>
    inView.connectedBoardName === null ? null : { boardName: inView.connectedBoardName },
}));

import { useBoardLightingSections } from '../use-board-lighting-sections';

const MOONBOARD_ROW = 'moonboardPutOnBoardKeepsLighting';

function rowsOf(): MoreRow[] {
  const { result } = renderHook(() => useBoardLightingSections());
  return result.current.flatMap((section) => section.rows);
}

function selectRow(rows: MoreRow[], key: string) {
  const row = rows.find((candidate) => candidate.key === key);
  if (row?.kind !== 'select') throw new Error(`no select row ${key}`);
  return row;
}

beforeEach(() => {
  inView.activeIsMoonboard = false;
  inView.savedBoardTypes = [];
  inView.connectedBoardName = null;
  setSetting('putOnBoardKeepsLighting', DEFAULT_SETTINGS.putOnBoardKeepsLighting);
  setSetting('moonboardPutOnBoardKeepsLighting', DEFAULT_SETTINGS.moonboardPutOnBoardKeepsLighting);
});

describe('useBoardLightingSections: the MoonBoard keep-lighting row', () => {
  it.each<[string, Partial<typeof inView>, boolean]>([
    ['no MoonBoard anywhere', { savedBoardTypes: ['kilter'] }, false],
    ['a saved MoonBoard only', { savedBoardTypes: ['kilter', 'moonboard'] }, true],
    ['the active board is a MoonBoard', { activeIsMoonboard: true }, true],
    ['a connected MoonBoard', { connectedBoardName: 'moonboard' }, true],
  ])('with %s, shows it: %s', (_case, view, shown) => {
    Object.assign(inView, view);
    expect(rowsOf().some((row) => row.key === MOONBOARD_ROW)).toBe(shown);
  });

  it("writes the MoonBoard's own choice, never the general one", () => {
    inView.savedBoardTypes = ['moonboard'];
    const rows = rowsOf();
    act(() => selectRow(rows, MOONBOARD_ROW).onSelect('30'));
    expect(getSetting('moonboardPutOnBoardKeepsLighting')).toBe('30');
    expect(getSetting('putOnBoardKeepsLighting')).toBe(DEFAULT_SETTINGS.putOnBoardKeepsLighting);
  });

  it('writes the general choice from its own row, leaving the MoonBoard’s', () => {
    inView.savedBoardTypes = ['moonboard'];
    const rows = rowsOf();
    act(() => selectRow(rows, 'putOnBoardKeepsLighting').onSelect('60'));
    expect(getSetting('putOnBoardKeepsLighting')).toBe('60');
    expect(getSetting('moonboardPutOnBoardKeepsLighting')).toBe(DEFAULT_SETTINGS.moonboardPutOnBoardKeepsLighting);
  });
});
