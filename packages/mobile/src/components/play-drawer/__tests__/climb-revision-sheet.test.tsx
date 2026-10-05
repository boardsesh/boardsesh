// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbRevisionRow } from '@boardsesh/graphql/operations/climb-revisions';

type Props = Record<string, unknown>;

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  calls: [] as Array<{ boardType: string; climbUuid: string; enabled: boolean }>,
  refetch: vi.fn(),
}));
const offline = vi.hoisted(() => ({ blocked: false }));
const recorded = vi.hoisted(() => ({
  nativeBoard: [] as Array<Record<string, unknown>>,
  sprayBoard: [] as Array<Record<string, unknown>>,
  sheet: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ visible, children, footer, ...rest }: Props & { children?: ReactNode; footer?: ReactNode }) => {
    recorded.sheet.push({ visible, ...rest });
    return visible ? createElement('div', { 'data-testid': 'sheet' }, children, footer) : null;
  },
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('p', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../OfflineState', () => ({
  OfflineState: ({ reason }: { reason: string }) =>
    createElement('div', { 'data-testid': 'offline', 'data-reason': reason }),
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: Props) => {
    recorded.nativeBoard.push(props);
    return createElement('div', { 'data-testid': 'native-board' });
  },
}));
vi.mock('../SprayRevisionBoard', () => ({
  SprayRevisionBoard: (props: Props) => {
    recorded.sprayBoard.push(props);
    return createElement('div', { 'data-testid': 'spray-revision-board' });
  },
}));
vi.mock('../../../lib/graphql/hooks/use-climb-revisions', () => ({
  useClimbRevisions: (boardType: string, climbUuid: string, enabled: boolean) => {
    query.calls.push({ boardType, climbUuid, enabled });
    return { data: query.data, refetch: query.refetch, status: 'success', fetchStatus: 'idle' };
  },
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({
  useOfflineQueryState: () =>
    offline.blocked
      ? { isOffline: true, isBlocked: true, reason: 'offline' }
      : { isOffline: false, isBlocked: false, reason: null },
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (id: number | null | undefined) => (id == null ? null : `G${id}`),
  }),
}));
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 1000, boardHeight: 1500 }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#666', tertiaryBackground: '#eee' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 }, borderRadius: { lg: 12 } }));

import { clearSprayWallRegistry, getSprayWall, registerSprayWall } from '../../../lib/spray/spray-wall-registry';
import { ClimbRevisionSheet } from '../ClimbRevisionSheet';

const LAYOUT_ID = 4200;
const climb = { uuid: 'climb-1', name: 'Left Arete' } as unknown as Climb;

function revision(revisionNumber: number, overrides: Partial<ClimbRevisionRow> = {}): ClimbRevisionRow {
  return {
    revisionNumber,
    isCurrent: false,
    createdAt: '2026-09-01T10:00:00.000Z',
    name: `Name v${revisionNumber}`,
    description: null,
    frames: `p${revisionNumber}r1`,
    angle: 40,
    difficultyId: 16,
    changes: ['holds'],
    editor: { id: 'setter-1', displayName: 'Mara', avatarUrl: null },
    editedBySetter: true,
    sprayWallVersionNumber: 3,
    ...overrides,
  };
}

function registerWall(version: number) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle: 40,
    version,
    versionId: version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/current',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [{ id: 7, cx: 100, cy: 200, r: 18 }],
  });
}

const sprayProps = { boardName: 'spray' as const, layoutId: LAYOUT_ID, sizeId: LAYOUT_ID, setIds: '1' };
const kilterProps = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2' };

