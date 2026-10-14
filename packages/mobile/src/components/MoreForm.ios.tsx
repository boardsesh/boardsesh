// MoreForm — iOS implementation, a real SwiftUI `Form` via @expo/ui/swift-ui.
//
// The entire "More" settings screen is ONE `Host` containing a single SwiftUI
// `Form` (the grouped, inset-rounded iOS Settings look — section insets,
// separators, and scrolling all for free). This mirrors the FeatureFlagsForm
// pilot: instead of one `Host` per control, the whole form lives under one `Host`.
//
// HOST SIZING: a `Form` is a scrolling container that fills its space, so the Host
// uses `style={{ flex: 1 }}` + `useViewportSizeMeasurement` (gives SwiftUI the
// viewport as its proposed size). Per-row controls elsewhere use `matchContents`;
// a Form is the opposite case — it takes all the height it's given.
//
// The screen (more.tsx) precomputes every string + handler (incl. haptics), so
// this tree only renders props. Each row kind maps to the idiomatic SwiftUI
// control: nav → a Button row whose leading symbol + title/subtitle go through a
// SwiftUI `Label` (so titles line up whatever the glyph's width), an optional
// badge and value, and a trailing chevron (an outward arrow when it leaves the
// app); toggle → Toggle; segmented → segmented Picker; select → menu-style
// Picker; info → read-only copy; value → a label with a trailing value or
// spinner; button → Button (destructive colours it red).

import type { ComponentProps } from 'react';
import { Host } from '@expo/ui';
import {
  Form,
  Section,
  Picker,
  Toggle,
  Text,
  Button,
  Image,
  HStack,
  VStack,
  Spacer,
  Slider,
  Label,
  ProgressView,
  RNHostView,
} from '@expo/ui/swift-ui';
import {
  pickerStyle,
  tint,
  tag,
  font,
  foregroundStyle,
  textSelection,
  badge as badgeModifier,
  accessibilityLabel as accessibilityLabelModifier,
  accessibilityValue as accessibilityValueModifier,
  accessibilityHint as accessibilityHintModifier,
  frame,
  listRowInsets,
  listRowSeparator,
  disabled as disabledModifier,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { assertNeverRow, guardedButtonPress, isButtonRowPressable, useOpensOutsideAppHint } from './MoreForm.logic';
import { makeSelectHandler } from './SegmentedControl.logic';
import { useSliderCommit } from './MoreForm.slider';
import type {
  MoreButtonRow,
  MoreFormProps,
  MoreIconName,
  MoreNavRow,
  MoreRow,
  MoreSliderRow,
  MoreValueRow,
} from './MoreForm.types';

// Hierarchical foreground styles for the system label colours SwiftUI uses in a
// Settings list. Reused across rows so the palette can't drift.
const PRIMARY_LABEL = foregroundStyle({ type: 'hierarchical', style: 'primary' });
const SECONDARY_LABEL = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const TERTIARY_LABEL = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });
const FOOTNOTE = font({ textStyle: 'footnote' });
const SELECTABLE_TEXT = textSelection(true);

// The SFSymbol union the Image `systemName` prop accepts. The model carries a
// semantic `MoreIconName`; map it to the SF Symbol here (the symbol union isn't
// resolvable from the shared types module), then narrow at the single call site.
type SystemImageName = NonNullable<ComponentProps<typeof Image>['systemName']>;

// Semantic icon → SF Symbol. Kept as plain strings + cast at the call site (the
// prior `sfSymbol` field was a string too) so an SF Symbol name that isn't in the
// `sf-symbols-typescript` union doesn't fail the type-check.
const IOS_SF_SYMBOL: Record<MoreIconName, string> = {
  // Matches the Home chrome's bell, so the two ways into notifications read as
  // the same destination.
  // A shield with a check — "the crew vets this", rather than a gavel's
  // courtroom framing. Android uses the Material gavel drawable, the closest
  // glyph that set actually ships.
  // The integrations page links outside accounts (Strava and friends), so a
  // chain link, not the heart it used to borrow from Health.
  integrations: 'link',
  // The watch row pairs a Garmin, so an analog watch face rather than the Apple
  // Watch silhouette.
  // Sliders — a tuning glyph for the render + accessibility knobs, not the
  // wheelchair accessibility symbol the row used to be (it isn't a system
  // accessibility setting).
  boardLook: 'slider.horizontal.3',
  accessibility: 'figure.roll',
  // What iOS Settings itself uses for on-device storage. SF Symbols 2 (iOS 14+).
  storage: 'internaldrive',
  translate: 'character.bubble',
  devServers: 'server.rack',
  otaChannel: 'arrow.triangle.2.circlepath',
  featureFlags: 'flag',
  branchSwitcher: 'arrow.triangle.branch',
  editProfile: 'person.crop.circle',
  privacy: 'hand.raised',
  account: 'person.crop.circle',
  offline: 'icloud.and.arrow.down',
  general: 'gearshape',
  climbs: 'list.bullet.rectangle',
  boardLighting: 'lightbulb',
  earlyAccess: 'testtube.2',
  developer: 'hammer',
  export: 'square.and.arrow.up',
  policy: 'doc.text',
};

