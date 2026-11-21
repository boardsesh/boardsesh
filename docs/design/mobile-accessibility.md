# Mobile accessibility details

The long form of the accessibility defaults: Differentiate Without Color hold shapes, Large Content Viewer, the brand accent asset, full-range text, and the per-screen accessibility behaviour. It moved here from [ai-design-guidelines.md](ai-design-guidelines.md), which keeps the defaults that apply to every screen.

The native `accessibility-ui` module reads iOS **Differentiate Without Color** and
listens for changes, including a fresh read after returning from Settings. In
Classic board art, uncustomised hold roles gain distinct shapes while it is on:
start is an upward triangle, hand a circle, finish a square, foot a downward
triangle. An explicit shape selection always wins, including a circle or the
current system default. Saving only a colour preserves the existing shape choice;
Reset removes explicit choices and resumes following the OS. The effective shapes
are part of the render signature, so board-art caches update when the OS changes.
The Boardsesh drawing instead offers its existing role-glyph suggestion. Android
has no corresponding queryable setting; high-contrast text does not describe hold
roles, so it does not change the marker default.

The player's swap look (`play-drawer/player-swap-look.ts`) is off while it is on,
exactly like Reduce Motion: its ghosts show the next climb's role colours as
glow-only halos, without the role shapes, so the board changes climbs with the
shipped wall swap instead. JS reads the setting through
`useDifferentiateWithoutColor` and, on iOS, sends a look only once it reads
`'off'` (the same conservative start as Reduce Motion), so JS never runs the
look's driver while native already knows the setting is on. Android has no such
setting; the hook stays `'unknown'` there and only `'on'` would stop the look. The
GPU view also checks `UIAccessibility.shouldDifferentiateWithoutColor` on every
frame and follows its change notification, so the board motion lab never draws a
ghost either. The lab reports this as
`look off (Differentiate Without Color)`.

Persistent climb labels in `ClimbCapsule` and `NativeAccessoryClimbRow` retain
their chrome text cap and use a native Large Content Viewer at accessibility text
sizes. Long-pressing the label reveals its full climb name and grade; releasing
on it opens the play drawer. The wrapper excludes controls with their own
long-press gestures. Android, web, and binaries without the module keep the
ordinary view. UIKit interaction/activation and text-size changes require iOS
device verification before extending this wrapper to more chrome.

The `with-brand-accent-color` config plugin generates a light/dark iOS
`AccentColor` asset, including Increase Contrast variants (`#5613EA` light,
`#B6AFFF` dark, each 7:1 on its grouped ground), and the app target's global accent setting. Android AppTheme
uses the matching light/night `colorAccent`; Expo's `primaryColor` sets the same
brand violet. These native inputs require a new binary; an OTA cannot add them.


### Full accessibility text and board alternatives

Content `Text`, native buttons, and RN inputs accept the full system text range.
Use `AccessibleTextInput` for ordinary inputs and `AccessibleBottomSheetTextInput`
in sheets; both share Bold Text styling, and the sheet wrapper preserves Expo
keyboard handling and the native input ref.
Only fixed chrome opts into an explicit cap; capped climb labels expose Large
Content Viewer. Bold Text changes apply live and are reread on foregrounding.
Reduce Motion and Bold Text use ref-counted external stores: one native setting
subscription plus one foreground subscription, with revision-fenced async reads.
PressableSurface preserves caller transforms, uses immediate opacity under Reduce
Motion, and supplies Material ripple and semantic disabled opacity.
Use `useTypographyStyles` for style factories so Material uses its own type scale.
Never introduce numeric `fontSize` literals in mobile components or routes.

Readable text and feed/profile columns have a 672pt maximum width on iPad.
Logical Start/End spacing and directional SF Symbols prepare UI for RTL; board
hold coordinates remain physical. At scales above 1.3, segmented choices become
scrollable text-sized tabs. Native linear settings sliders commit once on release;
nonlinear ValueSlider tracks retain their existing mapping.

Boards announce the rendered hold-role counts. Play boards expose adjustable
previous/next actions at queue boundaries. Their value names the climb on screen
by name and grade, and its place in the list ("Yoshi's Island, V5, 5 of 40");
a step the climber takes announces it where it lands. On iOS the board carries
no value: VoiceOver reads an adjustable element's value as soon as its increment
returns, before the JS thread has changed the climb, so it would say the climb
that left first. The announcement alone says where the step went. Create's “Choose holds from a list”
action lives in the header's overflow menu and replaces the drawing area with a virtualized list using the same paint and
role-picker callbacks. A short fast flick commits a carousel swipe; springs use
release velocity and retain the host's post-render handoff.

