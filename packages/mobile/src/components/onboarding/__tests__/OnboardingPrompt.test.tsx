// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The analytics wrappers are the seam under test — assert the component drives
// them; the wrappers' own payloads are covered in onboarding-analytics.test.ts.
const analyticsMock = vi.hoisted(() => ({
  trackTourStarted: vi.fn(),
  trackStepViewed: vi.fn(),
  trackTourCompleted: vi.fn(),
  trackTourDismissed: vi.fn(),
}));
vi.mock('../../../lib/onboarding/onboarding-analytics', () => analyticsMock);

// Minimal RN surface: View → div, StyleSheet passthrough.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { select: (spec: Record<string, unknown>) => spec.ios ?? spec.default },
  // The step swallows Android back via useBlockBack; the handler is exercised in
  // its own test, so here it only has to exist.
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Button stub: a <button> carrying its title + onPress so the CTA is clickable.
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../OnboardingCard', () => ({ OnboardingCard: () => null }));

vi.mock('../../../lib/onboarding/use-onboarding-copy', () => ({
  useOnboardingCopy: () => ({
    title: 'Title',
    body: 'Body',
    footnote: 'Footnote',
    continueLabel: 'Pick my board',
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: 'liquidGlass' }),
}));

vi.mock('../../../theme/variants', () => ({
  selectByVariant: (_variant: string, options: { material: unknown; liquidGlass: unknown }) => options.liquidGlass,
}));

import { OnboardingPrompt } from '../OnboardingPrompt';

function renderPrompt() {
  return render(
    <OnboardingPrompt
      accentColor="#000"
      iconColor="#000"
      bodyColor="#000"
      backgroundColor="#fff"
      onContinue={() => {}}
    />,
  );
}

describe('OnboardingPrompt telemetry', () => {
  beforeEach(() => {
    for (const fn of Object.values(analyticsMock)) fn.mockClear();
  });

  it('fires Started + one Step Viewed on mount', () => {
    renderPrompt();
    expect(analyticsMock.trackTourStarted).toHaveBeenCalledTimes(1);
    expect(analyticsMock.trackStepViewed).toHaveBeenCalledTimes(1);
  });

  it('fires Dismissed when the prompt unmounts with no button chosen (the back exit)', () => {
    const { unmount } = renderPrompt();
    expect(analyticsMock.trackTourDismissed).not.toHaveBeenCalled();
    unmount();
    expect(analyticsMock.trackTourDismissed).toHaveBeenCalledTimes(1);
    expect(analyticsMock.trackTourCompleted).not.toHaveBeenCalled();
  });

  it('does not fire Dismissed when the CTA resolved the prompt', () => {
    const { getByText, unmount } = renderPrompt();
    fireEvent.click(getByText('Pick my board'));
    unmount();
    expect(analyticsMock.trackTourCompleted).toHaveBeenCalledTimes(1);
    expect(analyticsMock.trackTourDismissed).not.toHaveBeenCalled();
  });

  // Issue #4961 made the flow mandatory. A second button here would be a way out
  // of it, so its absence is the assertion, not an implementation detail.
  it('renders no exit beside the CTA', () => {
    const { container } = renderPrompt();
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toBe('Pick my board');
  });
});
