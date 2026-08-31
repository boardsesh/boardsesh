// MoreForm — Android implementation, a Jetpack Compose `LazyColumn` via
// @expo/ui/jetpack-compose.
//
// The entire "More" settings screen is ONE `Host` containing a single
// `LazyColumn` — the Compose counterpart to the iOS `Form`. Like the
// FeatureFlagsForm pilot, the whole list lives under one `Host`. A `LazyColumn`
// virtualizes its items, so the Host is `style={{ flex: 1 }}` (NOT `matchContents`,
// which per-row controls use to report intrinsic height back to RN).
//
// Each section becomes: an optional title `Text`, then either a Material `Card`
// wrapping its rows (nav / toggle / segmented / select / info) OR standalone
// `Button`s (an all-button section like the account actions), then an optional
// footer `Text`. Brand colours come from the `expo-ui-modifiers` bridge; M3
// surface/label colours come from the Compose Material theme the Host sets up.
//
// The screen (more.tsx) precomputes every string + handler (incl. haptics); this
// tree renders props and invokes handlers.

import { useEffect, useState, type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Host } from '@expo/ui';
import {
  LazyColumn,
  Card,
  Column,
  Row,
  Text,
  Switch,
  Button,
  TextButton,
  Badge,
  Icon,
  Spacer,
  SingleChoiceSegmentedButtonRow,
  SegmentedButton,
  DropdownMenu,
  DropdownMenuItem,
  BasicTextField,
  Slider,
  RNHostView,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, alpha, weight, clickable, height } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet, type ColorValue, type ImageSourcePropType } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import {
  segmentedBrandColors,
  sliderBrandColors,
  switchBrandColors,
  type BrandControlColors,
} from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { materialTextStyles } from '../theme/typography';
import { assertNeverRow, selectedOptionLabel } from './MoreForm.logic';
import { materialStepCount, useSliderCommit } from './MoreForm.slider';
import type { MoreFormProps, MoreIconName, MoreRow, MoreSelectRow, MoreSliderRow } from './MoreForm.types';

// Semantic icon → Material XML vector drawable. The `.xml` files are bundled as
// ASSETS (metro.config.js adds `xml` to resolver.assetExts), so `require()` gives
// the Compose `Icon` a vector-drawable source it tints itself. White-filled
// (#FFFFFFFF) so the `tint` recolours them; a missing `icon` renders no leading slot.
const MORE_ICON_SOURCE: Record<MoreIconName, ImageSourcePropType> = {
  notifications: require('../../assets/material-icons/notifications.xml'),
  playlists: require('../../assets/material-icons/playlists.xml'),
  gyms: require('../../assets/material-icons/gyms.xml'),
  integrations: require('../../assets/material-icons/integrations.xml'),
  // No smartwatch glyph in the bundled Material set; the chain-link icon reads as
  // "pair / link a device", the closest sensible fit for the watch-pairing row.
  watch: require('../../assets/material-icons/link.xml'),
  // Sliders — a tuning glyph for the render + accessibility knobs, not the
  // wheelchair accessibility drawable the row used to be.
  boardLook: require('../../assets/material-icons/tune.xml'),
  // The Board look screen's own Accessibility leaf — hold colours, marker
  // shapes and role glyphs. The wheelchair drawable the old top-level
  // Accessibility row used, back where it means something.
  accessibility: require('../../assets/material-icons/accessibility.xml'),
  storage: require('../../assets/material-icons/storage.xml'),
  translate: require('../../assets/material-icons/translate.xml'),
  replay: require('../../assets/material-icons/replay.xml'),
  changelog: require('../../assets/material-icons/changelog.xml'),
  devServers: require('../../assets/material-icons/devServers.xml'),
  otaChannel: require('../../assets/material-icons/otaChannel.xml'),
  featureFlags: require('../../assets/material-icons/featureFlags.xml'),
  branchSwitcher: require('../../assets/material-icons/branchSwitcher.xml'),
  editProfile: require('../../assets/material-icons/editProfile.xml'),
};

// Trailing disclosure chevron. The Compose `Icon` needs a vector-drawable source,
// so a muted `›` glyph stands in for the disclosure indicator on these nav rows.
const CHEVRON = '›';
const ROW_PADDING = padding(spacing[4], spacing[3], spacing[4], spacing[3]);

type RowColors = {
  brandColors: BrandControlColors & { error: string };
  switchColors: ReturnType<typeof switchBrandColors>;
  segmentColors: ReturnType<typeof segmentedBrandColors>;
  /** Tint for a nav row's leading Material icon — the secondary-label colour. */
  iconTint: ColorValue;
};

