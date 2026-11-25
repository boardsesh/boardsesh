import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  state: {
    language: 'zh-CN',
    consentPrompt: false,
    consentSettled: true,
    dialogOpen: false,
    accountReady: true,
    pathname: '/',
  },
  translate: (key: string) => key,
  getPreference: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: mocks.state.language } }),
}));
vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: mocks.getPreference,
  setPreference: mocks.setPreference,
}));
vi.mock('@/app/lib/i18n/use-locale-router', () => ({ usePathnameWithoutLocale: () => mocks.state.pathname }));
vi.mock('../../consent/consent-state-provider', () => ({
  useConsent: () => ({
    dialogOpen: mocks.state.dialogOpen,
    accountReady: mocks.state.accountReady,
  }),
}));

import ChineseTranslationOnboarding from '../chinese-translation-onboarding';
import * as dialogLoader from '../chinese-translation-dialog-loader';

function Welcome() {
  return (
    <ChineseTranslationOnboarding
      consentRegion={{ prompt: mocks.state.consentPrompt, settled: mocks.state.consentSettled }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.state, {
    language: 'zh-CN',
    consentPrompt: false,
    consentSettled: true,
    dialogOpen: false,
    accountReady: true,
    pathname: '/',
  });
  vi.stubEnv('NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL', 'https://forms.gle/nativeTerms');
  mocks.getPreference.mockResolvedValue(null);
  mocks.setPreference.mockResolvedValue(undefined);
  vi.spyOn(dialogLoader, 'loadChineseTranslationDialog');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Chinese translation welcome on www', () => {
  it('waits while the consent region is still unknown', async () => {
    mocks.state.consentSettled = false;
    const view = render(<Welcome />);
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(dialogLoader.loadChineseTranslationDialog).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    mocks.state.consentSettled = true;
    view.rerender(<Welcome />);
    await screen.findByRole('dialog');
  });

  it('shows an optional form and remembers dismissal', async () => {
    render(<Welcome />);
    const formLink = await screen.findByRole('link', { name: 'chineseTranslation.openForm' });
    expect(formLink.getAttribute('href')).toBe('https://forms.gle/nativeTerms');
    fireEvent.click(screen.getByRole('button', { name: 'chineseTranslation.continue' }));
    expect(mocks.setPreference).toHaveBeenCalledWith('onboarding_chinese_translation_form_v1', true);
  });

  it('offers the published form after an early intro dismissal without an environment override', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL', undefined);
    mocks.getPreference.mockImplementation(async (key: string) => key === 'onboarding_chinese_translation_intro_v1');

    render(<Welcome />);

    const formLink = await screen.findByRole('link', { name: 'chineseTranslation.openForm' });
    expect(formLink.getAttribute('href')).toBe(
      'https://docs.google.com/forms/d/e/1FAIpQLSewiiQkpQG5bT2UVYEdqDRmeSSs26h50xJLrR-rYORuZIj17g/viewform',
    );
    expect(formLink.getAttribute('target')).toBe('_blank');
    expect(mocks.getPreference).toHaveBeenCalledWith('onboarding_chinese_translation_form_v1');
    fireEvent.click(formLink);
    expect(mocks.setPreference).toHaveBeenCalledWith('onboarding_chinese_translation_form_v1', true);
  });

  it('stays hidden for another language and responds to a Chinese switch', async () => {
    mocks.state.language = 'en-US';
    const view = render(<Welcome />);
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(dialogLoader.loadChineseTranslationDialog).not.toHaveBeenCalled();
    mocks.state.language = 'zh-CN';
    view.rerender(<Welcome />);
    await screen.findByRole('dialog');
  });

  it('keeps consent choices in front of the welcome', async () => {
    mocks.state.consentPrompt = true;
    const view = render(<Welcome />);
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    mocks.state.consentPrompt = false;
    view.rerender(<Welcome />);
    await screen.findByRole('dialog');
  });

  it('does not ask again after dismissal', async () => {
    mocks.getPreference.mockResolvedValue(true);
    render(<Welcome />);
    await waitFor(() => expect(mocks.getPreference).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialogLoader.loadChineseTranslationDialog).not.toHaveBeenCalled();
  });

  it('waits for account resolution before reading the preference or downloading the dialog', async () => {
    mocks.state.accountReady = false;
    const view = render(<Welcome />);
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(dialogLoader.loadChineseTranslationDialog).not.toHaveBeenCalled();
    mocks.state.accountReady = true;
    view.rerender(<Welcome />);
    await screen.findByRole('dialog');
    expect(dialogLoader.loadChineseTranslationDialog).toHaveBeenCalledOnce();
  });

  it('waits for the tab to become visible before reading or downloading', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<Welcome />);
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(dialogLoader.loadChineseTranslationDialog).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByRole('dialog');
    expect(dialogLoader.loadChineseTranslationDialog).toHaveBeenCalledOnce();
  });

  it('does not reshow a welcome dismissed in another tab while this tab was hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    render(<Welcome />);
    await screen.findByRole('dialog');
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByRole('dialog')).toBeNull();
    mocks.getPreference.mockResolvedValue(true);
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(mocks.getPreference).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialogLoader.loadChineseTranslationDialog).toHaveBeenCalledOnce();
  });

  it('does not download behind open privacy choices', async () => {
    mocks.state.dialogOpen = true;
    const view = render(<Welcome />);
    expect(mocks.getPreference).not.toHaveBeenCalled();
    expect(dialogLoader.loadChineseTranslationDialog).not.toHaveBeenCalled();
    mocks.state.dialogOpen = false;
    view.rerender(<Welcome />);
    await screen.findByRole('dialog');
  });

  it('has a working continue action while the form is being prepared', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL', '');
    render(<Welcome />);
    await screen.findByText('chineseTranslation.formPending');
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chineseTranslation.continue' }));
    expect(mocks.setPreference).toHaveBeenCalledWith('onboarding_chinese_translation_intro_v1', true);
  });
});
