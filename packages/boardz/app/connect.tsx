import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { useBluetooth } from '../src/ble/bluetooth-provider';
import { useBoard } from '../src/board/board-provider';
import { Button } from '../src/ui/Button';
import { Icon } from '../src/ui/Icon';
import { Bluetooth, BluetoothConnected, RefreshCw } from '../src/ui/icons';
import { LedDot } from '../src/ui/LedDot';
import { Text } from '../src/ui/Text';
import { Sheet } from '../src/ui/Sheet';
import { LED, useTheme } from '../src/ui/theme';
import { spacing } from '../src/ui/tokens';

function signal(rssi: number): string {
  if (rssi >= -60) return 'Strong';
  if (rssi >= -75) return 'Good';
  return 'Weak';
}

export default function ConnectSheet() {
  const theme = useTheme();
  const { board } = useBoard();
  const bluetooth = useBluetooth();
  const { status, startScan, stopScan } = bluetooth;
  const brand = board ? formatBoardDisplayName(board.boardName) : 'board';
  const connected = status === 'connected';

  // Scan once when the sheet opens (unless already connected) and stop when it closes.
  // Later searches are the climber's choice, from the button below.
  useEffect(() => {
    if (status === 'disconnected') void startScan();
    return () => stopScan();
  }, []);

  // Close once a connection made here comes up, so the climber lands back where
  // they were. Opened while already connected, it stays: that's where Disconnect is.
  const previousStatus = useRef(status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;
    if (status !== 'connected' || was === 'connected') return;
    const timer = setTimeout(() => router.back(), 600);
    return () => clearTimeout(timer);
  }, [status]);

  const rowStyle = [styles.row, { borderBottomColor: theme.border1 }];

  return (
    <Sheet title={connected ? 'Your board' : 'Connect a board'} gap={14}>
      <Text variant="small" tone="tertiary">
        {connected
          ? 'Connected and ready to light.'
          : `Switch your ${brand} on and stand close. Bluetooth does the rest.`}
      </Text>

      <View style={[styles.list, { borderTopColor: theme.border2 }]}>
        {connected ? (
          <View style={rowStyle}>
            <Icon icon={BluetoothConnected} color={theme.fg1} />
            <View style={styles.copy}>
              <Text variant="bodyStrong">{bluetooth.deviceName ?? `Your ${brand}`}</Text>
              <Text variant="label">Connected</Text>
            </View>
            <Button title="Disconnect" variant="secondary" size="sm" onPress={() => void bluetooth.disconnect()} />
          </View>
        ) : null}

        {status === 'connecting' ? (
          <View style={rowStyle}>
            <LedDot color={LED.blue} pulse size={7} />
            <Text variant="label" tone="secondary">
              Pairing
            </Text>
          </View>
        ) : null}

        {status === 'disconnected'
          ? bluetooth.devices.map((device) => (
              <View key={device.id} style={rowStyle}>
                <Icon icon={Bluetooth} color={theme.fg3} />
                <View style={styles.copy}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {device.name ?? `Unnamed ${brand}`}
                  </Text>
                  <Text variant="label" style={styles.meta}>
                    {device.id.slice(0, 8)} · Signal {signal(device.rssi)}
                  </Text>
                </View>
                <Button
                  title="Connect"
                  variant={device.rssi < -75 ? 'secondary' : 'primary'}
                  size="sm"
                  onPress={() => void bluetooth.connect(device)}
                />
              </View>
            ))
          : null}

        {status === 'disconnected' && bluetooth.scanning ? (
          <View style={rowStyle}>
            <LedDot color={LED.blue} pulse size={7} />
            <Text variant="label" tone="secondary">
              Looking for boards nearby
            </Text>
          </View>
        ) : null}

        {status === 'disconnected' && !bluetooth.scanning && bluetooth.devices.length === 0 ? (
          <View style={rowStyle}>
            <Text variant="small" tone="tertiary" style={styles.copy}>
              Nothing nearby.
            </Text>
          </View>
        ) : null}
      </View>

      {status === 'disconnected' && !bluetooth.scanning ? (
        <Button title="Search again" variant="secondary" icon={RefreshCw} fullWidth onPress={() => void startScan()} />
      ) : null}

      {bluetooth.problem ? (
        <Text variant="small" tone="danger" accessibilityRole="alert">
          {bluetooth.problem}
        </Text>
      ) : null}

      <Text variant="caption" tone="tertiary">
        Only one phone can light the board at a time, so disconnect other apps first.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { borderTopWidth: 1 },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: 1 },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  meta: { letterSpacing: 0.4 },
});
