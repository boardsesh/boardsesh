import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { WledBleCapabilities } from '@boardsesh/wled-ble-protocol';
import type { SprayWallLedSettings } from '../../lib/spray/spray-wall-led-cache';
import { Button } from '../Button';
import { Text } from '../Text';

const controllerKey = (controller: WledBleCapabilities) => controller.controllerId;
const ControllerRow = memo(function ControllerRow({
  controller,
  disabled,
  onSelect,
}: {
  controller: WledBleCapabilities;
  disabled: boolean;
  onSelect: (controller: WledBleCapabilities) => void;
}) {
  const { t } = useTranslation('boards');
  return (
    <Button
      title={t('sprayLed.bluetooth.pick', { name: controller.name, id: controller.controllerId })}
      variant="outlined"
      disabled={disabled}
      onPress={() => onSelect(controller)}
    />
  );
});

export function WledBluetoothController({
  settings,
  disabled,
  save,
  lightAll,
  clear,
}: {
  settings: SprayWallLedSettings;
  disabled: boolean;
  save: (next: SprayWallLedSettings) => Promise<boolean>;
  lightAll: () => Promise<boolean>;
  clear: () => Promise<boolean>;
}) {
  const { t } = useTranslation('boards');
  const [controllers, setControllers] = useState<WledBleCapabilities[]>([]);
  const [status, setStatus] = useState<'idle' | 'scanning' | 'empty' | 'saved' | 'failed' | 'lit' | 'off'>('idle');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (disabled) request.current?.abort();
  }, [disabled]);
  const select = useCallback(
    (controller: WledBleCapabilities) => {
      if (disabled || request.current) return;
      const operation = new AbortController();
      request.current = operation;
      void save({ ...settings, controller: { type: 'wled-ble', url: `wled-ble:${controller.controllerId}` } })
        .then((saved) => {
          if (!operation.signal.aborted) setStatus(saved ? 'saved' : 'failed');
        })
        .finally(() => {
          if (request.current === operation) request.current = null;
        });
    },
    [disabled, save, settings],
  );
  const renderController = useCallback(
    ({ item }: ListRenderItemInfo<WledBleCapabilities>) => (
      <ControllerRow controller={item} disabled={disabled || status === 'scanning'} onSelect={select} />
    ),
    [disabled, status, select],
  );
  async function scan() {
    if (disabled || request.current) return;
    const operation = new AbortController();
    request.current = operation;
    setStatus('scanning');
    setControllers([]);
    try {
      const found = await (await import('../../lib/spray/wled-ble-native')).discoverWledBluetooth(operation.signal);
      if (operation.signal.aborted) return;
      setControllers(found);
      setStatus(found.length ? 'idle' : 'empty');
    } catch {
      if (!operation.signal.aborted) setStatus('failed');
    } finally {
      if (request.current === operation) request.current = null;
    }
  }
  async function lighting(on: boolean) {
    if (disabled || request.current) return;
    const operation = new AbortController();
    request.current = operation;
    try {
      const completed = await (on ? lightAll() : clear());
      if (!operation.signal.aborted) setStatus(completed ? (on ? 'lit' : 'off') : 'failed');
    } finally {
      if (request.current === operation) request.current = null;
    }
  }
  return (
    <View>
      <Text variant="footnote">{t('sprayLed.bluetooth.hint')}</Text>
      <Button
        title={t('sprayLed.bluetooth.find')}
        variant="outlined"
        disabled={disabled || status === 'scanning'}
        onPress={() => void scan()}
      />
      {status === 'scanning' ? (
        <Button
          title={t('sprayLed.bluetooth.cancel')}
          variant="text"
          onPress={() => {
            request.current?.abort();
            request.current = null;
            setStatus('idle');
          }}
        />
      ) : null}
      {status === 'empty' ? <Text variant="footnote">{t('sprayLed.bluetooth.empty')}</Text> : null}
      {status === 'failed' ? <Text variant="footnote">{t('sprayLed.bluetooth.failed')}</Text> : null}
      {status === 'saved' ? <Text variant="footnote">{t('sprayLed.bluetooth.saved')}</Text> : null}
      {controllers.length ? (
        <View style={{ height: 180 }}>
          <FlashList data={controllers} renderItem={renderController} keyExtractor={controllerKey} />
        </View>
      ) : null}
      {settings.controller.url ? (
        <>
          <Text variant="caption1">{settings.controller.url.slice('wled-ble:'.length)}</Text>
          <Button
            title={t('sprayLed.lightAll')}
            variant="outlined"
            disabled={disabled || status === 'scanning'}
            onPress={() => void lighting(true)}
          />
          <Button
            title={t('sprayLed.turnOff')}
            variant="text"
            disabled={disabled || status === 'scanning'}
            onPress={() => void lighting(false)}
          />
        </>
      ) : null}
      {status === 'lit' ? (
        <Text variant="footnote">{t('sprayLed.lit')}</Text>
      ) : status === 'off' ? (
        <Text variant="footnote">{t('sprayLed.off')}</Text>
      ) : null}
    </View>
  );
}