function SelectRow({ row }: { row: MoreSelectRow }) {
  const [expanded, setExpanded] = useState(false);
  const currentLabel = selectedOptionLabel(row.options, row.selectedKey);
  return (
    <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
      <DropdownMenu.Trigger>
        <Row modifiers={[fillMaxWidth(), clickable(() => setExpanded(true)), ROW_PADDING]} verticalAlignment="center">
          <Column modifiers={[weight(1)]}>
            <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
          </Column>
          <Text style={{ typography: 'bodyMedium' }} modifiers={[alpha(0.6)]}>
            {currentLabel}
          </Text>
          <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.4)]}>
            {CHEVRON}
          </Text>
        </Row>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {row.options.map((option) => (
          <DropdownMenuItem
            key={option.key}
            onClick={() => {
              row.onSelect(option.key);
              setExpanded(false);
            }}
          >
            <DropdownMenuItem.Text>
              <Text>{option.label}</Text>
            </DropdownMenuItem.Text>
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}

function SelectableInfoText({ text, detail = false }: { text: string; detail?: boolean }) {
  const textState = useNativeState(text);

  useEffect(() => {
    textState.set(text);
  }, [text, textState]);

  return (
    <BasicTextField
      value={textState}
      readOnly
      textStyle={detail ? materialTextStyles.caption1 : materialTextStyles.subheadline}
      modifiers={[fillMaxWidth(), ...(detail ? [alpha(0.6)] : [])]}
    />
  );
}

function renderRow(row: MoreRow, colors: RowColors): ReactNode {
  switch (row.kind) {
    case 'nav':
      return (
        <Row key={row.key} modifiers={[fillMaxWidth(), clickable(row.onPress), ROW_PADDING]} verticalAlignment="center">
          {/* Leading Material icon (a bundled XML vector drawable), tinted to the
              secondary-label colour with a trailing gap before the label column —
              the normal Material list-row layout. Omitted when the row has no icon. */}
          {row.icon ? (
            <Icon
              source={MORE_ICON_SOURCE[row.icon]}
              size={22}
              tint={colors.iconTint}
              contentDescription={undefined}
              modifiers={[padding(0, 0, spacing[3], 0)]}
            />
          ) : null}
          <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
            <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
            {row.subtitle ? (
              <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
                {row.subtitle}
              </Text>
            ) : null}
          </Column>
          {row.badge ? (
            <Badge containerColor={colors.brandColors.primaryFill} contentColor={colors.brandColors.onPrimary}>
              <Text style={{ typography: 'labelSmall' }}>{row.badge}</Text>
            </Badge>
          ) : null}
          <Spacer modifiers={[padding(spacing[2], 0, 0, 0)]} />
          <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.4)]}>
            {CHEVRON}
          </Text>
        </Row>
      );
    case 'toggle':
      return (
        <Row key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]} verticalAlignment="center">
          <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
            <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
            {row.subtitle ? (
              <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
                {row.subtitle}
              </Text>
            ) : null}
          </Column>
          <Switch value={row.value} onCheckedChange={row.onValueChange} colors={colors.switchColors} />
        </Row>
      );
    case 'segmented':
      return (
        <Column key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]}>
          <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
            {row.options.map((option) => (
              <SegmentedButton
                key={option.key}
                selected={option.key === row.selectedKey}
                enabled={!row.disabledKeys?.has(option.key)}
                onClick={() => row.onSelect(option.key)}
                colors={colors.segmentColors}
              >
                <SegmentedButton.Label>
                  <Text>{option.label}</Text>
                </SegmentedButton.Label>
              </SegmentedButton>
            ))}
          </SingleChoiceSegmentedButtonRow>
        </Column>
      );
    case 'select':
      return <SelectRow key={row.key} row={row} />;
    case 'info':
      return (
        <Column key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]} verticalArrangement={{ spacedBy: spacing[1] }}>
          <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
            {row.label}
          </Text>
          {row.selectable ? (
            <SelectableInfoText text={row.body} />
          ) : (
            <Text style={{ typography: 'bodyMedium' }}>{row.body}</Text>
          )}
          {row.detail ? (
            row.selectable ? (
              <SelectableInfoText text={row.detail} detail />
            ) : (
              <Text style={{ typography: 'labelSmall' }} modifiers={[alpha(0.6)]}>
                {row.detail}
              </Text>
            )
          ) : null}
        </Column>
      );
    case 'button':
      // A `subtle` destructive action (Delete Account) renders as a TEXT button
      // whose label is the error colour — a quieter, secondary affordance — so it
      // doesn't read as a second heavy filled-red block next to the primary
      // destructive action (Sign Out). Both stay red; only the weight differs.
      if (row.role === 'destructive' && row.emphasis === 'subtle') {
        return (
          <TextButton
            key={row.key}
            onClick={row.onPress}
            modifiers={[fillMaxWidth()]}
            colors={{ contentColor: colors.brandColors.error }}
          >
            <Text>{row.label}</Text>
          </TextButton>
        );
      }
      return (
        <Button
          key={row.key}
          onClick={row.onPress}
          modifiers={[fillMaxWidth()]}
          colors={
            row.role === 'destructive'
              ? { containerColor: colors.brandColors.error, contentColor: colors.brandColors.onPrimary }
              : undefined
          }
        >
          <Text>{row.label}</Text>
        </Button>
      );
    case 'slider':
      return <SliderRow key={row.key} row={row} colors={colors} />;
    case 'custom':
      // The one place React Native content lives inside the Compose tree.
      //
      // The nested GestureHandlerRootView is not belt-and-braces: @expo/ui hosts
      // RN on a surface the app's root GestureHandlerRootView does not cover, so
      // without one every RNGH gesture inside silently does nothing (#4320, and
      // see the same fix in InteractiveCreateBoard).
      //
      // The height is pinned rather than negotiated via `matchContents`, for the
      // reason given on MoreCustomRow.
      return (
        <RNHostView key={row.key} matchContents={false} modifiers={[fillMaxWidth(), height(row.height)]}>
          <GestureHandlerRootView style={{ height: row.height }}>{row.content}</GestureHandlerRootView>
        </RNHostView>
      );
    default:
      return assertNeverRow(row);
  }
}