function NavRow({ row }: { row: MoreNavRow }) {
  const opensOutsideAppHint = useOpensOutsideAppHint();
  const modifiers = [
    ...(row.badge ? [badgeModifier(row.badge)] : []),
    ...(row.external ? [accessibilityHintModifier(opensOutsideAppHint)] : []),
  ];
  return (
    // A row Button. Every child sets an explicit foregroundStyle so the row reads
    // as a Settings row (label/secondary/tertiary), not the default accent-tinted
    // button content. `badge(...)` adds the standard trailing badge (the "New"
    // pill); the manual chevron is the disclosure indicator.
    //
    // The icon and title go through a SwiftUI `Label`: inside a Form, Label gives
    // every icon the same column width, so titles line up down the section even
    // though `gearshape` and `list.bullet.rectangle` are different widths. With no
    // icon the Label falls back to title-only.
    <Button onPress={row.onPress} modifiers={modifiers}>
      <HStack spacing={spacing[3]}>
        <Label
          icon={
            row.icon ? (
              <Image systemName={IOS_SF_SYMBOL[row.icon] as SystemImageName} modifiers={[SECONDARY_LABEL]} />
            ) : undefined
          }
        >
          <VStack alignment="leading" spacing={spacing[1]}>
            <Text modifiers={[PRIMARY_LABEL]}>{row.label}</Text>
            {row.subtitle ? <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{row.subtitle}</Text> : null}
          </VStack>
        </Label>
        <Spacer />
        {row.value ? <Text modifiers={[SECONDARY_LABEL]}>{row.value}</Text> : null}
        <Image systemName={row.external ? 'arrow.up.right' : 'chevron.right'} modifiers={[FOOTNOTE, TERTIARY_LABEL]} />
      </HStack>
    </Button>
  );
}

/**
 * A label with a trailing value or spinner — the SwitcherForm info row plus its
 * status row's `busy` spinner. Tappable rows wrap it in a Button for the press
 * highlight; there is no chevron because the row does not navigate.
 */
function ValueRow({ row }: { row: MoreValueRow }) {
  const body = (
    <HStack spacing={spacing[3]}>
      <VStack alignment="leading" spacing={spacing[1]}>
        <Text modifiers={[PRIMARY_LABEL]}>{row.label}</Text>
        {row.subtitle ? <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{row.subtitle}</Text> : null}
      </VStack>
      <Spacer />
      {row.busy ? <ProgressView /> : null}
      {row.value ? <Text modifiers={[SECONDARY_LABEL]}>{row.value}</Text> : null}
    </HStack>
  );
  if (row.onPress) {
    return (
      <Button
        onPress={row.onPress}
        modifiers={row.accessibilityHint ? [accessibilityHintModifier(row.accessibilityHint)] : undefined}
      >
        {body}
      </Button>
    );
  }
  return body;
}

/**
 * A standalone action. `destructive` colours the label red; the action lives in
 * the screen. A `subtle` button keeps its colour but drops to footnote size so a
 * secondary destructive action (Delete Account) reads quieter than the primary
 * one (Sign Out) stacked above it, instead of two equal-weight red rows.
 *
 * `disabled` and `loading` both disable the native Button; `loading` also puts a
 * spinner beside the label so the climber can see the press landed.
 */
function ButtonRow({ row }: { row: MoreButtonRow }) {
  const role = row.role === 'destructive' ? 'destructive' : undefined;
  const modifiers = [...(row.emphasis === 'subtle' ? [FOOTNOTE] : []), disabledModifier(!isButtonRowPressable(row))];
  const handlePress = guardedButtonPress(row);
  if (row.loading) {
    return (
      <Button role={role} onPress={handlePress} modifiers={modifiers}>
        <HStack spacing={spacing[2]}>
          <ProgressView />
          <Text>{row.label}</Text>
        </HStack>
      </Button>
    );
  }
  return <Button role={role} label={row.label} onPress={handlePress} modifiers={modifiers} />;
}

