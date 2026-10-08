import type { ColorValue } from 'react-native';
import { selectByVariant } from '../theme/variants/select-by-variant';
import type { UiVariant } from '../theme/resolve-ui-variant';
import type { TextVariant } from '../theme/typography';

/**
 * The type of a list section header, per UI variant, shared by `SectionHeader`
 * and the rows that draw a header inside a list (the gym directory):
 * - Liquid Glass: footnote semibold in secondaryLabel, the native SwiftUI Form
 *   header (HIG Lists and tables).
 * - Material: titleSmall (14/500) in onSurfaceVariant (M3 Lists).
 * Case, opacity and tracking come from `sectionCaption`.
 */
export function sectionHeaderText(
  variant: UiVariant,
  colors: { secondaryLabel: ColorValue; onSurfaceVariant: ColorValue },
): { textVariant: TextVariant; color: ColorValue; fontWeight: '600' | '500' } {
  return selectByVariant<{ textVariant: TextVariant; color: ColorValue; fontWeight: '600' | '500' }>(variant, {
    material: { textVariant: 'subheadline', color: colors.onSurfaceVariant, fontWeight: '500' },
    liquidGlass: { textVariant: 'footnote', color: colors.secondaryLabel, fontWeight: '600' },
  });
}
