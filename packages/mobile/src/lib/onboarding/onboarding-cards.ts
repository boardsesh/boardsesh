import type { ImageSourcePropType } from 'react-native';
import type { IconName } from '../../components/icon-map';
// Real board-presence "now on the wall" capture, cropped by
// `vp run mobile:onboarding-assets` from the onboarding screenshot flow. ESM
// import (not require) so the vitest asset alias can redirect it in tests.
import boardHistoryImage from '../../../assets/onboarding/board-history.png';

/**
 * The single first-run framing card. It names the headline payoff (live board
 * history) and its CTA hands the user straight into the real /boards picker —
 * following a named board is what turns board history on, so teaching it and
 * activating it are the same motion. `id` is the stable analytics step id
 * (mirrors web's tour step ids); `icon` resolves to an SF Symbol on iOS / MDI
 * glyph on Android via the shared icon-map. An optional `image` (a real captured
 * board-presence screen, produced by `--flow onboarding` in
 * `scripts/mobile-screenshots.ts`) takes precedence over the glyph when present,
 * so wiring the screenshot in later is purely additive. Card COPY is resolved
 * separately via `useOnboardingCopy` with static `t()` literals so the i18n
 * orphan checker can see every key — the project lint hard-fails on `t(variable)`.
 */
export type OnboardingCardId = 'welcome';

export type OnboardingCard = {
  id: OnboardingCardId;
  icon: IconName;
  /** Real board-presence illustration; falls back to `icon` when absent. */
  image?: ImageSourcePropType;
};

export const ONBOARDING_PROMPT_CARD: OnboardingCard = {
  id: 'welcome',
  icon: 'lightbulb.fill',
  image: boardHistoryImage,
};

// A single framing screen — kept for the web-mirrored analytics shape
// (stepIndex / totalSteps).
export const ONBOARDING_TOTAL_STEPS = 1;
