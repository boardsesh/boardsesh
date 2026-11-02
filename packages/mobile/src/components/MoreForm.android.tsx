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
// wrapping its rows (nav / toggle / segmented / select / info / value) OR
// standalone `Button`s (an all-button section like the account actions), then an
// optional footer `Text`. Brand colours come from the `expo-ui-modifiers` bridge; M3
// surface/label colours come from the Compose Material theme the Host sets up.
//
// The screen (more.tsx) precomputes every string + handler (incl. haptics); this
// tree renders props and invokes handlers.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ComposeHost } from './ComposeHost.android';
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
  IconButton,
  Spacer,
  SingleChoiceSegmentedButtonRow,
  SegmentedButton,
  DropdownMenuItem,
  ExposedDropdownMenu,
  ExposedDropdownMenuBox,
  BasicTextField,
  Slider,
  CircularProgressIndicator,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  alpha,
  weight,
  clickable,
  size,
  semantics,
  menuAnchor,
  selectable,
} from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet, type ColorValue, type ImageSourcePropType } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import {
  segmentedBrandColors,
  sliderControlColors,
  switchControlColors,
  type BrandControlColors,
} from '../theme/expo-ui-modifiers';
import { material, spacing } from '../theme/tokens';
import { materialTextStyles } from '../theme/typography';
import {
  assertNeverRow,
  guardedButtonPress,
  isButtonRowPressable,
  selectedOptionLabel,
  useOpensOutsideAppHint,
} from './MoreForm.logic';
import { materialStepCount, useSliderCommit } from './MoreForm.slider';
import type {
  MoreButtonRow,
  MoreFormProps,
  MoreIconName,
  MoreNavRow,
  MoreRow,
  MoreRowAction,
  MoreSelectRow,
  MoreSliderRow,
  MoreValueRow,
} from './MoreForm.types';

// Semantic icon → Material XML vector drawable. The `.xml` files are bundled as
// ASSETS (metro.config.js adds `xml` to resolver.assetExts), so `require()` gives
// the Compose `Icon` a vector-drawable source it tints itself. White-filled
// (#FFFFFFFF) so the `tint` recolours them; a missing `icon` renders no leading slot.
const MORE_ICON_SOURCE: Record<MoreIconName, ImageSourcePropType> = {
  // Material's gavel — the nearest "the community decides this" glyph the set
  // ships. iOS uses a checkmark shield.
  // The integrations page links outside accounts, so Material's chain link —
  // the same glyph iOS draws (`link`).
  integrations: require('../../assets/material-icons/link.xml'),
  // Material's `watch` (outlined), for the Garmin pairing row.
  // Sliders — a tuning glyph for the render + accessibility knobs, not the
  // wheelchair accessibility drawable the row used to be.
  boardLook: require('../../assets/material-icons/tune.xml'),
  // The Board look screen's own Accessibility leaf — hold colours, marker
  // shapes and role glyphs. The wheelchair drawable the old top-level
  // Accessibility row used, back where it means something.
  accessibility: require('../../assets/material-icons/accessibility.xml'),
  storage: require('../../assets/material-icons/storage.xml'),
  translate: require('../../assets/material-icons/translate.xml'),
  devServers: require('../../assets/material-icons/devServers.xml'),
  otaChannel: require('../../assets/material-icons/otaChannel.xml'),
  featureFlags: require('../../assets/material-icons/featureFlags.xml'),
  branchSwitcher: require('../../assets/material-icons/branchSwitcher.xml'),
  editProfile: require('../../assets/material-icons/editProfile.xml'),
  privacy: require('../../assets/material-icons/privacy.xml'),
  // The rest are Material Icons Outlined (24dp), matching the glyphs iOS draws:
  // account_circle, settings, format_list_bulleted, science, build, ios_share
  // and description.
  account: require('../../assets/material-icons/account.xml'),
  general: require('../../assets/material-icons/general.xml'),
  climbs: require('../../assets/material-icons/climbs.xml'),
  // Material Symbols' outlined home, the Home tab's glyph.
  home: require('../../assets/material-icons/home.xml'),
  // Material Symbols' outlined timer.
  timers: require('../../assets/material-icons/timers.xml'),
  earlyAccess: require('../../assets/material-icons/earlyAccess.xml'),
  developer: require('../../assets/material-icons/developer.xml'),
  export: require('../../assets/material-icons/export.xml'),
  policy: require('../../assets/material-icons/policy.xml'),
};

