// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  onResolved: vi.fn(),
  shown: vi.fn(),
  resolved: vi.fn(),
  modalProps: null as Record<string, unknown> | null,
  backHandler: null as (() => boolean) | null,
  removeBackHandler: vi.fn(),
  isFocused: true,
  linkEnabled: true,
  boardType: 'tension' as string | undefined,
  replace: vi.fn(),
  markAnswered: vi.fn().mockResolvedValue(undefined),
  reportError: vi.fn(),
}));

vi.mock('../../../lib/onboarding/link-step-analytics', () => ({
  trackLinkPromptShown: mocks.shown,
  trackLinkPromptResolved: mocks.resolved,
}));

// Recorded rather than rendered: this test is about which board and surface the
// step hands the dialog, and what it does with the dialog's callbacks.
vi.mock('../../integrations/LinkBoardAccountModal', () => ({
  LinkBoardAccountModal: (props: Record<string, unknown>) => {
    mocks.modalProps = props;
    return null;
  },
}));

vi.mock('expo-router', () => ({
  useIsFocused: () => mocks.isFocused,
  useLocalSearchParams: () => ({ boardType: mocks.boardType }),
  router: { replace: mocks.replace },
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => mocks.linkEnabled }));
vi.mock('../../../lib/onboarding/link-step-answered', () => ({ markLinkStepAnswered: mocks.markAnswered }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: mocks.reportError }));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { boardName?: string }) => (opts?.boardName != null ? `${key}:${opts.boardName}` : key),
  }),
}));

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ variant: 'material' }) }));
vi.mock('../../../theme/variants', () => ({ selectByVariant: () => undefined }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 5: 20 } }));

type RNProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: RNProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  BackHandler: {
    addEventListener: (_name: string, handler: () => boolean) => {
      mocks.backHandler = handler;
      return { remove: mocks.removeBackHandler };
    },
  },
}));

vi.mock('../../Text', () => ({ Text: ({ children }: RNProps) => createElement('span', {}, children) }));
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: RNProps) => createElement('div', {}, children),
}));
vi.mock('../OnboardingCard', () => ({
  OnboardingCard: ({ title, body, footnote }: { title: string; body: string; footnote?: string }) =>
    createElement('div', {}, `${title}|${body}|${footnote ?? ''}`),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { 'data-button': title, onClick: onPress }),
}));

import { OnboardingLinkStep } from '../OnboardingLinkStep';
import { OnboardingLinkRoute } from '../OnboardingLinkRoute';

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

const renderStep = () =>
  render(
    <OnboardingLinkStep
      boardType="tension"
      accentColor="#6D28D9"
      iconColor="#6D28D9"
      bodyColor="#888"
      backgroundColor="#000"
      onResolved={mocks.onResolved}
    />,
  );

