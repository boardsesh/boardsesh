// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

// A cold spray entry renders BEFORE the registry has the wall. `createClimbScreenKey`
// folds the wall version in, but it reads that version out of a module-level map —
// so unless this route subscribes, nothing re-renders when the wall lands: the
// screen keeps its `-sv0` key, its editor never remounts, the version-keyed draft
// restore never re-runs, and every autosave goes into the slot the loader's
// superseded-draft sweep has already removed.
//
// The REAL `createClimbScreenKey` runs here — the stub in `create.test.tsx` folds in
// only the board name, which is exactly what would hide this.

const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const activeBoard = vi.hoisted(() => ({ current: null as UserBoard | null | undefined }));
const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => ({ canGoBack: vi.fn(() => false), back: vi.fn(), replace: vi.fn() }),
}));

// A key change unmounts and remounts the element, so the mount count IS the
// observation — no need to reach the key string itself (React strips it from props).
vi.mock('../../../../src/components/create-climb/CreateClimbScreen', () => ({
  CreateClimbScreen: () => {
    useEffect(() => {
      mounts.count += 1;
    }, []);
    return createElement('div', { 'data-editor': 'true' });
  },
}));

vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

vi.mock('../../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current }),
}));

vi.mock('../../../../src/lib/routing/use-unsupported-board-exit', () => ({
  useUnsupportedBoardExit: () => {},
}));

import { clearSprayWallRegistry, registerSprayWall } from '../../../../src/lib/spray/spray-wall-registry';
import CreateClimbRoute from '../create';

const LAYOUT_ID = 9001;

function registerWall(version: number) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle: 25,
    version,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2026-09-15T12:15:00.000Z',
    holds: [{ id: 1, cx: 100, cy: 200, r: 18 }],
  });
}

beforeEach(() => {
  mounts.count = 0;
  activeBoard.current = null;
  routeParams.current = {
    boardName: 'spray',
    layoutId: String(LAYOUT_ID),
    sizeId: String(LAYOUT_ID),
    setIds: '1',
    angle: '25',
  };
  clearSprayWallRegistry();
});

afterEach(() => {
  clearSprayWallRegistry();
});

describe('create route — spray wall re-key', () => {
  it('opens the editor on a wall at all', () => {
    // `supportedBoardName` used to narrow against the board-config PICKER list,
    // which excludes `spray` by design — so a remix or the FAB handing this route
    // `boardName=spray` read as a typo and never reached the editor.
    render(createElement(CreateClimbRoute));
    expect(mounts.count).toBe(1);
  });

  it('remounts the editor when the wall arrives after the first render', () => {
    render(createElement(CreateClimbRoute));
    expect(mounts.count).toBe(1);

    act(() => registerWall(1));

    expect(mounts.count).toBe(2);
  });

  it('remounts again when a reset publishes a new version', () => {
    registerWall(1);
    render(createElement(CreateClimbRoute));
    expect(mounts.count).toBe(1);

    act(() => registerWall(2));

    expect(mounts.count).toBe(2);
  });

  it('leaves a catalogue board mounted once', () => {
    routeParams.current = { boardName: 'kilter', layoutId: '1', sizeId: '10', setIds: '1,2', angle: '40' };
    render(createElement(CreateClimbRoute));
    act(() => registerWall(1));
    expect(mounts.count).toBe(1);
  });
});