// Material's arrow_upward / arrow_downward, for a row's move buttons.
const ROW_ACTION_ICON_SOURCE: Record<MoreRowAction['icon'], ImageSourcePropType> = {
  moveUp: require('../../assets/material-icons/arrow-upward.xml'),
  moveDown: require('../../assets/material-icons/arrow-downward.xml'),
};

// Material's open_in_new, in place of the chevron on a row that leaves the app.
const OPEN_EXTERNAL_ICON_SOURCE: ImageSourcePropType = require('../../assets/material-icons/open-external.xml');

// Trailing disclosure chevron. The Compose `Icon` needs a vector-drawable source,
// so a muted `›` glyph stands in for the disclosure indicator on these nav rows.
const CHEVRON = '›';
/** The open select menu's mark on the current choice (AppMenu.android draws the same). */
const SELECTED_MARK = '✓';
// M3's disabled-content opacity, for a select row that cannot open.
const DISABLED_ROW = alpha(material.disabledContentOpacity);
const ROW_PADDING = padding(spacing[4], spacing[3], spacing[4], spacing[3]);
// Vertical gap between sections, so each section's card reads as its own group.
const SECTION_GAP = spacing[5];

type RowColors = {
  brandColors: BrandControlColors & { error: string };
  /** On-track in the control tint (dark thumb in dark mode); Velvet off state. */
  switchColors: ReturnType<typeof switchControlColors>;
  segmentColors: ReturnType<typeof segmentedBrandColors>;
  /** Tint for a nav row's leading Material icon — the secondary-label colour. */
  iconTint: ColorValue;
  /**
   * Scheme-aware label colour for the select-row menu popup. The popup is
   * a separate Compose composition the Host's `colorScheme` doesn't reach, and a
   * custom `Text` in an item slot doesn't inherit `DropdownMenuItem`'s content
   * colour — so without this the option labels render dark-on-dark when the app
   * runs dark on a light-mode device (same fix as AppMenu.android).
   */
  itemColor: string;
  /**
   * Section title/footer colour. These `Text` nodes sit directly in the
   * `LazyColumn`, not inside a `Card` — so unlike row text they get no M3
   * on-surface content colour from a surrounding container and render black
   * regardless of `colorScheme` unless given one explicitly (same class of bug
   * as `itemColor` above).
   */
  sectionTextColor: string;
};

/**
 * A select row (TalkBack): M3's exposed dropdown, so the row reads as a
 * dropdown list ("Keep lighting after Put on board, 45 seconds, drop-down
 * list"), and the open menu marks the current choice with a ✓ and the
 * selected state. `menuAnchor` gives the row Role.DropdownList and opens the
 * menu; `clickable` keeps the ripple and merges the label, subtitle and value
 * into the one node TalkBack reads. A tap reaches both, so both only open:
 * M3's own anchor click is a toggle (`onExpandedChange(!expanded)`), and its
 * `false` is dropped here, or the two would race to opposite states. The menu
 * closes on a pick or a dismiss (an outside tap, back).
 *
 * One pick per open: the current choice's `selectable` and the item's own
 * click run the same pick, and a tap that reaches both must not report the
 * setting twice.
 *
 * On a device (not visible to the JS test, which records modifiers): one tap
 * opens the menu once, an outside tap dismisses it, TalkBack reads "drop-down
 * list" on the row and "selected" on the current item, a disabled row stays shut.
 *
 * Not here: a stateDescription with the value. @expo/ui's `semantics`
 * (58.0.23) takes only contentDescription and contentType, and a native
 * modifier would change the fingerprint. The value is in the merged text.
 *
 * The anchor and the menu must stay direct children of the box: both read its
 * scope natively, and anywhere else Compose throws.
 */
