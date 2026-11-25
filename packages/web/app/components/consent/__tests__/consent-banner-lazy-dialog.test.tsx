import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  state: { prompt: true, initialDialogOpen: false, pathname: '/', syncFailed: false },
  load: vi.fn(),
  decide: vi.fn(),
  reportPromptShowing: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ usePathnameWithoutLocale: () => mocks.state.pathname }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('../use-consent-region-prompt', () => ({
  useConsentRegionPromptState: () => ({ prompt: mocks.state.prompt, settled: true }),
}));
vi.mock('../consent-choices-loader', () => ({ loadConsentChoicesDialog: mocks.load }));
vi.mock('../consent-state-provider', async () => {
  const { useState } = await import('react');
  return {
    useConsent: () => {
      const [dialogOpen, setDialogOpen] = useState(mocks.state.initialDialogOpen);
      return {
        dialogOpen,
        decide: mocks.decide,
        openChoices: () => setDialogOpen(true),
        closeChoices: () => setDialogOpen(false),
        syncFailed: mocks.state.syncFailed,
        reportPromptShowing: mocks.reportPromptShowing,
      };
    },
  };
});

import ConsentBanner from '../consent-banner';

beforeEach(() => {
  Object.assign(mocks.state, { prompt: true, initialDialogOpen: false, pathname: '/', syncFailed: false });
  mocks.load.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.decide.mockReset().mockResolvedValue(undefined);
  mocks.reportPromptShowing.mockClear();
});
afterEach(cleanup);

describe('lazy privacy details', () => {
  it('keeps the prompt and immediate choices without downloading a closed dialog', () => {
    render(<ConsentBanner />);
    expect(screen.getByText('bannerSummary')).toBeTruthy();
    expect(mocks.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'allow' }));
    expect(mocks.decide).toHaveBeenCalledWith('granted');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('offers Allow and Deny immediately while details load, with Escape and focus restoration', () => {
    render(<ConsentBanner />);
    const trigger = screen.getByRole('button', { name: 'details' });
    trigger.focus();
    fireEvent.click(trigger);
    const close = screen.getByRole('button', { name: 'close' });
    expect(document.activeElement).toBe(close);
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'deny' })).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
    expect(screen.getByText('adMeasurement')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'privacyLink' }).getAttribute('href')).toBe('/privacy');
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves privacy choices actionable outside a prompt region if the dialog download fails', async () => {
    mocks.state.prompt = false;
    mocks.state.initialDialogOpen = true;
    mocks.state.syncFailed = true;
    mocks.load.mockRejectedValue(new Error('offline'));
    render(<ConsentBanner />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('bannerSummary')).toBeNull();
    expect(screen.getByText('body')).toBeTruthy();
    expect(screen.getByText('adMeasurement')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'privacyLink' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('status').textContent).toBe('syncError');
    fireEvent.click(screen.getByRole('button', { name: 'deny' }));
    expect(mocks.decide).toHaveBeenCalledWith('denied');
    expect(screen.queryByTestId('consent-banner')).toBeNull();
  });

  it('does not download or report a hidden prompt on chrome-less routes', () => {
    mocks.state.pathname = '/embed/board/kilter';
    mocks.state.initialDialogOpen = true;
    render(<ConsentBanner />);
    expect(screen.queryByTestId('consent-banner')).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.reportPromptShowing).toHaveBeenLastCalledWith(false);
  });
});
