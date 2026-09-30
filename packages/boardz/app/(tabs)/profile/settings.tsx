import { Alert, Linking, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { WEB_BASE_URL } from '../../../src/api/env';
import { useAuth } from '../../../src/auth/auth-provider';
import { describeBoard } from '../../../src/board/active-board';
import { useBoard } from '../../../src/board/board-provider';
import { GRADE_FORMATS } from '../../../src/grades/grades';
import { usePreferences } from '../../../src/settings/preferences-provider';
import { Button } from '../../../src/ui/Button';
import { Section } from '../../../src/ui/Card';
import { ExternalLink, LayoutGrid, LogOut, User } from '../../../src/ui/icons';
import { ListRow } from '../../../src/ui/ListRow';
import { SegmentedControl } from '../../../src/ui/SegmentedControl';
import { Text } from '../../../src/ui/Text';
import { TopBar } from '../../../src/ui/TopBar';
import { BOARD_BACKDROPS, useTheme, type BoardBackdrop } from '../../../src/ui/theme';
import { GUTTER, spacing } from '../../../src/ui/tokens';

const BACKDROPS: { value: BoardBackdrop; label: string }[] = [
  { value: 'charcoal', label: 'Charcoal' },
  { value: 'white', label: 'White' },
  { value: 'yellow', label: 'Yellow' },
];

// The strip has room for short names; the full ones live in GRADE_FORMATS.
const GRADE_FORMAT_LABELS = { font: 'Font', 'v-grade': 'V-scale', both: 'Both' } as const;

export default function SettingsScreen() {
  const theme = useTheme();
  const { status, profile, signOut } = useAuth();
  const { board } = useBoard();
  const { gradeFormat, boardBackdrop, update } = usePreferences();

  const confirmSignOut = () =>
    Alert.alert('Sign out of Boardz?', 'Your logbook stays on your Boardsesh account.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
      <TopBar label={`Boardz ${Constants.expoConfig?.version ?? ''}`} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="title1" style={styles.title}>
          Settings
        </Text>

        <Section title="Board">
          <View style={styles.flush}>
            <ListRow
              title={board?.name ?? 'No board set up'}
              meta={board ? `${describeBoard(board)} · ${board.angle}°` : 'Pick your board to see its climbs'}
              icon={LayoutGrid}
              accessory="chevron"
              onPress={() => router.push('/board-setup')}
            />
          </View>
        </Section>

        <Section title="Board background">
          <SegmentedControl
            fullWidth
            size="lg"
            value={boardBackdrop}
            onChange={(backdrop) => update({ boardBackdrop: backdrop })}
            options={BACKDROPS}
          />
          <View style={styles.swatches}>
            {BACKDROPS.map((backdrop) => (
              <View
                key={backdrop.value}
                style={[
                  styles.swatch,
                  {
                    backgroundColor: BOARD_BACKDROPS[backdrop.value].panel,
                    borderColor: boardBackdrop === backdrop.value ? theme.fg1 : BOARD_BACKDROPS[backdrop.value].edge,
                  },
                ]}
              />
            ))}
          </View>
          <Text variant="small" tone="tertiary">
            What MoonBoard and Woods holds are drawn on. Other boards show their own photo.
          </Text>
        </Section>

        <Section title="Grades">
          <SegmentedControl
            fullWidth
            size="lg"
            value={gradeFormat}
            onChange={(format) => update({ gradeFormat: format })}
            options={GRADE_FORMATS.map((format) => ({
              value: format.value,
              label: GRADE_FORMAT_LABELS[format.value],
              accessibilityLabel: format.label,
            }))}
          />
          <Text variant="small" tone="tertiary">
            {GRADE_FORMATS.find((format) => format.value === gradeFormat)?.label}
          </Text>
        </Section>

        <Section title="Account">
          {status === 'signedIn' ? (
            <>
              <View style={styles.flush}>
                <ListRow
                  title={profile?.displayName || 'Boardsesh account'}
                  meta={profile?.email ?? null}
                  icon={User}
                />
              </View>
              <Button title="Sign out" variant="danger" icon={LogOut} onPress={confirmSignOut} />
            </>
          ) : (
            <Button title="Sign in" fullWidth onPress={() => router.push('/login')} />
          )}
        </Section>

        <Section title="About">
          <Text variant="small" tone="tertiary">
            Boardz is a lean app built on Boardsesh&apos;s open-source code. Your account, logbook and the climb
            catalogue live on Boardsesh.
          </Text>
          <Button
            title="Open boardsesh.com"
            variant="secondary"
            size="sm"
            icon={ExternalLink}
            onPress={() => void Linking.openURL(WEB_BASE_URL)}
          />
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: GUTTER, paddingBottom: spacing.xxl, gap: spacing.md },
  title: { paddingBottom: spacing.xs },
  flush: { marginHorizontal: -spacing.lg },
  swatches: { flexDirection: 'row', gap: spacing.sm },
  swatch: { flex: 1, height: 28, borderRadius: 6, borderWidth: 1.5 },
});