function SelectRow({ row, colors }: { row: MoreSelectRow; colors: RowColors }) {
  const [expanded, setExpanded] = useState(false);
  const pickedRef = useRef(false);
  const open = expanded && !row.disabled;
  const currentLabel = selectedOptionLabel(row.options, row.selectedKey);
  const openMenu = () => {
    pickedRef.current = false;
    setExpanded(true);
  };
  // A disabled row drops its click target (the menu can't open) and dims to
  // M3's disabled-content opacity.
  const anchorModifiers = row.disabled
    ? [fillMaxWidth(), menuAnchor('primaryNotEditable', false), ROW_PADDING, DISABLED_ROW]
    : [fillMaxWidth(), menuAnchor('primaryNotEditable', true), clickable(openMenu), ROW_PADDING];
  const pick = (key: string) => {
    if (pickedRef.current) return;
    pickedRef.current = true;
    if (!row.disabled) row.onSelect(key);
    setExpanded(false);
  };
  return (
    <ExposedDropdownMenuBox
      expanded={open}
      onExpandedChange={(next) => {
        if (next) openMenu();
      }}
    >
      <Row modifiers={anchorModifiers} verticalAlignment="center">
        <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
          <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
          {/* M3 supporting text, as the switch rows draw theirs. */}
          {row.subtitle ? (
            <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
              {row.subtitle}
            </Text>
          ) : null}
        </Column>
        <Text style={{ typography: 'bodyMedium' }} modifiers={[alpha(0.6)]}>
          {currentLabel}
        </Text>
        <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.4)]}>
          {CHEVRON}
        </Text>
      </Row>
      <ExposedDropdownMenu expanded={open} onDismissRequest={() => setExpanded(false)}>
        {row.options.map((option) => {
          const selected = option.key === row.selectedKey;
          return (
            <DropdownMenuItem
              key={option.key}
              // Both the item's own content colour and the custom `Text` in its
              // slot need setting — see the `RowColors.itemColor` doc comment.
              elementColors={{ textColor: colors.itemColor }}
              // The current choice carries the selected state too, so TalkBack
              // says "Selected". Its activation runs the same pick as a tap.
              modifiers={selected ? [selectable(true, () => pick(option.key))] : undefined}
              onClick={() => pick(option.key)}
            >
              {/* The current choice carries a leading ✓, as AppMenu's rows do,
                  so the open menu shows which one is set. */}
              {selected ? (
                <DropdownMenuItem.LeadingIcon>
                  <Text color={colors.brandColors.primary}>{SELECTED_MARK}</Text>
                </DropdownMenuItem.LeadingIcon>
              ) : null}
              <DropdownMenuItem.Text>
                <Text color={colors.itemColor}>{option.label}</Text>
              </DropdownMenuItem.Text>
            </DropdownMenuItem>
          );
        })}
      </ExposedDropdownMenu>
    </ExposedDropdownMenuBox>
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

function NavRow({ row, colors }: { row: MoreNavRow; colors: RowColors }) {
  const opensOutsideAppHint = useOpensOutsideAppHint();
  return (
    <Row modifiers={[fillMaxWidth(), clickable(row.onPress), ROW_PADDING]} verticalAlignment="center">
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
      {/* M3 puts a setting's current value in the supporting text under its
          label, not trailing like iOS. */}
      <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
        <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
        {row.value ? (
          <Text style={{ typography: 'bodyMedium' }} modifiers={[alpha(0.6)]}>
            {row.value}
          </Text>
        ) : null}
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
      {row.external ? (
        // The clickable Row merges its children's semantics, so TalkBack reads
        // this description after the label: the row's only hint mechanism here.
        <Icon
          source={OPEN_EXTERNAL_ICON_SOURCE}
          size={18}
          tint={colors.iconTint}
          contentDescription={opensOutsideAppHint}
        />
      ) : (
        <Text style={{ typography: 'titleMedium' }} modifiers={[alpha(0.4)]}>
          {CHEVRON}
        </Text>
      )}
    </Row>
  );
}

/**
 * A label with a trailing value or spinner: SwitcherForm's info row, with its
 * status row's `busy` spinner. Clickable (ripple, no chevron) only when the row
 * has an action. With `valuePlacement: 'below'` the value goes under the label.
 */
