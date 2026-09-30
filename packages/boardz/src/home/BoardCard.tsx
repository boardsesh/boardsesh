import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { angleOptions, describeBoard, type ActiveBoard } from '../board/active-board';
import { useBoard } from '../board/board-provider';
import { useBluetooth } from '../ble/bluetooth-provider';
import { Button } from '../ui/Button';
import { Section } from '../ui/Card';
import { Bluetooth } from '../ui/icons';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Stepper } from '../ui/Stepper';
import { Text } from '../ui/Text';
import { spacing } from '../ui/tokens';

// A control strip fits a MoonBoard's two angles; Aurora boards go 0–70° in fives.
const MAX_ANGLE_CELLS = 5;

/** The active board: what it is, its angle, and the Bluetooth link. */
export function BoardCard({ board }: { board: ActiveBoard }) {
  const { setAngle } = useBoard();
  const bluetooth = useBluetooth();
  const angles = angleOptions(board.boardName);
  const description = describeBoard(board);

  return (
    <Section
      title="Board"
      right={<Button title="Change" variant="ghost" size="sm" onPress={() => router.push('/board-setup')} />}
    >
      <View style={styles.name}>
        <Text variant="title3" numberOfLines={1}>
          {board.name}
        </Text>
        {description ? (
          <Text variant="mono" tone="tertiary" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      {angles.length <= MAX_ANGLE_CELLS ? (
        <SegmentedControl
          fullWidth
          size="lg"
          value={board.angle}
          onChange={setAngle}
          options={angles.map((angle) => ({
            value: angle,
            label: `${angle}°`,
            accessibilityLabel: `${angle} degrees`,
          }))}
        />
      ) : (
        <Stepper
          label="Wall angle"
          showLabel
          value={angles.indexOf(board.angle)}
          min={0}
          max={angles.length - 1}
          onChange={(index) => setAngle(angles[index])}
          format={(index) => `${angles[index] ?? board.angle}°`}
        />
      )}
      {bluetooth.status === 'connected' ? (
        <Button title="Disconnect" variant="secondary" fullWidth onPress={() => void bluetooth.disconnect()} />
      ) : (
        <Button
          title={bluetooth.status === 'connecting' ? 'Connecting…' : 'Connect board'}
          variant="secondary"
          icon={Bluetooth}
          fullWidth
          disabled={bluetooth.status === 'connecting'}
          onPress={() => router.push('/connect')}
        />
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  name: { gap: spacing.xs },
});