On iOS, root screens use UIKit's collapsing large titles and automatic content
insets. Controls pinned under that bar float over the list on iOS 26 and sit on a
painted band elsewhere ("Controls pinned under the bar" in [mobile-chrome.md](mobile-chrome.md#controls-pinned-under-the-bar)). Native header controls
use 38pt slots (`glassSize.bar`), with glyphs scaled to the slot (a 24pt plus
draws at 21pt); floating controls keep their 48pt slots. A standalone avatar draws
one circular background, while grouped bar items use UIKit's shared material.
Home's scope selector scrolls with the feed, and the
on-wall climb capsule stays in the navigation bar's centre slot. Each tab's layout
owns its localized title; opening a transparent drawer must not rewrite that
title from the globally focused route. While the climb capsule is present, the
native bar stays compact without an additional large title. Removing the capsule
restores the route's collapsing large title, except on Climbs, which draws no title
at all (`NativeRootHeader` `titleHidden`). Root chrome owns the title mode and header
actions, including empty-board fallbacks.

The create-climb header uses the same measured flank balancing as `SheetTopBar`.
Its editable name centres when room permits, while the ellipsis and Save share a
trailing toolbar on Liquid Glass. The actions keep their touch targets when a long
name or translated Material label needs more space.

The create-tick form groups Tries and Stars with one divider below Stars; grade
guidance stays attached to the grade rail in secondary-label colour. Keep the
personal-grade explanation and first-ascent logging requirement visible and
wrapping. On iOS, date/time stays in the expanded sheet so the compact state
focuses on Tries, Stars and Grade. Android has one content-fitted state, so
Angle and Date start folded behind a single Details row that shows their current
values. Tapping it, or swiping up on the form, swaps in the two rows, one way,
for that sitting. The Material sheet can't do the iOS drag: its first stop is a
fixed half of the screen, too short for the form and its actions. The fold
returns on every open, and values you changed stay readable in the row. On
Material the sheet has one divider, under Stars. Collapsing preserves the chosen timestamp; expanding
restores it. When shown, the date row has no divider above the pinned footer.

Tick comments stay visible above the create sheet's actions: one line at the
medium detent and a larger field at the large detent. Focusing the field expands
the sheet; the same native input stays mounted. Done dismisses the keyboard
without saving the tick or adding a newline. Both tick action surfaces preserve
the same numeric height through their React Native touch wrappers. A blocked
filled tick action keeps its violet fill at disabled opacity; its React Native
touch owner remains disabled and exposes that state to accessibility. The
noninteractive SwiftUI child supplies the paint without the native disabled
style that turns the fill black. Loading and secondary actions keep their native
state styling.

Device QA remains required: iPhone/iPad AX1–AX5 plus Bold Text, VoiceOver/TalkBack
hold editing and queue boundaries, native slider drag/accessibility commits,
keyboard-visible form submission, RTL semantic navigation, and Reduce Motion.
Linux typechecking/tests/bundles cannot validate UIKit/SwiftUI layout or gestures.

## Dynamic Type, count badges and button sizes

Moved from [ai-design-guidelines.md](ai-design-guidelines.md).

### Dynamic Type ramp

- **Dynamic Type ramp**: on iOS each `variant` scales on the UIKit text style of the same name
  (`dynamicTypeRamp`, `src/theme/dynamic-type.ts`); `label` scales on `body`. Without a ramp, React
  Native scales every `Text` by one multiplier table, the one `fontScale` reports, which equals the
  body curve up to xxxLarge and runs ahead of it at the accessibility sizes (AX3: 2.643 against
  body's 2.353). Against that table, titles now grow much less, body, headline and label are 8–13%
  smaller at AX1–AX5, and footnote and captions grow up to 14% more at xLarge–xxxLarge. JS layout
  that sizes itself around non-body text, or around body text above xxxLarge, must use
  `textFontScale(variant, fontScale, Platform.OS)` instead of `fontScale`, or it drifts from the text
  it sits beside. A 1.5 cap does not make `fontScale` safe: it never engages below AX1. The ramp
  follows the `Text`'s `variant`, not its final size, so a body `Text` restyled to 34pt still asks
  for `'body'`. An `Icon` beside footnote or caption text takes `textVariant` to match. Layout
  switches keyed on a threshold (`fontScale > 1.3`) pick a content size category and stay on
  `fontScale`.

### Content text, chrome caps and count badges

**Dynamic Type.** Content `Text` and native `Button` default to an uncapped font scale (`0`) and
accept the full accessibility text range. Grow and wrap content rather than introducing a blanket
cap. Fixed-height chrome opts into an explicit cap: the queue capsule and iOS 26 bottom accessory
use `CHROME_LABEL_MAX_FONT_SCALE` = `1.2`, with a native Large Content Viewer for their climb labels.
Only wrap chrome that has no competing long-press gesture; the viewer reveals the full name and
grade, then opens the player on release. Binaries without that native module keep the ordinary view.
Explicit native button caps resolve to a Dynamic Type step on iOS and the requested scale on
Android. Count badges use `caption2` in a min-size box capped at `1.3` (`count-badge-style.ts`).

### Button sizes and weights

**Button sizes and weights.** `size="large"` is for the single filled call to action of a
full-screen form, gate or dead end: auth submits, "Sign in to join", the retry on a full-screen
error (Join, session unavailable, spray scan), send recovery. The tick action bar and the rest
timer's transport row are large too; on iOS a `large` button with a numeric pinned `height` draws at
`.regular` control size (with a `body` label) so the pin sets the height (#5663). Everything else is `medium`: empty states and retries inside
a tab, buttons in sheets, secondary actions, and a dismiss like Done on a dead end. Use `small`
inside cards. On iOS the label is semibold when the drawn style is prominent (filled, or an
outlined/tonal button drawn as a solid scrim pill over board art) and regular otherwise. On
Android every tier is M3 labelLarge (14/500).