function ValueRow({ row }: { row: MoreValueRow }) {
  const valueBelow = row.valuePlacement === 'below';
  return (
    <Row
      modifiers={[fillMaxWidth(), ...(row.onPress ? [clickable(row.onPress)] : []), ROW_PADDING]}
      verticalAlignment="center"
    >
      <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
        <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
        {valueBelow && row.value ? (
          <Text style={{ typography: 'bodyMedium' }} modifiers={[alpha(0.6)]}>
            {row.value}
          </Text>
        ) : null}
        {row.subtitle ? (
          <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
            {row.subtitle}
          </Text>
        ) : null}
      </Column>
      {row.busy ? (
        // Padding before size, not after — see Button.android.tsx for why the
        // reverse order draws the indicator shrunk and off-centre.
        <CircularProgressIndicator modifiers={[padding(spacing[2], 0, 0, 0), size(20, 20)]} strokeWidth={2} />
      ) : null}
      {!valueBelow && row.value ? (
        <Text style={{ typography: 'bodyMedium' }} modifiers={[padding(spacing[2], 0, 0, 0), alpha(0.6)]}>
          {row.value}
        </Text>
      ) : null}
      {row.onPress && row.accessibilityHint ? (
        // The same mechanism as a nav row's open-external hint: the clickable Row
        // merges its children's semantics, so TalkBack reads this description
        // after the label. Nothing is drawn.
        <Spacer modifiers={[semantics({ contentDescription: row.accessibilityHint })]} />
      ) : null}
    </Row>
  );
}

/** A button's label, with a leading spinner while its action is in flight. */
function ButtonLabel({ row, spinnerColor }: { row: MoreButtonRow; spinnerColor: string }) {
  if (!row.loading) return <Text>{row.label}</Text>;
  return (
    <Row verticalAlignment="center">
      <CircularProgressIndicator
        color={spinnerColor}
        strokeWidth={2}
        modifiers={[padding(0, 0, spacing[2], 0), size(18, 18)]}
      />
      <Text>{row.label}</Text>
    </Row>
  );
}

/**
 * A `subtle` button is always a TEXT button — red for a destructive action
 * (Delete Account), the brand colour otherwise (a board-look Reset) — so a
 * secondary action never reads as a heavy filled block. `primary` stays a filled
 * button, red when destructive. `disabled` and `loading` both switch the native
 * button off.
 */
function ButtonRow({ row, colors }: { row: MoreButtonRow; colors: RowColors }) {
  const isDestructive = row.role === 'destructive';
  const enabled = isButtonRowPressable(row);
  const handlePress = guardedButtonPress(row);
  if (row.emphasis === 'subtle') {
    const contentColor = isDestructive ? colors.brandColors.error : colors.brandColors.primary;
    return (
      <TextButton onClick={handlePress} enabled={enabled} modifiers={[fillMaxWidth()]} colors={{ contentColor }}>
        <ButtonLabel row={row} spinnerColor={contentColor} />
      </TextButton>
    );
  }
  return (
    <Button
      onClick={handlePress}
      enabled={enabled}
      modifiers={[fillMaxWidth()]}
      colors={
        isDestructive
          ? { containerColor: colors.brandColors.error, contentColor: colors.brandColors.onPrimary }
          : undefined
      }
    >
      <ButtonLabel row={row} spinnerColor={colors.brandColors.onPrimary} />
    </Button>
  );
}

