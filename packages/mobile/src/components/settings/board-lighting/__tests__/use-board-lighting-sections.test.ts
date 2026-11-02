// @vitest-environment jsdom
// Settings › Board's lighting half, as the hook wires it: one Stop driving
// after row for every board, MoonBoards included, writing its own setting
// (2.7, spec B4; the MoonBoard's own row went in 2026-11).
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoreRow } from '../../../MoreForm.types';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../../../../settings';

const inView = vi.hoisted(() => ({
  connectedBoardName: null as string | null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
const openExternalUrl = vi.hoisted(() => vi.fn<(url: string, source: string) => Promise<void>>());
vi.mock('../../../../lib/open-url', () => ({ openExternalUrl }));
vi.mock('../../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () =>
    inView.connectedBoardName === null ? null : { boardName: inView.connectedBoardName },
}));

import { useBoardLightingSections } from '../use-board-lighting-sections';

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
  inView.connectedBoardName = null;
  setSetting('putOnBoardKeepsLighting', DEFAULT_SETTINGS.putOnBoardKeepsLighting);
});

describe('useBoardLightingSections: Stop driving after', () => {
  it.each<[string, string | null]>([
    ['no board connected', null],
    ['a Kilter connected', 'kilter'],
    ['a MoonBoard connected', 'moonboard'],
  ])('with %s, shows the one Stop driving after row', (_case, connectedBoardName) => {
    inView.connectedBoardName = connectedBoardName;
    const keys = rowsOf()
      .filter((row) => row.kind === 'select')
      .map((row) => row.key);
    expect(keys).toEqual(['putOnBoardKeepsLighting']);
  });

  it('writes the one choice from its row, a MoonBoard connected too', () => {
    inView.connectedBoardName = 'moonboard';
    const rows = rowsOf();
    act(() => selectRow(rows, 'putOnBoardKeepsLighting').onSelect('60'));
    expect(getSetting('putOnBoardKeepsLighting')).toBe('60');
  });
});

describe('useBoardLightingSections: the driving help row', () => {
  it('opens the www help on driving the wall', () => {
    const row = rowsOf().find((candidate) => candidate.key === 'drivingHelp');
    if (row?.kind !== 'nav') throw new Error('no help row');
    row.onPress();
    expect(openExternalUrl).toHaveBeenCalledOnce();
    expect(openExternalUrl.mock.calls[0][0]).toMatch(/\/help\/board-and-bluetooth#driving$/);
  });
});
