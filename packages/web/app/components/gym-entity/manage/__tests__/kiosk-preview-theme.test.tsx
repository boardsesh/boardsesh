import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render } from '@testing-library/react';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import type { BoardSlotProps } from '@/app/components/kiosk/board-slot/board-slot';
import type { KioskEditorState } from '../kiosk-editor-state';
import KioskPreview from '../kiosk-preview';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/lib/board-image-details', () => ({
  getBoardImageDetailsForBoard: () => ({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] }),
}));
vi.mock('@/app/components/kiosk/presence/viewer-kiosk-presence-hub', () => ({
  ViewerKioskPresenceHub: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/app/components/kiosk/kiosk-header', () => ({ default: () => null }));
vi.mock('@/app/components/kiosk/kiosk-attribution', () => ({ default: () => null }));
vi.mock('@/app/components/kiosk/board-slot/board-slot', () => ({
  default: ({ bareBoardImageUrl, theme }: BoardSlotProps) => (
    <img src={bareBoardImageUrl} data-board-theme={theme} alt="" />
  ),
}));

const gym = { uuid: 'gym', name: 'Gym', logoUrl: null } as Gym;
const boardUuid = '11111111-1111-4111-8111-111111111111';
const gymBoards = [
  {
    uuid: boardUuid,
    boardId: 42,
    slug: 'main',
    name: 'Main',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
  },
] as UserBoard[];
const state: KioskEditorState = { boardUuids: [boardUuid], leaderboard: null, showInstallQr: false, theme: 'dark' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('unsaved kiosk preview appearance', () => {
  it('updates idle rasters and live-board theme props when appearance changes', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { container, rerender } = render(
      <KioskPreview gym={gym} kioskName="Main" state={state} gymBoards={gymBoards} />,
    );
    const darkImage = container.querySelector<HTMLImageElement>('img')!;
    expect(new URL(darkImage.src).searchParams.get('field_color')).toBe('#181225');
    expect(darkImage.dataset.boardTheme).toBe('dark');

    rerender(<KioskPreview gym={gym} kioskName="Main" state={{ ...state, theme: 'light' }} gymBoards={gymBoards} />);
    const lightImage = container.querySelector<HTMLImageElement>('img')!;
    expect(new URL(lightImage.src).searchParams.get('field_color')).toBe('#FFFFFF');
    expect(lightImage.dataset.boardTheme).toBe('light');
  });
});