function renderRow(row: MoreRow, accent: string) {
  switch (row.kind) {
    case 'nav':
      return <NavRow key={row.key} row={row} />;
    case 'toggle':
      // Two Text children → title + subtitle (SwiftUI styles the second secondary
      // and folds both into the VoiceOver label). Brand on-track tint.
      return (
        <Toggle
          key={row.key}
          isOn={row.value}
          onIsOnChange={(next) => {
            if (!row.disabled) row.onValueChange(next);
          }}
          modifiers={[tint(accent), disabledModifier(row.disabled ?? false)]}
        >
          <Text>{row.label}</Text>
          {row.subtitle ? <Text>{row.subtitle}</Text> : null}
        </Toggle>
      );
    case 'segmented':
      // Native iOS segmented control; each option's `tag` maps selection to its
      // key. The section header is the visible label, so this only carries an
      // accessibility label for VoiceOver.
      return (
        <Picker
          key={row.key}
          selection={row.selectedKey}
          onSelectionChange={(value) => {
            if (typeof value !== 'string' || row.disabled) return;
            // A SwiftUI segmented Picker cannot grey out one segment, so a
            // disabled key is enforced by ignoring the tap — same degrade, and
            // the same helper, as SegmentedControl.ios.
            makeSelectHandler(row.onSelect, row.disabledKeys)(value);
          }}
          modifiers={[
            pickerStyle('segmented'),
            tint(accent),
            disabledModifier(row.disabled ?? false),
            ...(row.label ? [accessibilityLabelModifier(row.label)] : []),
          ]}
        >
          {row.options.map((option) => (
            <Text key={option.key} modifiers={[tag(option.key)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
      );
    case 'select':
      // Menu-style Picker: a labelled row showing the current value + chevron that
      // pops a menu on tap — the idiomatic iOS Settings language picker.
      return (
        <Picker
          key={row.key}
          label={row.label}
          selection={row.selectedKey}
          onSelectionChange={(value) => {
            if (typeof value === 'string' && !row.disabled) row.onSelect(value);
          }}
          modifiers={[pickerStyle('menu'), tint(accent), disabledModifier(row.disabled ?? false)]}
        >
          {row.options.map((option) => (
            <Text key={option.key} modifiers={[tag(option.key)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
      );
    case 'info':
      return (
        <VStack key={row.key} alignment="leading" spacing={spacing[1]}>
          <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{row.label}</Text>
          <Text modifiers={[PRIMARY_LABEL, ...(row.selectable ? [SELECTABLE_TEXT] : [])]}>{row.body}</Text>
          {row.detail ? (
            <Text modifiers={[FOOTNOTE, TERTIARY_LABEL, ...(row.selectable ? [SELECTABLE_TEXT] : [])]}>
              {row.detail}
            </Text>
          ) : null}
        </VStack>
      );
    case 'value':
      return <ValueRow key={row.key} row={row} />;
    case 'button':
      return <ButtonRow key={row.key} row={row} />;
    case 'slider':
      return <SliderRow key={row.key} row={row} accent={accent} />;
    case 'custom':
      // The one place React Native content lives inside the SwiftUI tree.
      // `frame` pins the height rather than letting `matchContents` negotiate
      // one, because that negotiation has under-reported inside a scrolling
      // container before (see sheet-detent-probe.ts).
      return (
        <VStack
          key={row.key}
          modifiers={[
            frame({ height: row.height }),
            ...(row.fullBleed
              ? [listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }), listRowSeparator('hidden')]
              : []),
          ]}
        >
          <RNHostView matchContents={false}>
            <View style={{ height: row.height }}>{row.content}</View>
          </RNHostView>
        </VStack>
      );
    default:
      return assertNeverRow(row);
  }
}

/**
 * A slider row. Its own component because `useSliderCommit` is a hook and the
 * row switch is a plain function — and because the value label has to sit in an
 * `HStack` above the track, which is two views, not one.
 */
function SliderRow({ row, accent }: { row: MoreSliderRow; accent: string }) {
  const { handleValueChange, handleEditingChanged } = useSliderCommit(row);
  return (
    <VStack alignment="leading" spacing={spacing[1]}>
      <HStack>
        <Text modifiers={[PRIMARY_LABEL]}>{row.label}</Text>
        <Spacer />
        <Text modifiers={[FOOTNOTE, SECONDARY_LABEL]}>{row.format(row.value)}</Text>
      </HStack>
      <Slider
        value={row.value}
        min={row.min}
        max={row.max}
        step={row.step}
        onValueChange={handleValueChange}
        onEditingChanged={handleEditingChanged}
        modifiers={[
          tint(accent),
          accessibilityLabelModifier(row.label),
          accessibilityValueModifier(row.format(row.value)),
        ]}
      />
    </VStack>
  );
}

export function MoreForm({ model }: MoreFormProps) {
  const { brandColors, colorScheme } = useTheme();
  const accent = brandAccentColor(brandColors);

  return (
    // `colorScheme` forces the native appearance to follow our in-app Light/Dark
    // toggle (`themeOverride`) instead of the OS scheme — harmless on iOS but the
    // way the SwiftUI tree honours a non-system choice.
    <Host style={styles.host} useViewportSizeMeasurement colorScheme={colorScheme}>
      <Form>
        {model.sections.map((section) => (
          <Section
            key={section.key}
            title={section.title}
            footer={section.footer ? <Text>{section.footer}</Text> : undefined}
          >
            {section.rows.map((row) => renderRow(row, accent))}
          </Section>
        ))}
      </Form>
    </Host>
  );
}

const styles = StyleSheet.create({
  // A Form fills the screen; flex + useViewportSizeMeasurement give SwiftUI the
  // viewport as its proposed size so the Form scrolls within it.
  host: {
    flex: 1,
  },
});
