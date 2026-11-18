import { Redirect } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button } from '../../Button';
import type { SecondaryButtonLook } from '../../Button.types';
import { Card } from '../../Card';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { useDeveloperSettingsAccess } from './use-developer-settings-access';

// Settings › Developer › Button pairs (#7695): the filled button beside each
// candidate secondary look, on the real native controls, so the pair can be
// judged on a phone and screenshotted. Labels are English on purpose, like the
// other developer screens. Goes away once a look is picked.

type Candidate = { key: string; title: string; note: string; look: SecondaryButtonLook | undefined };

const CANDIDATES: readonly Candidate[] = [
  // i18n-ignore-next-line — developer-only screen
  { key: 'current', title: 'Current', note: 'Today: outline or Liquid Glass with violet text', look: undefined },
  {
    key: 'neutralTonal',
    // i18n-ignore-next-line — developer-only screen
    title: 'A · Neutral tonal',
    // i18n-ignore-next-line — developer-only screen
    note: 'A neutral tonal fill with label-coloured text',
    look: 'neutralTonal',
  },
  {
    key: 'neutralOutline',
    // i18n-ignore-next-line — developer-only screen
    title: 'B · Neutral outline',
    // i18n-ignore-next-line — developer-only screen
    note: 'The same outline or glass capsule, with label-coloured text',
    look: 'neutralOutline',
  },
];

const noop = () => {};

function CandidatePairs({ candidate }: { candidate: Candidate }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.candidate} testID={`button-pairs-${candidate.key}`}>
      <Text variant="headline" color={systemColors.label}>
        {candidate.title}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {candidate.note}
      </Text>
      {/* The Home Session card's live state (#7689): two equal buttons in a card. */}
      <Card>
        <View style={styles.cardBody}>
          {/* i18n-ignore-next-line — developer-only screen */}
          <Text variant="body" color={systemColors.label}>
            Anna is climbing · Kilter, 40°
          </Text>
          <View style={styles.row}>
            {/* i18n-ignore-next-line — developer-only screen */}
            <Button title="Join Anna" variant="filled" onPress={noop} style={styles.equal} />
            <Button
              // i18n-ignore-next-line — developer-only screen
              title="Start my own"
              variant="outlined"
              secondaryLook={candidate.look}
              onPress={noop}
              style={styles.equal}
            />
          </View>
        </View>
      </Card>
      {/* On the screen background, stacked, and the explicit tonal tier. */}
      <View style={styles.stack}>
        {/* i18n-ignore-next-line — developer-only screen */}
        <Button title="Start a session" variant="filled" onPress={noop} style={styles.full} />
        <Button
          // i18n-ignore-next-line — developer-only screen
          title="Build a workout"
          variant="outlined"
          secondaryLook={candidate.look}
          onPress={noop}
          style={styles.full}
        />
        <View style={styles.row}>
          <Button
            // i18n-ignore-next-line — developer-only screen
            title="Tonal tier"
            variant="tonal"
            secondaryLook={candidate.look}
            size="small"
            onPress={noop}
          />
          <Button
            // i18n-ignore-next-line — developer-only screen
            title="Disabled"
            variant="outlined"
            secondaryLook={candidate.look}
            size="small"
            disabled
            onPress={noop}
          />
        </View>
      </View>
    </View>
  );
}

export function ButtonPairsScreen() {
  const { systemColors } = useTheme();
  const { allowed, loading } = useDeveloperSettingsAccess();
  if (!allowed && !loading) return <Redirect href="/settings" />;
  return (
    <ScrollView
      style={{ backgroundColor: systemColors.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      testID="button-pairs-screen"
    >
      {CANDIDATES.map((candidate) => (
        <CandidatePairs key={candidate.key} candidate={candidate} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing[4],
    gap: spacing[8],
  },
  candidate: {
    gap: spacing[3],
  },
  cardBody: {
    gap: spacing[3],
  },
  row: {
    flexDirection: 'row',
    gap: spacing[3],
  },
  equal: {
    flex: 1,
  },
  stack: {
    gap: spacing[3],
  },
  full: {
    width: '100%',
  },
});