function renderSheet(
  board: typeof sprayProps | typeof kilterProps,
  revisionNumber: number | null,
  options: { visible?: boolean } = {},
) {
  return render(
    <ClimbRevisionSheet
      visible={options.visible ?? true}
      climb={climb}
      {...board}
      revisionNumber={revisionNumber}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  clearSprayWallRegistry();
  query.data = undefined;
  query.calls = [];
  offline.blocked = false;
  recorded.nativeBoard = [];
  recorded.sprayBoard = [];
  recorded.sheet = [];
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('ClimbRevisionSheet — which board draws a revision', () => {
  it('draws a catalogue revision through the ordinary board image, with the revision frames', () => {
    query.data = [revision(2, { isCurrent: true, sprayWallVersionNumber: null }), revision(1)];
    renderSheet(kilterProps, 1);

    expect(screen.getByTestId('native-board')).not.toBeNull();
    expect(recorded.sprayBoard).toHaveLength(0);
    expect(recorded.nativeBoard.at(-1)).toMatchObject({
      frames: 'p1r1',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      boardWidth: 1000,
      boardHeight: 1500,
    });
    // Never the play surface: an old version is not the board being climbed.
    expect(recorded.nativeBoard.at(-1)?.playSurface).toBeUndefined();
  });

  it('draws a spray revision on the registered wall version the same way', () => {
    registerWall(3);
    query.data = [revision(2, { isCurrent: true }), revision(1, { sprayWallVersionNumber: 3 })];
    renderSheet(sprayProps, 1);

    expect(screen.getByTestId('native-board')).not.toBeNull();
    expect(recorded.sprayBoard).toHaveLength(0);
  });

  it('hands a spray revision from an OLDER wall version to SprayRevisionBoard', () => {
    registerWall(3);
    const registeredBefore = getSprayWall(LAYOUT_ID);
    query.data = [revision(2, { isCurrent: true }), revision(1, { sprayWallVersionNumber: 1 })];
    renderSheet(sprayProps, 1);

    expect(screen.getByTestId('spray-revision-board')).not.toBeNull();
    expect(recorded.nativeBoard).toHaveLength(0);
    expect(recorded.sprayBoard.at(-1)).toEqual({ wallUuid: 'wall-uuid', version: 1, frames: 'p1r1' });
    expect(getSprayWall(LAYOUT_ID)).toBe(registeredBefore);
  });

  it('switches renderer as Older / Newer cross a reset', () => {
    registerWall(3);
    query.data = [revision(2, { isCurrent: true }), revision(1, { sprayWallVersionNumber: 1 })];
    renderSheet(sprayProps, 2);
    expect(screen.queryByTestId('native-board')).not.toBeNull();

    fireEvent.click(screen.getByText('mobile.revisions.sheet.older'));
    expect(screen.queryByTestId('native-board')).toBeNull();
    expect(screen.queryByTestId('spray-revision-board')).not.toBeNull();

    fireEvent.click(screen.getByText('mobile.revisions.sheet.newer'));
    expect(screen.queryByTestId('native-board')).not.toBeNull();
    expect(screen.queryByTestId('spray-revision-board')).toBeNull();
  });

  it('says the wall photo is gone, and keeps the rest, when the revision has no wall version', () => {
    registerWall(3);
    query.data = [
      revision(2, { isCurrent: true }),
      revision(1, { sprayWallVersionNumber: null, description: 'Start matched on the pinch' }),
    ];
    renderSheet(sprayProps, 1);

    expect(screen.getByText('mobile.revisions.sheet.photoUnavailable')).not.toBeNull();
    expect(recorded.nativeBoard).toHaveLength(0);
    expect(recorded.sprayBoard).toHaveLength(0);
    // Name, grade, notes and editor are all still there.
    expect(screen.getByText('Name v1')).not.toBeNull();
    expect(screen.getByText('G16')).not.toBeNull();
    expect(screen.getByText('Start matched on the pinch')).not.toBeNull();
    expect(screen.getByText(/"editor":"Mara"/)).not.toBeNull();
  });

  it('picks the renderer again when the wall is reset behind the open sheet', () => {
    registerWall(3);
    query.data = [revision(2, { isCurrent: true }), revision(1, { sprayWallVersionNumber: 3 })];
    renderSheet(sprayProps, 1);
    expect(screen.queryByTestId('native-board')).not.toBeNull();

    act(() => registerWall(4));

    expect(screen.queryByTestId('native-board')).toBeNull();
    expect(recorded.sprayBoard.at(-1)).toMatchObject({ version: 3 });
  });
});

describe('ClimbRevisionSheet — reading one', () => {
  it('opens on the tapped revision and walks older and newer', () => {
    query.data = [revision(3, { isCurrent: true }), revision(2), revision(1)];
    renderSheet(kilterProps, 2);

    expect(screen.getByText('Name v2')).not.toBeNull();
    expect(screen.getByText(/"position":2,"total":3/)).not.toBeNull();

    fireEvent.click(screen.getByText('mobile.revisions.sheet.older'));
    expect(screen.getByText('Name v1')).not.toBeNull();
    expect((screen.getByText('mobile.revisions.sheet.older') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('mobile.revisions.sheet.newer'));
    fireEvent.click(screen.getByText('mobile.revisions.sheet.newer'));
    expect(screen.getByText('Name v3')).not.toBeNull();
    expect((screen.getByText('mobile.revisions.sheet.newer') as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts from the tapped row again each time it opens', () => {
    query.data = [revision(3, { isCurrent: true }), revision(2), revision(1)];
    const view = renderSheet(kilterProps, 3);
    fireEvent.click(screen.getByText('mobile.revisions.sheet.older'));
    expect(screen.getByText('Name v2')).not.toBeNull();

    const reopen = (visible: boolean, revisionNumber: number) =>
      view.rerender(
        <ClimbRevisionSheet
          visible={visible}
          climb={climb}
          {...kilterProps}
          revisionNumber={revisionNumber}
          onClose={vi.fn()}
        />,
      );
    reopen(false, 3);
    reopen(true, 1);

    expect(screen.getByText('Name v1')).not.toBeNull();
  });

  it('falls back to the newest revision when the tapped one has been pruned', () => {
    query.data = [revision(9, { isCurrent: true }), revision(8), revision(1)];
    renderSheet(kilterProps, 4);
    expect(screen.getByText('Name v9')).not.toBeNull();
  });

  it('marks an old version as look-only, and the current one not', () => {
    query.data = [revision(2, { isCurrent: true }), revision(1)];
    renderSheet(kilterProps, 1);
    expect(screen.getByText('mobile.revisions.sheet.readOnly')).not.toBeNull();

    fireEvent.click(screen.getByText('mobile.revisions.sheet.newer'));
    expect(screen.queryByText('mobile.revisions.sheet.readOnly')).toBeNull();
  });

  it('offers nothing but Older and Newer: no restore, no queue, no light-up', () => {
    query.data = [revision(2, { isCurrent: true }), revision(1)];
    const { container } = renderSheet(kilterProps, 1);
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['mobile.revisions.sheet.older', 'mobile.revisions.sheet.newer']);
  });

  it('shows the grade on spray only, where the setter gives it', () => {
    query.data = [revision(2, { isCurrent: true }), revision(1)];
    const kilter = renderSheet(kilterProps, 1);
    expect(screen.queryByText('G16')).toBeNull();
    kilter.unmount();

    registerWall(3);
    query.data = [revision(2, { isCurrent: true }), revision(1, { difficultyId: null })];
    renderSheet(sprayProps, 1);
    expect(screen.getByText('mobile.revisions.sheet.noGrade')).not.toBeNull();
  });

  it('names who edited and in which role', () => {
    query.data = [
      revision(2, { isCurrent: true, editedBySetter: false, editor: { id: 'o', displayName: 'Jo', avatarUrl: null } }),
      revision(1, { editor: null }),
    ];
    renderSheet(kilterProps, 2);
    expect(screen.getByText(/"editor":"Jo","role":"mobile.revisions.tagWallEditor"/)).not.toBeNull();

    fireEvent.click(screen.getByText('mobile.revisions.sheet.older'));
    expect(screen.getByText('mobile.revisions.deletedEditor')).not.toBeNull();
  });

  it('shows the honest offline placard, not an empty sheet, with no connection', () => {
    offline.blocked = true;
    renderSheet(kilterProps, 1);

    expect(screen.getByTestId('offline').getAttribute('data-reason')).toBe('offline');
    expect(recorded.nativeBoard).toHaveLength(0);
  });

  it('does not ask for the history while closed, and stays closed without a climb', () => {
    renderSheet(kilterProps, 1, { visible: false });
    expect(query.calls.at(-1)).toMatchObject({ boardType: 'kilter', climbUuid: 'climb-1', enabled: false });
    expect(screen.queryByTestId('sheet')).toBeNull();

    render(<ClimbRevisionSheet visible climb={null} {...kilterProps} revisionNumber={1} onClose={vi.fn()} />);
    expect(recorded.sheet.at(-1)?.visible).toBe(false);
  });
});