/**
 * A slider row. Its own component because `useSliderCommit` is a hook, and the
 * value label sits in a Row above the track.
 *
 * `materialStepCount` converts our increment into Material3's count-of-values-
 * between-the-endpoints — the two platforms mean different things by "step".
 */
function SliderRow({ row, colors }: { row: MoreSliderRow; colors: RowColors }) {
  const { handleValueChange, handleFinished } = useSliderCommit(row);
  return (
    <Column key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]} verticalArrangement={{ spacedBy: spacing[1] }}>
      <Row modifiers={[fillMaxWidth()]} verticalAlignment="center">
        <Column modifiers={[weight(1)]}>
          <Text>{row.label}</Text>
        </Column>
        <Text modifiers={[alpha(0.6)]}>{row.format(row.value)}</Text>
      </Row>
      <Slider
        value={row.value}
        min={row.min}
        max={row.max}
        steps={materialStepCount(row.min, row.max, row.step)}
        onValueChange={handleValueChange}
        onValueChangeFinished={handleFinished}
        colors={sliderBrandColors(colors.brandColors)}
        modifiers={[fillMaxWidth()]}
      />
    </Column>
  );
}

export function MoreForm({ model }: MoreFormProps) {
  const { brandColors, systemColors, colorScheme } = useTheme();
  const colors: RowColors = {
    brandColors,
    switchColors: switchBrandColors(brandColors),
    segmentColors: segmentedBrandColors(brandColors),
    iconTint: systemColors.secondaryLabel,
  };

  // Flatten sections into LazyColumn items: title Text, the rows (carded unless
  // the section is all buttons), then footer Text.
  const items: ReactNode[] = [];
  for (const section of model.sections) {
    if (section.title) {
      items.push(
        <Text key={`${section.key}-title`} style={{ typography: 'titleSmall' }} modifiers={[alpha(0.6)]}>
          {section.title}
        </Text>,
      );
    }
    const allButtons = section.rows.every((row) => row.kind === 'button');
    if (allButtons) {
      // Standalone full-width buttons (e.g. Sign Out / Delete Account), no card.
      for (const row of section.rows) items.push(renderRow(row, colors));
    } else {
      items.push(
        <Card key={`${section.key}-card`} modifiers={[fillMaxWidth()]}>
          <Column modifiers={[fillMaxWidth()]}>{section.rows.map((row) => renderRow(row, colors))}</Column>
        </Card>,
      );
    }
    if (section.footer) {
      items.push(
        <Text key={`${section.key}-footer`} style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
          {section.footer}
        </Text>,
      );
    }
  }

  return (
    // `colorScheme` forces the Compose MaterialTheme to follow our in-app
    // Light/Dark toggle (`themeOverride`) instead of the OS scheme — without it the
    // cards stay dark when the user picks "Light" in-app.
    <Host style={styles.host} colorScheme={colorScheme}>
      <LazyColumn
        contentPadding={{ start: spacing[4], top: spacing[4], end: spacing[4], bottom: spacing[10] }}
        verticalArrangement={{ spacedBy: spacing[3] }}
      >
        {items}
      </LazyColumn>
    </Host>
  );
}

const styles = StyleSheet.create({
  // A LazyColumn virtualizes its rows and needs a bounded height to fill.
  host: {
    flex: 1,
  },
});
