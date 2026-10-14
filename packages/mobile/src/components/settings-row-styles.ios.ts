// Text and glyph styles for rows in the SwiftUI settings forms (MoreForm.ios,
// SwitcherForm.ios), shared so the two can't drift.
//
// FIXED SEMANTIC COLOURS, NOT `foregroundStyle({ type: 'hierarchical' })`
// @expo/ui maps the hierarchical style to SwiftUI's `HierarchicalShapeStyle`,
// which is RELATIVE to the current foreground. Inside a row `Button` that
// foreground is the window tint. Under the tab controller the tint was the label
// colour, so rows looked right; once Settings moved to the root stack (#5760)
// the tint became the app AccentColor (#A78BFA in dark) and every title, value,
// chevron and icon turned lilac: values about 2.5:1 on the dark card, chevrons
// about 1.6:1. `PlatformColor('label')` and friends are absolute UIKit colours:
// they follow light/dark and Increase Contrast, and ignore the tint.
//
// Accent colour is for actions and links only; a row's title, value and
// chevron always read in these label colours.
//
// GLYPH SIZE
// @expo/ui `Image` adds `font({ size: 24 })` unless it gets a `font` modifier,
// so a bare SF Symbol draws 24pt beside 17pt text and ignores Dynamic Type.
// `ROW_ICON` and `CHEVRON` give glyphs a text style so they scale with the row.

import { PlatformColor } from 'react-native';
import { font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';

/** Row titles and body copy. */
export const PRIMARY_LABEL = foregroundStyle(PlatformColor('label'));
/** Trailing values, subtitles and leading row icons. */
export const SECONDARY_LABEL = foregroundStyle(PlatformColor('secondaryLabel'));
/** Disclosure chevrons, the open-outside arrow, and fine print. */
export const TERTIARY_LABEL = foregroundStyle(PlatformColor('tertiaryLabel'));

/** Subtitle and caption size. */
export const FOOTNOTE = font({ textStyle: 'footnote' });
/** A leading row icon: body size, so it matches the 17pt title and scales with it. */
export const ROW_ICON = font({ textStyle: 'body' });
/** The trailing chevron / arrow, sized like the iOS Settings disclosure indicator. */
export const CHEVRON = font({ textStyle: 'footnote', weight: 'semibold' });
