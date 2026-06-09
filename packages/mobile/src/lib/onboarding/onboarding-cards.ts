import type { IconName } from '../../components/icon-map';

/**
 * The four first-run walkthrough cards. Order is the page order. `id` is a
 * stable analytics key (mirrors web's tour step ids) and `icon` resolves to an
 * SF Symbol on iOS / MDI glyph on Android via the shared icon-map (no
 * synthesized imagery). Card COPY is resolved separately via `useOnboardingCopy`
 * with static `t()` literals so the i18n orphan checker can see every key — the
 * project lint hard-fails on `t(variable)`, so the keys can't live here as data.
 *
 * Pure data — kept out of the component so it can be unit-tested and so the
 * carousel's `renderItem` stays a hoisted, dependency-free callback.
 */
export type OnboardingCardId = 'welcome' | 'connect' | 'find' | 'play';

export type OnboardingCard = {
  id: OnboardingCardId;
  icon: IconName;
};

export const ONBOARDING_CARDS: readonly OnboardingCard[] = [
  { id: 'welcome', icon: 'lightbulb.fill' },
  { id: 'connect', icon: 'bluetooth' },
  { id: 'find', icon: 'search' },
  { id: 'play', icon: 'playlist' },
] as const;

export const ONBOARDING_TOTAL_STEPS = ONBOARDING_CARDS.length;
