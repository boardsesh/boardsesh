// MoreForm — web implementation (react-native-web + react-native-paper). The main
// "More" settings screen, rendered from the same plain `MoreFormModel` the native
// files consume. Structurally follows MoreForm.android.tsx: each section is an
// optional title, a Material card (`Surface`) wrapping its rows — or standalone
// buttons for an all-button section — then an optional footer.
//
// This is a Phase-0 minimal-functional port: it renders every row kind and its
// handlers fire, composed from Paper primitives + the reused web controls
// (`Button`, `SegmentedControl`). Row-level polish (leading-icon tint parity, the
// exact card insets) is a Phase-1 item. The row-kind exhaustiveness guard and the
// select-label lookup live in MoreForm.logic.ts, shared with both native files.

import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Divider, List, Menu, Surface, Switch, Text } from 'react-native-paper';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { MarkerMultiplierSlider } from './settings/MarkerMultiplierSlider';
import { assertNeverRow, selectedOptionLabel } from './MoreForm.logic';
import type { MoreFormProps, MoreIconName, MoreRow, MoreSelectRow } from './MoreForm.types';

// Semantic leading-icon name → MaterialCommunityIcons glyph (Paper routes `icon`
// through the app's MDI font). Minimal-functional: each glyph reads sensibly for
// its row; exact parity with the bundled Android vector set is a Phase-1 item.
const MORE_ICON: Record<MoreIconName, string> = {
  notifications: 'bell-outline',
  playlists: 'playlist-music',
  gyms: 'office-building',
  integrations: 'puzzle-outline',
  watch: 'link-variant',
  boardLook: 'tune',
  accessibility: 'human',
  storage: 'database-outline',
  translate: 'translate',
  replay: 'replay',
  changelog: 'star-four-points',
  devServers: 'server',
  otaChannel: 'cloud-download-outline',
  featureFlags: 'flag-outline',
  branchSwitcher: 'source-branch',
  editProfile: 'account-edit-outline',
};

function SelectRow({ row }: { row: MoreSelectRow }) {
  const [visible, setVisible] = useState(false);
  const { systemColors } = useTheme();
  const currentLabel = selectedOptionLabel(row.options, row.selectedKey);
  return (
    <Menu
      visible={visible}
      onDismiss={() => setVisible(false)}
      anchor={
        <List.Item
          title={row.label}
          onPress={() => setVisible(true)}
          right={() => (
            <Text style={[styles.selectValue, { color: systemColors.secondaryLabel as string }]}>{currentLabel}</Text>
          )}
        />
      }
    >
      {row.options.map((option) => (
        <Menu.Item
          key={option.key}
          title={option.label}
          onPress={() => {
            setVisible(false);
            row.onSelect(option.key);
          }}
        />
      ))}
    </Menu>
  );
}

function renderRow(row: MoreRow): ReactNode {
  switch (row.kind) {
    case 'nav':
      return (
        <List.Item
          key={row.key}
          title={row.label}
          description={row.subtitle}
          onPress={row.onPress}
          left={row.icon ? (props) => <List.Icon {...props} icon={MORE_ICON[row.icon as MoreIconName]} /> : undefined}
          right={(props) => (
            <View style={styles.trailing}>
              {row.badge ? <Text style={styles.badge}>{row.badge}</Text> : null}
              <List.Icon {...props} icon="chevron-right" />
            </View>
          )}
        />
      );
    case 'toggle':
      return (
        <List.Item
          key={row.key}
          title={row.label}
          description={row.subtitle}
          onPress={() => row.onValueChange(!row.value)}
          accessibilityRole="switch"
          accessibilityState={{ checked: row.value }}
          right={() => <Switch value={row.value} pointerEvents="none" />}
        />
      );
    case 'segmented':
      return (
        <View key={row.key} style={styles.segmentedRow}>
          <SegmentedControl
            options={row.options.map((option) => ({ key: option.key, label: option.label }))}
            selectedKey={row.selectedKey}
            onSelect={row.onSelect}
            disabledKeys={row.disabledKeys}
            accessibilityLabel={row.label}
          />
        </View>
      );
    case 'select':
      return <SelectRow key={row.key} row={row} />;
    case 'info':
      return (
        <View key={row.key} style={styles.infoRow}>
          <Text style={styles.infoLabel}>{row.label}</Text>
          <Text style={styles.infoBody} selectable={row.selectable}>
            {row.body}
          </Text>
          {row.detail ? (
            <Text style={styles.infoDetail} selectable={row.selectable}>
              {row.detail}
            </Text>
          ) : null}
        </View>
      );
    case 'button': {
      const isSubtleDestructive = row.role === 'destructive' && row.emphasis === 'subtle';
      return (
        <View key={row.key} style={styles.buttonRow}>
          <Button
            title={row.label}
            onPress={row.onPress}
            variant={isSubtleDestructive ? 'text' : 'filled'}
            role={row.role === 'destructive' ? 'destructive' : 'default'}
            style={styles.fullWidth}
          />
        </View>
      );
    }
    case 'slider':
      return (
        <View key={row.key} style={styles.sliderRow}>
          <MarkerMultiplierSlider
            accessibilityLabel={row.label}
            value={row.value}
            min={row.min}
            max={row.max}
            step={row.step}
            format={row.format}
            onChange={row.onValueChange}
            onChangeEnd={row.onCommit}
          />
        </View>
      );
    case 'custom':
      // No native host on web — the subtree is already React Native Web, so it
      // renders inline. `height` still applies so the row matches the native
      // platforms and a fixed-height carousel doesn't collapse.
      return (
        <View key={row.key} style={[{ height: row.height }, row.fullBleed ? undefined : styles.customRow]}>
          {row.content}
        </View>
      );
    default:
      return assertNeverRow(row);
  }
}

export function MoreForm({ model }: MoreFormProps) {
  const { systemColors } = useTheme();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      {model.sections.map((section) => {
        const allButtons = section.rows.every((row) => row.kind === 'button');
        return (
          <View key={section.key} style={styles.section}>
            {section.title ? (
              <Text style={[styles.sectionTitle, { color: systemColors.secondaryLabel as string }]}>
                {section.title}
              </Text>
            ) : null}
            {allButtons ? (
              section.rows.map((row) => renderRow(row))
            ) : (
              <Surface style={styles.card} elevation={1}>
                {section.rows.map((row, index) => (
                  <View key={row.key}>
                    {index > 0 ? <Divider /> : null}
                    {renderRow(row)}
                  </View>
                ))}
              </Surface>
            )}
            {section.footer ? (
              <Text style={[styles.sectionFooter, { color: systemColors.secondaryLabel as string }]}>
                {section.footer}
              </Text>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    paddingBottom: spacing[10],
    gap: spacing[3],
  },
  section: {
    gap: spacing[2],
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    opacity: 0.7,
  },
  sectionFooter: {
    fontSize: 12,
    opacity: 0.6,
  },
  card: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  badge: {
    fontSize: 12,
    fontWeight: '600',
  },
  selectValue: {
    alignSelf: 'center',
    fontSize: 15,
  },
  segmentedRow: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  sliderRow: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  customRow: {
    paddingHorizontal: spacing[4],
  },
  infoRow: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
  },
  infoLabel: {
    fontSize: 12,
    opacity: 0.6,
  },
  infoBody: {
    fontSize: 14,
  },
  infoDetail: {
    fontSize: 11,
    opacity: 0.6,
  },
  buttonRow: {
    paddingVertical: spacing[1],
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
});
