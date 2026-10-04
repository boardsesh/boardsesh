import { useHeaderHeight } from 'expo-router/react-navigation';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';
import { glassStackScreenOptions } from '../theme/navigation';

/**
 * How far a pushed screen's content has to start down the page to clear its
 * header, for content that does not get there on its own.
 *
 * A `ScrollView` with `contentInsetAdjustmentBehavior="automatic"` needs none of
 * this: iOS insets it under the transparent glass header for free. A screen that
 * has to know its own visible height — to fit something into it rather than let
 * it scroll — cannot use that, because the inset is applied natively and Yoga
 * never hears about it. This is the same number, said out loud.
 *
 * Zero wherever the header is opaque (Material, and Liquid Glass on Android),
 * since content there already begins below it. Must be called inside a screen of
 * a stack that uses `useStackScreenOptions`; lives in `src/hooks` for the same
 * reason that hook does — it RESOLVES the variant.
 */
export function useTransparentHeaderInset(): number {
  const { variant } = useTheme();
  const headerHeight = useHeaderHeight();
  return selectByVariant(variant, {
    liquidGlass: glassStackScreenOptions.headerTransparent ? headerHeight : 0,
    material: 0,
  });
}
