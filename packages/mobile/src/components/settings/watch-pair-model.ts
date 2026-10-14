import type { ReactNode } from 'react';
import { spacing } from '../../theme/tokens';
import type { MoreFormModel, MoreRow, MoreSection } from '../MoreForm.types';

type Translation = (key: string, options?: Record<string, unknown>) => string;

export type WatchPairModelInput = {
  t: Translation;
  /** A code request is in flight. */
  isLoading: boolean;
  /** The current code, or null before the first request. */
  code: string | null;
  /** Seconds left on `code`; 0 once it has lapsed. */
  secondsLeft: number;
  /** The code drawn big and monospaced. React Native, so it rides a `custom` row. */
  codeView: ReactNode;
  /** Points, from `watchPairCodeHeight`. */
  codeHeight: number;
  onGenerate: () => void;
};

/**
 * How the pairing code is drawn: on one line, always.
 *
 * Eight letter-spaced monospaced characters at large-title size outgrow the row
 * from about fontScale 1.5, and a wrapped second line falls outside the height
 * the native form pinned, cut off. So the code shrinks to fit the width instead
 * of wrapping. 0.3 still fits it at the largest accessibility size on the
 * narrowest phone (iOS only; Android shrinks until it fits).
 */
export const WATCH_PAIR_CODE_TEXT_FIT = {
  numberOfLines: 1,
  adjustsFontSizeToFit: true,
  minimumFontScale: 0.3,
} as const;

/**
 * Height of the pairing-code row, in points.
 *
 * The native form pins a `custom` row's height before React Native lays it out,
 * and the code is large-title text that grows with the climber's text size (the
 * app's `Text` sets no multiplier cap), so the height has to scale with
 * `fontScale` or the code clips at the larger accessibility sizes. It is exactly
 * `WATCH_PAIR_CODE_TEXT_FIT.numberOfLines` lines tall: the code never wraps, and
 * shrinking to fit only makes it shorter.
 */
export function watchPairCodeHeight(fontScale: number, lineHeight: number): number {
  const line = Math.ceil(lineHeight * Math.max(fontScale, 1));
  return line * WATCH_PAIR_CODE_TEXT_FIT.numberOfLines + spacing[3] * 2;
}

/**
 * Pair a Garmin watch as plain data. One section: the code, how long it has
 * left, and the button for a fresh one. The instructions sit in its footer.
 *
 * States, in the order the climber meets them: nothing yet (Get a pairing code),
 * fetching (a spinner row), a live code (code + countdown + New code), lapsed
 * (says so + New code).
 */
export function buildWatchPairModel(input: WatchPairModelInput): MoreFormModel {
  const { t, isLoading, code, secondsLeft } = input;
  const footer = t('watchPairing.description');

  if (isLoading) {
    const section: MoreSection = {
      key: 'code',
      footer,
      rows: [{ kind: 'value', key: 'generating', label: t('watchPairing.generating'), busy: true }],
    };
    return { sections: [section] };
  }

  const newCodeButton: MoreRow = {
    kind: 'button',
    key: 'regenerate',
    label: t('watchPairing.regenerate'),
    onPress: input.onGenerate,
  };

  if (code !== null && secondsLeft > 0) {
    return {
      sections: [
        {
          key: 'code',
          title: t('watchPairing.codeInstruction'),
          footer,
          rows: [
            { kind: 'custom', key: 'code', content: input.codeView, height: input.codeHeight },
            {
              kind: 'value',
              key: 'expiresIn',
              label: t('watchPairing.expiresInLabel'),
              value: t('watchPairing.secondsLeft', { seconds: secondsLeft }),
            },
            newCodeButton,
          ],
        },
      ],
    };
  }

  if (code !== null) {
    return {
      sections: [
        {
          key: 'code',
          footer,
          rows: [{ kind: 'value', key: 'expired', label: t('watchPairing.expired') }, newCodeButton],
        },
      ],
    };
  }

  return {
    sections: [
      {
        key: 'code',
        footer,
        rows: [{ kind: 'button', key: 'generate', label: t('watchPairing.generate'), onPress: input.onGenerate }],
      },
    ],
  };
}
