import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Gym } from '@boardsesh/shared-schema';
import type { GymKioskOperationResult } from '@boardsesh/graphql/operations';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { KioskEditorState } from '../kiosk-editor-state';
import KioskEditor from '../kiosk-editor';

const controls = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));
vi.mock('@/app/hooks/use-entity-mutation', () => ({ useEntityMutation: () => ({ execute: controls.execute }) }));
vi.mock('@/app/components/providers/snackbar-provider', () => ({ useSnackbar: () => ({ showMessage: vi.fn() }) }));
vi.mock('../kiosk-preview', () => ({
  default: ({ state }: { state: KioskEditorState }) => <div data-testid="preview-theme">{state.theme}</div>,
}));
vi.mock('../kiosk-board-slots', () => ({ default: () => null }));
vi.mock('../kiosk-leaderboard-settings', () => ({ default: () => null }));
vi.mock('../embed-code-dialog', () => ({ default: () => null }));

const gym = { uuid: 'test-gym', name: 'Test Gym', slug: 'test-gym', isPublic: true } as Gym;
const kiosk = {
  uuid: 'test-kiosk',
  name: 'Front desk',
  layout: { version: 1, boards: [], leaderboard: null, showInstallQr: false },
} as GymKioskOperationResult;

afterEach(() => {
  cleanup();
  controls.execute.mockReset();
});

describe('kiosk editor appearance', () => {
  it('previews a theme-only edit, saves it, and restores the saved selection', async () => {
    const onSaved = vi.fn();
    const onDirtyChange = vi.fn();
    const props = {
      gym,
      kiosk,
      gymBoards: [],
      gymBoardsLoadFailed: false,
      onBack: vi.fn(),
      onSaved,
      onDirtyChange,
      tvPath: null,
    };
    const editor = render(<KioskEditor {...props} />);
    const darkRadio = screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement;
    expect(darkRadio.checked).toBe(true);
    expect((screen.getByRole('button', { name: 'Save layout' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('radiogroup', { name: 'Appearance' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(screen.getByTestId('preview-theme').textContent).toBe('light');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    const savedKiosk = { ...kiosk, layout: { ...(kiosk.layout as Record<string, unknown>), theme: 'light' } };
    controls.execute.mockResolvedValueOnce({ updateGymKiosk: savedKiosk });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedKiosk));
    expect(controls.execute).toHaveBeenCalledWith({
      input: {
        kioskUuid: kiosk.uuid,
        layout: { version: 1, boards: [], leaderboard: null, showInstallQr: false, theme: 'light' },
      },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    editor.unmount();
    render(<KioskEditor {...props} kiosk={savedKiosk} />);
    expect((screen.getByRole('radio', { name: 'Light' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('preview-theme').textContent).toBe('light');
  });
});
