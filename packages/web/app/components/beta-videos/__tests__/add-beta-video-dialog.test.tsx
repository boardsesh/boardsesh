// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import AddBetaVideoDialog from '../add-beta-video-dialog';
import { copyInstagramCaption, openInstagramCamera } from '@/app/lib/instagram-posting';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/lib/instagram-posting', () => ({
  buildInstagramCaption: vi.fn(() => '"Crimpy" @ 40° on the Kilter Board.'),
  copyInstagramCaption: vi.fn(),
  openInstagramCamera: vi.fn(),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: vi.fn(),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('../attach-beta-link-form', () => ({
  default: () => <div data-testid="attach-beta-link-form" />,
}));

const mockShowMessage = vi.fn();
const mockCopyInstagramCaption = vi.mocked(copyInstagramCaption);
const mockOpenInstagramCamera = vi.mocked(openInstagramCamera);
const mockUseSnackbar = vi.mocked(useSnackbar);

function renderDialog() {
  return render(
    <AddBetaVideoDialog
      open
      onClose={vi.fn()}
      boardType="kilter"
      climbUuid="climb-1"
      climbName="Crimpy"
      angle={40}
      grade="V5"
      setter="setter"
      layoutId={1}
      surface="play-view"
    />,
  );
}

describe('AddBetaVideoDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSnackbar.mockReturnValue({ showMessage: mockShowMessage });
    mockCopyInstagramCaption.mockResolvedValue(true);
    mockOpenInstagramCamera.mockResolvedValue(true);
  });

  it('shows the generated caption and share-back instructions', () => {
    renderDialog();

    expect(screen.getByDisplayValue('"Crimpy" @ 40° on the Kilter Board.')).toBeTruthy();
    expect(screen.getByText(tFromCatalog('feed', 'betaVideos.shareIntentTitle'))).toBeTruthy();
    expect(screen.getByText(tFromCatalog('feed', 'betaVideos.shareIntentBody'))).toBeTruthy();
  });

  it('copies the caption from its own button', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('feed', 'betaVideos.copyCaption') }));

    await waitFor(() => {
      expect(mockCopyInstagramCaption).toHaveBeenCalledWith('"Crimpy" @ 40° on the Kilter Board.');
    });
    expect(mockShowMessage).toHaveBeenCalledWith(tFromCatalog('feed', 'betaVideos.instagramCopiedOnly'), 'success');
  });

  it('opens Instagram from its own button', async () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('feed', 'betaVideos.openInstagram') }));

    await waitFor(() => {
      expect(mockOpenInstagramCamera).toHaveBeenCalled();
    });
    expect(mockCopyInstagramCaption).not.toHaveBeenCalled();
  });

  it('shows a warning when Instagram cannot be opened', async () => {
    mockOpenInstagramCamera.mockResolvedValue(false);
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('feed', 'betaVideos.openInstagram') }));

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith(tFromCatalog('feed', 'betaVideos.openInstagramFailed'), 'warning');
    });
  });

  it('keeps the manual link fallback available', () => {
    renderDialog();

    fireEvent.click(screen.getByText(tFromCatalog('feed', 'betaVideos.pasteLinkInstead')));

    expect(screen.getByTestId('attach-beta-link-form')).toBeTruthy();
  });
});