describe('OnboardingLinkStep', () => {
  beforeEach(() => {
    cleanup();
    mocks.backHandler = null;
    mocks.removeBackHandler.mockReset();
    mocks.isFocused = true;
    mocks.linkEnabled = true;
    mocks.boardType = 'tension';
    mocks.replace.mockReset();
    mocks.markAnswered.mockReset().mockResolvedValue(undefined);
    mocks.reportError.mockReset();
    mocks.onResolved.mockReset();
    mocks.shown.mockReset();
    mocks.resolved.mockReset();
    mocks.modalProps = null;
  });

  it('names the board the climber just picked, and warns it wants a username', () => {
    const { container } = renderStep();
    expect(container.textContent).toContain('mobile.onboarding.link.title:Tension');
    // The crux of the original report: the climber assumed same-email meant linked.
    expect(container.textContent).toContain('mobile.onboarding.link.footnote:Tension');
  });

  it('reports the card was shown', () => {
    renderStep();
    expect(mocks.shown).toHaveBeenCalledWith('tension');
  });

  // This is the one escapable step in an otherwise mandatory flow, so the exit has
  // to be a real, visible button — the route disables the iOS swipe for the whole
  // onboarding file.
  it('offers a visible way out', () => {
    const { container } = renderStep();
    expect(button(container, 'mobile.onboarding.link.skip')).not.toBeNull();
  });

  it('records a decline as an answer and leaves', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.skip')!);
    expect(mocks.resolved).toHaveBeenCalledWith('tension', 'declined');
    expect(mocks.onResolved).toHaveBeenCalledTimes(1);
  });

  it('records Android back as one decline and removes its handler on unmount', () => {
    const screen = renderStep();
    expect(mocks.backHandler).toBeTypeOf('function');
    act(() => expect(mocks.backHandler?.()).toBe(true));
    screen.unmount();
    expect(mocks.onResolved).toHaveBeenCalledTimes(1);
    expect(mocks.resolved).toHaveBeenCalledExactlyOnceWith('tension', 'declined');
    expect(mocks.removeBackHandler).toHaveBeenCalledTimes(1);
  });

  it('closes an open credential dialog on Android back without declining the prompt', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    expect(mocks.modalProps?.boardType).toBe('tension');
    act(() => expect(mocks.backHandler?.()).toBe(true));
    expect(mocks.modalProps?.boardType).toBeNull();
    expect(mocks.onResolved).not.toHaveBeenCalled();
    expect(mocks.resolved).not.toHaveBeenCalled();
  });

  it('does not intercept back while another route is focused', () => {
    mocks.isFocused = false;
    renderStep();
    expect(mocks.backHandler).toBeNull();
  });

  it('hands the dialog the board and tags the funnel with this surface', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    expect(mocks.modalProps?.boardType).toBe('tension');
    expect(mocks.modalProps?.source).toBe('onboarding');
  });

  it('records a successful link and leaves', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    act(() => (mocks.modalProps!.onLinked as (board: string) => void)('tension'));
    expect(mocks.resolved).toHaveBeenCalledWith('tension', 'linked');
    expect(mocks.onResolved).toHaveBeenCalledTimes(1);
  });

  // A wrong password is not a decision to skip. Dropping someone out of onboarding
  // on a typo would be the worst possible reading of it.
  it('returns to the card when the dialog closes without linking', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    act(() => (mocks.modalProps!.onClose as () => void)());
    expect(mocks.onResolved).not.toHaveBeenCalled();
    expect(mocks.resolved).not.toHaveBeenCalled();
  });

  // Without this, a nav-away would leave a Shown with no matching Resolved — the
  // exact hole that once deflated the tour's completion metric.
  it('resolves every presentation, including the exits no button produced', () => {
    renderStep();
    cleanup();
    expect(mocks.resolved).toHaveBeenCalledWith('tension', 'abandoned');
  });

  it('reports exactly one outcome per presentation', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.skip')!);
    cleanup();
    expect(mocks.resolved).toHaveBeenCalledTimes(1);
    expect(mocks.resolved).toHaveBeenCalledWith('tension', 'declined');
  });
  it('the route records one declined answer on Android back, even if persistence fails', async () => {
    const storageError = new Error('storage unavailable');
    mocks.markAnswered.mockRejectedValueOnce(storageError);
    render(<OnboardingLinkRoute accentColor="#6D28D9" iconColor="#6D28D9" bodyColor="#888" backgroundColor="#000" />);
    expect(mocks.shown).toHaveBeenCalledExactlyOnceWith('tension');
    expect(mocks.markAnswered).not.toHaveBeenCalled();
    act(() => {
      mocks.backHandler?.();
    });
    expect(mocks.resolved).toHaveBeenCalledExactlyOnceWith('tension', 'declined');
    expect(mocks.markAnswered).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
    await waitFor(() => expect(mocks.reportError).toHaveBeenCalledExactlyOnceWith(storageError));
  });

  it.each([
    { enabled: false, boardType: 'tension' },
    { enabled: true, boardType: undefined },
    { enabled: true, boardType: 'moonboard' },
    { enabled: true, boardType: 'woods' },
    { enabled: true, boardType: 'spray' },
  ])('direct navigation skips an unavailable link step: %j', ({ enabled, boardType }) => {
    mocks.linkEnabled = enabled;
    mocks.boardType = boardType;
    render(<OnboardingLinkRoute accentColor="#6D28D9" iconColor="#6D28D9" bodyColor="#888" backgroundColor="#000" />);
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
    expect(mocks.shown).not.toHaveBeenCalled();
    expect(mocks.markAnswered).not.toHaveBeenCalled();
    expect(mocks.backHandler).toBeNull();
  });
});
