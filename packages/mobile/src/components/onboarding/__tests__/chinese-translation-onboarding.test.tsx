// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { language: 'zh-CN', ready: true, consentSettled: true, segments: ['(tabs)'] },
  translate: (key: string) => key,
  choose: vi.fn(),
  hasSeenTip: vi.fn(),
  markTipSeen: vi.fn(),
  openExternalUrl: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('expo-router', () => ({ useSegments: () => mocks.state.segments }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: mocks.state.language } }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useChoose: () => mocks.choose }));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => mocks.state.ready }));
vi.mock('../../../lib/consent-hooks', () => ({ useConsentSettled: () => mocks.state.consentSettled }));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: mocks.hasSeenTip,
  markTipSeen: mocks.markTipSeen,
}));
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: mocks.reportError }));

import { ChineseTranslationOnboarding } from '../ChineseTranslationOnboarding';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.state, { language: 'zh-CN', ready: true, consentSettled: true, segments: ['(tabs)'] });
  vi.stubEnv('EXPO_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL', 'https://forms.gle/nativeTerms');
  mocks.hasSeenTip.mockResolvedValue(false);
  mocks.markTipSeen.mockResolvedValue(undefined);
  mocks.choose.mockResolvedValue('continue');
});
afterEach(() => vi.unstubAllEnvs());

describe('ChineseTranslationOnboarding', () => {
  it('waits for first-board evaluation before inviting an existing user', async () => {
    const view = render(<ChineseTranslationOnboarding onboardingDecided={false} />);
    expect(mocks.hasSeenTip).not.toHaveBeenCalled();
    view.rerender(<ChineseTranslationOnboarding onboardingDecided />);
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(1));
  });

  it('waits until a presented board picker has appeared and been left', async () => {
    const view = render(<ChineseTranslationOnboarding onboardingDecided firstBoardPickerPresented />);
    expect(mocks.hasSeenTip).not.toHaveBeenCalled();
    mocks.state.segments = ['boards'];
    view.rerender(<ChineseTranslationOnboarding onboardingDecided firstBoardPickerPresented />);
    expect(mocks.hasSeenTip).not.toHaveBeenCalled();
    mocks.state.segments = ['(tabs)'];
    view.rerender(<ChineseTranslationOnboarding onboardingDecided firstBoardPickerPresented />);
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(1));
  });

  it('welcomes Chinese users and remembers an explicit skip', async () => {
    render(<ChineseTranslationOnboarding onboardingDecided />);
    await waitFor(() => expect(mocks.markTipSeen).toHaveBeenCalledWith('onboarding_chinese_translation_form_v1'));
    expect(mocks.choose).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'chineseTranslation.title',
        options: [
          { value: 'form', label: 'chineseTranslation.openForm' },
          { value: 'continue', label: 'chineseTranslation.continue', cancel: true },
        ],
      }),
    );
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });

  it('opens the form only when the climber chooses it', async () => {
    mocks.choose.mockResolvedValue('form');
    render(<ChineseTranslationOnboarding onboardingDecided />);
    await waitFor(() =>
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://forms.gle/nativeTerms',
        'chinese-translation-onboarding',
      ),
    );
  });

  it('opens the published form after an early intro dismissal without an environment override', async () => {
    vi.stubEnv('EXPO_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL', undefined);
    mocks.hasSeenTip.mockImplementation(async (key: string) => key === 'onboarding_chinese_translation_intro_v1');
    mocks.choose.mockResolvedValue('form');

    render(<ChineseTranslationOnboarding onboardingDecided />);

    await waitFor(() =>
      expect(mocks.openExternalUrl).toHaveBeenCalledWith(
        'https://docs.google.com/forms/d/e/1FAIpQLSewiiQkpQG5bT2UVYEdqDRmeSSs26h50xJLrR-rYORuZIj17g/viewform',
        'chinese-translation-onboarding',
      ),
    );
    expect(mocks.hasSeenTip).toHaveBeenCalledWith('onboarding_chinese_translation_form_v1');
    expect(mocks.choose.mock.calls[0][0].options).toContainEqual({
      value: 'form',
      label: 'chineseTranslation.openForm',
    });
    expect(mocks.markTipSeen).toHaveBeenCalledWith('onboarding_chinese_translation_form_v1');
  });

  it('does not repeat an invitation dismissed on an earlier launch', async () => {
    mocks.hasSeenTip.mockResolvedValue(true);
    render(<ChineseTranslationOnboarding onboardingDecided />);
    await waitFor(() => expect(mocks.hasSeenTip).toHaveBeenCalled());
    expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('welcomes an existing user who switches to Chinese in settings', async () => {
    mocks.state.language = 'en-US';
    mocks.state.segments = ['settings', 'general'];
    const screen = render(<ChineseTranslationOnboarding onboardingDecided />);
    expect(mocks.hasSeenTip).not.toHaveBeenCalled();
    mocks.state.language = 'zh-CN';
    screen.rerender(<ChineseTranslationOnboarding onboardingDecided />);
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(1));
  });

  it.each(['en-US', 'es', 'fr', 'de', 'it'])('does not ask in %s', (language) => {
    mocks.state.language = language;
    render(<ChineseTranslationOnboarding onboardingDecided />);
    expect(mocks.hasSeenTip).not.toHaveBeenCalled();
  });

  it('waits for launch, consent and an ordinary app screen', () => {
    mocks.state.ready = false;
    const screen = render(<ChineseTranslationOnboarding onboardingDecided />);
    mocks.state.ready = true;
    mocks.state.consentSettled = false;
    screen.rerender(<ChineseTranslationOnboarding onboardingDecided />);
    mocks.state.consentSettled = true;
    mocks.state.segments = ['auth'];
    screen.rerender(<ChineseTranslationOnboarding onboardingDecided />);
    expect(mocks.hasSeenTip).not.toHaveBeenCalled();
  });

  it('keeps the app usable before the Google Form is created', async () => {
    vi.stubEnv('EXPO_PUBLIC_CHINESE_TERMINOLOGY_FORM_URL', '');
    render(<ChineseTranslationOnboarding onboardingDecided />);
    await waitFor(() => expect(mocks.markTipSeen).toHaveBeenCalledWith('onboarding_chinese_translation_intro_v1'));
    expect(mocks.choose.mock.calls[0][0].message).toContain('chineseTranslation.formPending');
    expect(mocks.choose.mock.calls[0][0].options).toHaveLength(1);
  });
});