function renderRow(row: MoreRow, colors: RowColors): ReactNode {
  switch (row.kind) {
    case 'nav':
      return <NavRow key={row.key} row={row} colors={colors} />;
    case 'toggle':
      return (
        <Row key={row.key} modifiers={[fillMaxWidth(), ROW_PADDING]} verticalAlignment="center">
          {/* Leading move buttons, as in Customize Home's sheet. Each is its own
              TalkBack stop with a full label ("Move Playlists up"); this Compose
              bridge has no custom accessibility actions. The icon takes the
              button's content colour, so a disabled one dims with it. */}
          {row.actions?.map((action) => (
            <IconButton
              key={action.key}
              onClick={() => {
                if (!action.disabled) action.onPress();
              }}
              enabled={!action.disabled}
              colors={{ contentColor: colors.brandColors.primary }}
            >
              <Icon
                source={ROW_ACTION_ICON_SOURCE[action.icon]}
                size={22}
                contentDescription={action.accessibilityLabel}
              />
            </IconButton>
          ))}
          <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: spacing[1] }}>
            <Text style={{ typography: 'bodyLarge' }}>{row.label}</Text>
            {row.subtitle ? (
              <Text style={{ typography: 'bodySmall' }} modifiers={[alpha(0.6)]}>
                {row.subtitle}
              </Text>
            ) : null}
          </Column>
          <Switch
            value={row.value}
            enabled={!row.disabled}
            onCheckedChange={(next) => {
              if (!row.disabled) row.onValueChange(next);
            }}
            colors={colors.switchColors}
          />
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
                enabled={!row.disabled && !row.disabledKeys?.has(option.key)}
                onClick={() => {
                  if (!row.disabled) row.onSelect(option.key);
                }}
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
      return <SelectRow key={row.key} row={row} colors={colors} />;
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
    case 'value':
      return <ValueRow key={row.key} row={row} />;
    case 'button':
      return <ButtonRow key={row.key} row={row} colors={colors} />;
    case 'slider':
      return <SliderRow key={row.key} row={row} colors={colors} />;
    case 'custom':
      // Screens with a custom row render MoreFormRN themselves on Android (a
      // Compose RNHostView row draws blank, #6500). Fail loudly in dev rather
      // than leave a blank gap.
      if (__DEV__) {
        throw new Error(`MoreForm.android cannot draw custom row "${row.key}"; render MoreFormRN on Android`);
      }
      return null;
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
        colors={sliderControlColors(colors.brandColors)}
        modifiers={[fillMaxWidth()]}
      />
    </Column>
  );
}

// Compose RNHostView rows report their height but draw blank on Android
// (#6500, #6585, #6546). Screens whose model has a `custom` row therefore pick
// MoreFormRN themselves, once per screen, so the renderer never swaps mid-flow.
export function MoreForm({ model }: MoreFormProps) {
  const { brandColors, systemColors, colorScheme, m3 } = useTheme();
  const colors: RowColors = {
    brandColors,
    switchColors: switchControlColors(brandColors, m3, colorScheme),
    segmentColors: segmentedBrandColors(brandColors),
    iconTint: systemColors.secondaryLabel,
    itemColor: systemColors.label as string,
    sectionTextColor: systemColors.secondaryLabel as string,
  };

  // One LazyColumn item per section: title Text, the rows (carded unless the
  // section is all buttons), then footer Text. The gaps are padding modifiers,
  // not the LazyColumn's `spacedBy`: that arrangement never reached the device,
  // so adjacent section cards rendered flush against each other.
  const items = model.sections.map((section, index) => {
    const allButtons = section.rows.every((row) => row.kind === 'button');
    return (
      <Column key={section.key} modifiers={[fillMaxWidth(), padding(0, index === 0 ? 0 : SECTION_GAP, 0, 0)]}>
        {section.title ? (
          <Text
            style={{ typography: 'titleSmall' }}
            color={colors.sectionTextColor}
            modifiers={[padding(spacing[1], 0, spacing[1], spacing[2])]}
          >
            {section.title}
          </Text>
        ) : null}
        {allButtons ? (
          // Standalone full-width buttons (e.g. Sign Out / Delete Account), no card.
          section.rows.map((row, rowIndex) => (
            <Column key={row.key} modifiers={[fillMaxWidth(), padding(0, rowIndex === 0 ? 0 : spacing[2], 0, 0)]}>
              {renderRow(row, colors)}
            </Column>
          ))
        ) : (
          <Card modifiers={[fillMaxWidth()]}>
            <Column modifiers={[fillMaxWidth()]}>{section.rows.map((row) => renderRow(row, colors))}</Column>
          </Card>
        )}
        {section.footer ? (
          <Text
            style={{ typography: 'bodySmall' }}
            color={colors.sectionTextColor}
            modifiers={[padding(spacing[1], spacing[3], spacing[1], 0)]}
          >
            {section.footer}
          </Text>
        ) : null}
      </Column>
    );
  });

  return (
    <ComposeHost style={styles.host}>
      <LazyColumn contentPadding={{ start: spacing[4], top: spacing[4], end: spacing[4], bottom: spacing[10] }}>
        {items}
      </LazyColumn>
    </ComposeHost>
  );
}

const styles = StyleSheet.create({
  // A LazyColumn virtualizes its rows and needs a bounded height to fill.
  host: {
    flex: 1,
  },
});
