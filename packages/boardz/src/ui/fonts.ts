import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular';
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium';
import { Geist_600SemiBold } from '@expo-google-fonts/geist/600SemiBold';
import { GeistMono_300Light } from '@expo-google-fonts/geist-mono/300Light';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { GeistMono_500Medium } from '@expo-google-fonts/geist-mono/500Medium';

/**
 * Geist for the interface, Geist Mono for every figure (SIL Open Font
 * License). Each weight is its own family on iOS, so styles pick a family
 * rather than a fontWeight.
 */
export const FONT = {
  sans: 'Geist-Regular',
  sansMedium: 'Geist-Medium',
  sansSemiBold: 'Geist-SemiBold',
  monoLight: 'GeistMono-Light',
  mono: 'GeistMono-Regular',
  monoMedium: 'GeistMono-Medium',
} as const;

/** Handed to expo-font's useFonts at launch. */
export const FONT_FILES = {
  [FONT.sans]: Geist_400Regular,
  [FONT.sansMedium]: Geist_500Medium,
  [FONT.sansSemiBold]: Geist_600SemiBold,
  [FONT.monoLight]: GeistMono_300Light,
  [FONT.mono]: GeistMono_400Regular,
  [FONT.monoMedium]: GeistMono_500Medium,
};
