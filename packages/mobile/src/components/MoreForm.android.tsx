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
// wrapping its rows (nav / toggle / segmented / select) OR standalone `Button`s
// (an all-button section like the account actions), then an optional footer
// `Text`. Brand colours come from the `expo-ui-modifiers` bridge; M3
// surface/label colours come from the Compose Material theme the Host sets up.
//
// The screen (more.tsx) precomputes every string + handler (incl. haptics); this
// tree renders props and invokes handlers.

import { useState, type ReactNode } from 'react';
import { Host } from '@expo/ui';
import {
  LazyColumn,
  Card,
  Column,
  Row,
  Text,
  Switch,
  Button,
  Badge,
  Spacer,
  SingleChoiceSegmentedButtonRow,
  SegmentedButton,
  DropdownMenu,
  DropdownMenuItem,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, alpha, weight, clickable } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { segmentedBrandColors, switchBrandColors, type BrandControlColors } from '../theme/expo-ui-modifiers';
import { spacing } from '../theme/tokens';
import { assertNeverRow, selectedOptionLabel } from './MoreForm.logic';
import type { MoreFormProps, MoreRow, MoreSelectRow } from './MoreForm.types';

// Trailing disclosure chevron. The Compose `Icon` needs a vector-drawable source,
// so a muted `›` glyph stands in for the disclosure indicator on these nav rows.
const CHEVRON = '›';
const ROW_PADDING = padding(spacing[4], spacing[3], spacing[4], spacing[3]);

type RowColors = {
  brandColors: BrandControlColors & { error: string };
  switchColors: ReturnType<typeof switchBrandColors>;
  segmentColors: ReturnType<typeof segmentedBrandColors>;
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

function renderRow(row: MoreRow, colors: RowColors): ReactNode {
  switch (row.kind) {
    case 'nav':
      return (
        <Row key={row.key} modifiers={[fillMaxWidth(), clickable(row.onPress), ROW_PADDING]} verticalAlignment="center">
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
    case 'button':
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
    default:
      return assertNeverRow(row);
  }
}

export function MoreForm({ model }: MoreFormProps) {
  const { brandColors } = useTheme();
  const colors: RowColors = {
    brandColors,
    switchColors: switchBrandColors(brandColors),
    segmentColors: segmentedBrandColors(brandColors),
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
    <Host style={styles.host}>
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
