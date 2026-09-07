// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  onResolved: vi.fn(),
  shown: vi.fn(),
  resolved: vi.fn(),
  modalProps: null as Record<string, unknown> | null,
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

  it('hands the dialog the board and tags the funnel with this surface', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    expect(mocks.modalProps?.boardType).toBe('tension');
    expect(mocks.modalProps?.source).toBe('onboarding');
  });

  it('records a successful link and leaves', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    act(() => (mocks.modalProps?.onLinked as (board: string) => void)('tension'));
    expect(mocks.resolved).toHaveBeenCalledWith('tension', 'linked');
    expect(mocks.onResolved).toHaveBeenCalledTimes(1);
  });

  // A wrong password is not a decision to skip. Dropping someone out of onboarding
  // on a typo would be the worst possible reading of it.
  it('returns to the card when the dialog closes without linking', () => {
    const { container } = renderStep();
    fireEvent.click(button(container, 'mobile.onboarding.link.continue:Tension')!);
    act(() => (mocks.modalProps?.onClose as () => void)());
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
});
