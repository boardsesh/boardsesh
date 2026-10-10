// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import CreateClimbRoute from '../create';
import {
  clearSprayWallRegistry,
  LIVE_SPRAY_WALL_ARCHIVE_STATE,
  registerSprayWall,
  settleSprayWallDiscoveryMiss,
} from '../../../../src/lib/spray/spray-wall-registry';

// Mutable across tests so each seeds its own deep-link params + stored board.
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string | string[]> }));
const activeBoard = vi.hoisted(() => ({ current: null as UserBoard | null | undefined }));
const activeBoardPending = vi.hoisted(() => ({ current: false }));
const router = vi.hoisted(() => ({
  canGoBack: vi.fn(() => false),
  back: vi.fn(),
  replace: vi.fn(),
}));
const showToast = vi.hoisted(() => vi.fn());

// The board tuple the editor was handed, captured from the stubbed screen so a
// test can assert WHICH wall it opened on — the point of the fallback rules.
const editorBoard = vi.hoisted(() => ({ latest: null as null | Record<string, unknown> }));

// Every mount of the route must claim the BLE picker (#5868) — captured so a
// future early return that forgets to render the host fails loudly instead of
// silently dropping back to the app-root picker landing behind this modal.
const devicePickerHostMounts = vi.hoisted(() => ({ count: 0, lastRegisterExternal: undefined as boolean | undefined }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => router,
}));

// Keys, not sentences: what matters here is WHICH reason the route picked, and
// asserting on English copy would make every reword a test failure.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#fff' } }),
}));

vi.mock('../../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

// Real board-config: the route reads both SUPPORTED_BOARDS and the
// board-capability table, and stubbing the latter here would fork the per-board
// feature switches away from the one table this route is supposed to follow.
// The package is pure TS constants — nothing native to keep out of the test.

vi.mock('../../../../src/components/create-climb/CreateClimbScreen', () => ({
  CreateClimbScreen: (props: { board: Record<string, unknown> }) => {
    editorBoard.latest = props.board;
    return createElement('div', { 'data-editor': 'true' });
  },
}));

vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

vi.mock('../../../../src/components/ble/DevicePickerSheetHost', () => ({
  DevicePickerSheetHost: (props: { registerExternal?: boolean }) => {
    devicePickerHostMounts.count += 1;
    devicePickerHostMounts.lastRegisterExternal = props.registerExternal;
    return null;
  },
}));

vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current, isPending: activeBoardPending.current }),
}));

vi.mock('../../../../src/lib/create-climb-screen-key', () => ({
  createClimbScreenKey: (editClimbUuid: string | undefined, board: { boardName: string }) =>
    `${editClimbUuid ?? 'new'}-${board.boardName}`,
}));

// A stored Kilter board, complete enough to open the editor bare.
const KILTER_ACTIVE_BOARD = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
} as unknown as UserBoard;

const WOODS_ACTIVE_BOARD = {
  boardType: 'woods',
  layoutId: 1,
  sizeId: 1,
  setIds: '1',
  angle: 40,
} as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.current = {};
  activeBoard.current = null;
  activeBoardPending.current = false;
  editorBoard.latest = null;
  devicePickerHostMounts.count = 0;
  devicePickerHostMounts.lastRegisterExternal = undefined;
  router.canGoBack.mockReturnValue(false);
});

describe('CreateClimbRoute board resolution', () => {
  it('opens the editor on the board and geometry the link named', () => {
    routeParams.current = { boardName: 'tension', layoutId: '8', sizeId: '25', setIds: '20,21', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(editorBoard.latest).toEqual({
      boardName: 'tension',
      layoutId: 8,
      sizeId: 25,
      setIds: '20,21',
      angle: 40,
    });
  });

  it('opens bare on the active board when the link carries no params', () => {
    activeBoard.current = KILTER_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(editorBoard.latest).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });

  // The #3804 fallback still applies to a typo'd board name — but the geometry
  // that came with it described THAT board, so it must not ride along onto the
  // active board's wall.
  it('drops the link geometry when falling back from an unrecognised board name', () => {
    routeParams.current = { boardName: 'notaboard', layoutId: '8', sizeId: '25', setIds: '20,21', angle: '55' };
    activeBoard.current = KILTER_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(editorBoard.latest).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
    });
  });
});

