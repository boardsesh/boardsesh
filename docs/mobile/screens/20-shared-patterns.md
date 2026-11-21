# Shared mobile UI patterns

The [Velvet Send guidelines](../../design/ai-design-guidelines.md) define the app's design
language; [component catalogue](../../design/velvet-components.md) documents reusable props,
spacing, and accessibility. Use those native components rather than translating
MUI controls from the retired web app.

## Lists and query states

Use FlashList or the supported sheet list for user-growable content. Memoize rows,
keep render callbacks stable, and load one page per end-reach. Distinguish loading,
empty, failed, and unavailable offline content. An offline cached result is not
permission to read another account's data. Read [performance](../react-native-performance.md)
and [offline reads](../../data/offline-reads.md).

## Sheets, confirmations, and feedback

Use managed ModalSheet presentation and the existing dialog/toast providers.
Secondary tasks present above their owning route; only the owning presentation
may dismiss them. Native code imports `@expo/ui/community/bottom-sheet`; the
Gorhom implementation is confined to the Expo web shim. Sheet detents, keyboard
behavior, nested presentation, and the native tab-bar constraints are specified in
[sheets versus routes](../mobile-sheets-vs-routes.md).

Destructive actions use their existing confirmation flow. Keep drafts through an
ordinary sheet dismissal where that flow supports it, and cancel work when its
account or target changes. Contextual errors and empty states use catalog copy
with an actionable recovery when one exists.

## Gestures and accessibility

Use existing gesture and Reanimated components for swipe actions, zoom, and
feedback; do not copy the old web react-swipeable thresholds or DOM manipulation.
Respect reduced motion, touch targets, Dynamic Type, and accessible labels through
[mobile motion](../../design/mobile-motion.md), [accessibility](../../design/mobile-accessibility.md),
and [chrome](../../design/mobile-chrome.md). Grade colours and board roles come from shared
tokens and board constants, not hardcoded CSS values.