describe('CreateClimbRoute Woods authoring', () => {
  it.each(['1', '2'])('opens Woods size %s from a cold link', (sizeId) => {
    routeParams.current = { boardName: 'woods', layoutId: '1', sizeId, setIds: '1', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(editorBoard.latest).toMatchObject({ boardName: 'woods', sizeId: Number(sizeId) });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('leaves an incomplete Woods link instead of loading a different board', () => {
    routeParams.current = { boardName: 'woods', forkFrames: 'p0r4p1r3' };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    router.canGoBack.mockReturnValue(true);
    render(<CreateClimbRoute />);
    expect(router.back).toHaveBeenCalled();
    expect(editorBoard.latest).toBeNull();
  });

  it.each([
    { layoutId: '1', sizeId: '99', angle: '40' },
    { layoutId: '8', sizeId: '1', angle: '40' },
    { layoutId: '1', sizeId: '1', angle: '42' },
  ])('rejects invalid Woods geometry: %j', (geometry) => {
    routeParams.current = { boardName: 'woods', setIds: '1', ...geometry };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    render(<CreateClimbRoute />);
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(editorBoard.latest).toBeNull();
  });

  it('opens bare on the active Woods board', () => {
    activeBoard.current = WOODS_ACTIVE_BOARD;
    render(<CreateClimbRoute />);
    expect(editorBoard.latest).toMatchObject({ boardName: 'woods', sizeId: 1 });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('waits while the active board is still loading', () => {
    activeBoard.current = undefined;
    activeBoardPending.current = true;
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });
});

// #4760: `resolvedBoard == null` used to mean both "still loading" and "there is
// no board to open on", and only the first was handled — so the second span on a
// spinner for ever, over a transparent modal with nothing to dismiss. Every case
// below has to leave the route AND say why.
describe('CreateClimbRoute unresolvable board (#4760)', () => {
  it('leaves instead of spinning when the climber has no active board', () => {
    activeBoard.current = null;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.noUsableBoard', 'error');
  });

  // The generalised form of the original report: a board type that reaches a
  // client the create screen doesn't know about (or a stale stored board — the
  // active-board store does no shape validation).
  it('leaves instead of spinning when the active board type is unknown to this build', () => {
    activeBoard.current = {
      boardType: 'newboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      angle: 40,
    } as unknown as UserBoard;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.boardTypeUnsupported', 'error');
  });

  // The capability-off reason has its own file (`create-no-author-board.test.tsx`)
  // because every board in the table can author today, so producing it takes a
  // stubbed capability — and this file deliberately runs against the real one.
  it('separates an incomplete board config from an unsupported board', () => {
    routeParams.current = { boardName: 'woods', layoutId: '1', sizeId: '99', setIds: '1', angle: '40' };
    activeBoard.current = KILTER_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.boardConfigIncomplete', 'error');
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
  });

  // The one case that must stay mute: the spinner is the honest answer while the
  // active-board query is still on its first fetch, so no toast and no exit.
  it('stays silent while the active board is still loading', () => {
    activeBoard.current = undefined;
    activeBoardPending.current = true;

    const { container } = render(<CreateClimbRoute />);

    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(showToast).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });

  it('says nothing when the editor opens normally', () => {
    activeBoard.current = KILTER_ACTIVE_BOARD;

    render(<CreateClimbRoute />);

    expect(showToast).not.toHaveBeenCalled();
  });
});

// #5868: the app-root BLE picker lands behind this transparentModal route, so
// every branch of this route (not just the resolved-editor one) must claim the
// picker via DevicePickerSheetHost — otherwise the root instance un-suppresses
// itself and presents behind whichever branch forgot to render it.
describe('CreateClimbRoute BLE picker host (#5868)', () => {
  it('claims the picker while the editor is open', () => {
    activeBoard.current = KILTER_ACTIVE_BOARD;
    render(<CreateClimbRoute />);
    expect(devicePickerHostMounts.count).toBe(1);
    expect(devicePickerHostMounts.lastRegisterExternal).toBe(true);
  });

  it('claims the picker while the active-board query is still loading', () => {
    activeBoard.current = undefined;
    activeBoardPending.current = true;
    render(<CreateClimbRoute />);
    expect(devicePickerHostMounts.count).toBe(1);
    expect(devicePickerHostMounts.lastRegisterExternal).toBe(true);
  });

  it('claims the picker while an unsupported board is dismissing the route', () => {
    activeBoard.current = null;
    render(<CreateClimbRoute />);
    expect(devicePickerHostMounts.count).toBe(1);
    expect(devicePickerHostMounts.lastRegisterExternal).toBe(true);
  });
});

describe('CreateClimbRoute invalid board inputs', () => {
  it('leaves when the pending active-board read fails', () => {
    activeBoard.current = undefined;
    activeBoardPending.current = true;
    const { container, rerender } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();

    activeBoardPending.current = false;
    rerender(<CreateClimbRoute />);

    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(editorBoard.latest).toBeNull();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
    expect(showToast).toHaveBeenCalledExactlyOnceWith('createClimbForm.cannotOpen.noUsableBoard', 'error');
  });

  it.each(['layoutId', 'sizeId', 'angle'])('rejects malformed %s link geometry', (field) => {
    for (const malformed of ['abc', 'Infinity', '-Infinity', '', ' ', ['1', '2']]) {
      routeParams.current = {
        boardName: 'kilter',
        layoutId: '1',
        sizeId: '10',
        setIds: '1,2',
        angle: '40',
        [field]: malformed,
      };
      activeBoard.current = KILTER_ACTIVE_BOARD;
      const { container, unmount } = render(<CreateClimbRoute />);
      expect(container.querySelector('[data-editor]')).toBeNull();
      expect(container.querySelector('[data-spinner]')).toBeNull();
      expect(showToast).toHaveBeenLastCalledWith('createClimbForm.cannotOpen.boardConfigIncomplete', 'error');
      expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
      unmount();
    }
  });

  it.each(['layoutId', 'sizeId', 'setIds', 'angle'])('rejects an active board missing %s', (field) => {
    activeBoard.current = { ...KILTER_ACTIVE_BOARD, [field]: undefined };
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.boardConfigIncomplete', 'error');
  });

  it('falls back safely when the boardName query parameter is repeated', () => {
    routeParams.current = {
      boardName: ['kilter', 'tension'],
      layoutId: '8',
      sizeId: '25',
      setIds: '20,21',
      angle: '55',
    };
    activeBoard.current = KILTER_ACTIVE_BOARD;
    render(<CreateClimbRoute />);
    expect(editorBoard.latest).toEqual({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each(['woods', 'spray'])('accepts empty hold sets for %s', (boardName) => {
    // A spray wall must have said whether it is archived first; one that did
    // not load at all is not.
    if (boardName === 'spray') settleSprayWallDiscoveryMiss(1);
    routeParams.current = { boardName, layoutId: '1', sizeId: '1', setIds: '', angle: '40' };
    render(<CreateClimbRoute />);
    expect(editorBoard.latest).toMatchObject({ boardName, setIds: '' });
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('CreateClimbRoute on an archived spray wall', () => {
  const SPRAY_PARAMS = { boardName: 'spray', layoutId: '4242', sizeId: '4242', setIds: '', angle: '40' };

  function registerWall(archivedAt: string | null) {
    registerSprayWall(4242, {
      wallUuid: 'wall-4242',
      angle: 40,
      version: 1,
      versionId: 1,
      photoWidth: 100,
      photoHeight: 100,
      photoUrl: 'https://example.invalid/wall.jpg',
      photoThumbUrl: null,
      photoExpiresAt: '2099-01-01T00:00:00.000Z',
      holds: [],
      archive: { ...LIVE_SPRAY_WALL_ARCHIVE_STATE, archivedAt },
    });
  }

  beforeEach(() => clearSprayWallRegistry());

  // A deep link, a stale sheet or a queue item can still name the wall. The
  // server refuses every new climb and edit on it, so the editor never opens.
  it('refuses to open the editor, and says why', () => {
    registerWall('2026-10-01T09:00:00.000Z');
    routeParams.current = SPRAY_PARAMS;
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).toBeNull();
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.wallArchived', 'error');
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  it('opens the editor on the same wall while it is live', () => {
    registerWall(null);
    routeParams.current = SPRAY_PARAMS;
    const { container } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  // A cold deep link: the editor waits for the wall instead of flashing open
  // and then leaving.
  it('waits for the wall before opening the editor', () => {
    routeParams.current = SPRAY_PARAMS;
    const { container, rerender } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).toBeNull();
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    act(() => registerWall('2026-10-01T09:00:00.000Z'));
    rerender(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).toBeNull();
    expect(showToast).toHaveBeenCalledWith('createClimbForm.cannotOpen.wallArchived', 'error');
  });

  // A save refused as archived re-reads the wall. The save already said why;
  // the route must not leave with a second message under the climber.
  it('stays open, with no second message, when the wall is archived after the editor opened', () => {
    registerWall(null);
    routeParams.current = SPRAY_PARAMS;
    const { container, rerender } = render(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).not.toBeNull();
    act(() => registerWall('2026-10-01T09:00:00.000Z'));
    rerender(<CreateClimbRoute />);
    expect(container.querySelector('[data-editor]')).not.toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });
});
