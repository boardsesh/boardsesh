import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import NetInfo from '@react-native-community/netinfo';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { sprayLedSetupHref } from '../../lib/spray/spray-routes';
import {
  createWledDriver,
  DEFAULT_LED_BRIGHTNESS,
  discoverLedControllers,
  getLedControllerDriver,
  LedControllerError,
  normalizeLocalControllerUrl,
  SPRAY_WALL_LED_AUTO_OFF_CHOICES,
  wledScanHosts,
  type DiscoveredLedController,
} from '@boardsesh/led-controller';
import { useSprayLedPreviewForSettings } from '../../lib/spray/use-spray-led-preview';
import { useSprayWallLedSettings } from '../../lib/spray/use-spray-wall-led-settings';
import { useTheme } from '../../providers/theme-provider';
import { BuilderTextInput, SectionLabel } from '../board-discovery/BoardMetaFields';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { SwitchRow } from '../SwitchRow';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { ValueSlider } from '../ValueSlider';
import { WledBluetoothController } from './WledBluetoothController';
import { WledBluetoothInstaller } from './WledBluetoothInstaller';

// A short timeout per address: an empty address never answers, a WLED on the
// same Wi-Fi answers in well under a second. 254 addresses, 32 at a time.
const scanDriver = createWledDriver({ timeoutMs: 1500 });

type ScanState =
  | { kind: 'idle' }
  | { kind: 'noWifi' }
  // On Wi-Fi, but not a private IPv4 address the phone can sweep (IPv6 only, public, CGNAT or a VPN).
  | { kind: 'notSearchable' }
  | { kind: 'scanning'; checked: number; total: number; found: DiscoveredLedController[] }
  | { kind: 'done'; found: DiscoveredLedController[] };

const MIN_BRIGHTNESS_PERCENT = 5;
// The slider shows a percentage; WLED stores brightness as 1–255.
function brightnessPercent(brightness: number): number {
  return Math.max(MIN_BRIGHTNESS_PERCENT, Math.min(100, Math.round((brightness * 100) / 255 / 5) * 5));
}
function brightnessFromPercent(percent: number): number {
  return Math.max(1, Math.min(255, Math.round((percent * 255) / 100)));
}
// The three below run inside the slider's gesture, so they must be worklets.
function roundBrightnessPercent(raw: number): number {
  'worklet';
  return Math.max(MIN_BRIGHTNESS_PERCENT, Math.min(100, Math.round(raw / 5) * 5));
}
function brightnessNotch(percent: number): number {
  'worklet';
  return Math.round(percent / 25);
}
function adjustBrightnessPercent(percent: number, direction: 1 | -1): number {
  'worklet';
  return Math.max(MIN_BRIGHTNESS_PERCENT, Math.min(100, percent + direction * 5));
}
const foundKey = (found: DiscoveredLedController) => found.url;
/** One controller the search found; tapping it checks and saves its address. */
const FoundControllerRow = memo(function FoundControllerRow({
  found,
  disabled,
  onSelect,
}: {
  found: DiscoveredLedController;
  disabled: boolean;
  onSelect: (found: DiscoveredLedController) => void;
}) {
  const { t } = useTranslation('boards');
  return (
    <Button
      title={t('sprayLed.findResult', { name: found.name, address: found.url.replace('http://', '') })}
      variant="outlined"
      disabled={disabled}
      onPress={() => onSelect(found)}
    />
  );
});

type ProbeResult =
  | { kind: 'connected'; url: string; name: string; ledCount: number }
  | { kind: 'unavailable' | 'timeout' | 'notWled'; url: string }
  | { kind: 'invalidUrl' | 'notLocal'; url: null };

/** One surface and one controller, shared with setup and route lighting. */
export function SprayWallLedSection({
  wallUuid,
  disabled = false,
  canInstall = false,
}: {
  wallUuid: string;
  disabled?: boolean;
  canInstall?: boolean;
}) {
  return <SprayWallLedEditor key={wallUuid} wallUuid={wallUuid} disabled={disabled} canInstall={canInstall} />;
}

function SprayWallLedEditor({
  wallUuid,
  disabled,
  canInstall,
}: {
  wallUuid: string;
  disabled: boolean;
  canInstall: boolean;
}) {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { systemColors, brandColors, spacing } = useTheme();
  const { settings, loading, saving, error, reload, save } = useSprayWallLedSettings(wallUuid);
  const { lightAll, clear, stop } = useSprayLedPreviewForSettings(wallUuid, { settings, loading });
  const [expanded, setExpanded] = useState(false);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [pending, setPending] = useState<'probe' | 'lights' | null>(null);
  const [lighting, setLighting] = useState<'lit' | 'off' | 'failed' | null>(null);
  const request = useRef<AbortController | null>(null);
  // Refs guard double taps before React commits the pending state.
  const savingRef = useRef(false);
  const cancelRequest = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setPending(null);
    void stop();
  }, [stop]);
  const [scan, setScan] = useState<ScanState>({ kind: 'idle' });
  const scanRequest = useRef<AbortController | null>(null);
  const cancelScan = useCallback(() => {
    scanRequest.current?.abort();
    scanRequest.current = null;
    setScan((current) => (current.kind === 'scanning' ? { kind: 'idle' } : current));
  }, []);
  useEffect(
    () => () => {
      request.current?.abort();
      scanRequest.current?.abort();
    },
    [wallUuid],
  );
  useEffect(() => {
    if (disabled) {
      cancelRequest();
      cancelScan();
    }
  }, [disabled, cancelRequest, cancelScan]);

  const url = draftUrl ?? settings?.controller.url ?? '';
  const locked = disabled || loading || saving || savingRef.current || !settings;

  async function persistUrl(confirmedUrl: string): Promise<boolean> {
    if (!settings || savingRef.current) return false;
    savingRef.current = true;
    try {
      return await save({ ...settings, controller: { ...settings.controller, url: confirmedUrl } });
    } finally {
      savingRef.current = false;
    }
  }

  async function toggleEnabled(enabled: boolean) {
    if (locked || savingRef.current || !settings) return;
    cancelRequest();
    setResult(null);
    setLighting(null);
    savingRef.current = true;
    try {
      await save({ ...settings, enabled });
    } finally {
      savingRef.current = false;
    }
  }

  /** Brightness and auto-off save to the wall, so every phone lights it the same way. */
  async function saveLighting(update: { brightness?: number; autoOffMinutes?: number }) {
    if (locked || !settings || savingRef.current) return;
    savingRef.current = true;
    try {
      await save({ ...settings, ...update });
    } finally {
      savingRef.current = false;
    }
  }

  /** Probe every address on the phone's Wi-Fi (a private /24 only) and list the WLED controllers that answer. */
  async function findOnWifi() {
    if (locked || scanRequest.current || settings?.controller.type !== 'wled') return;
    // Claim the scan before reading the network: a second press, Stop, typing an
    // address, turning LEDs off or leaving the screen during the lookup all abort
    // this controller, and then no scan starts.
    const controller = new AbortController();
    scanRequest.current = controller;
    setScan({ kind: 'scanning', checked: 0, total: 0, found: [] });
    try {
      const network = await NetInfo.fetch().catch(() => null);
      if (controller.signal.aborted) return;
      const details = network?.type === 'wifi' ? network.details : null;
      const hosts = details?.ipAddress ? wledScanHosts(details.ipAddress, details.subnet) : [];
      if (!hosts.length) {
        setScan({ kind: network?.type === 'wifi' ? 'notSearchable' : 'noWifi' });
        return;
      }
      setScan({ kind: 'scanning', checked: 0, total: hosts.length, found: [] });
      const found = await discoverLedControllers(hosts, {
        probe: (candidate, signal) => scanDriver.probe(candidate, signal),
        signal: controller.signal,
        onProgress: (checked, total) =>
          setScan((current) => (current.kind === 'scanning' ? { ...current, checked, total } : current)),
        onFound: (entry) =>
          setScan((current) =>
            current.kind === 'scanning' ? { ...current, found: [...current.found, entry] } : current,
          ),
      });
      if (scanRequest.current === controller && !controller.signal.aborted) setScan({ kind: 'done', found });
    } catch {
      // Cancelled: the climber typed, left or turned LEDs off.
    } finally {
      if (scanRequest.current === controller) scanRequest.current = null;
    }
  }

  async function confirmUrl(candidate = url) {
    if (locked || !settings?.enabled || request.current || settings.controller.type !== 'wled') return;
    let normalized: string;
    try {
      normalized = normalizeLocalControllerUrl(candidate);
    } catch (urlError) {
      const notLocal = urlError instanceof LedControllerError && urlError.code === 'not-local';
      setResult({ kind: notLocal ? 'notLocal' : 'invalidUrl', url: null });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending('probe');
    setResult(null);
    setLighting(null);
    setDraftUrl(normalized);
    try {
      const info = await getLedControllerDriver(settings.controller.type).probe(normalized, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setResult({ kind: 'connected', url: normalized, name: info.name, ledCount: info.ledCount });
      await persistUrl(normalized);
    } catch (failure) {
      if (request.current !== controller || controller.signal.aborted) return;
      const kind =
        failure instanceof LedControllerError && failure.code === 'timeout'
          ? 'timeout'
          : failure instanceof LedControllerError && failure.code === 'not-wled'
            ? 'notWled'
            : 'unavailable';
      setResult({ kind, url: normalized });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  async function sendLights(on: boolean) {
    if (locked || !settings?.enabled || request.current || result?.kind !== 'connected') return;
    if (url !== result.url || settings.controller.url !== result.url) return;
    const controller = new AbortController();
    request.current = controller;
    setPending('lights');
    setLighting(null);
    try {
      const completed = await (on ? lightAll() : clear());
      if (request.current === controller && !controller.signal.aborted) {
        setLighting(completed ? (on ? 'lit' : 'off') : 'failed');
      }
    } catch {
      if (request.current === controller && !controller.signal.aborted) setLighting('failed');
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  // Through a ref, so the rows keep one callback while the scan reports progress.
  const chooseFoundRef = useRef<(found: DiscoveredLedController) => void>(() => undefined);
  chooseFoundRef.current = (found) => {
    cancelScan();
    setScan({ kind: 'idle' });
    setDraftUrl(found.url);
    void confirmUrl(found.url);
  };
  const chooseFound = useCallback((found: DiscoveredLedController) => chooseFoundRef.current(found), []);
  const foundDisabled = locked || pending !== null;
  const renderFound = useCallback(
    ({ item }: ListRenderItemInfo<DiscoveredLedController>) => (
      <FoundControllerRow found={item} disabled={foundDisabled} onSelect={chooseFound} />
    ),
    [foundDisabled, chooseFound],
  );

  const message =
    pending === 'probe'
      ? t('sprayLed.checking')
      : result?.kind === 'connected'
        ? t('sprayLed.connected', { name: result.name, count: result.ledCount })
        : result?.kind === 'invalidUrl'
          ? t('sprayLed.invalidUrl')
          : result?.kind === 'notLocal'
            ? t('sprayLed.notLocal')
            : result?.kind === 'notWled'
              ? t('sprayLed.notWled')
              : result?.kind === 'timeout'
                ? t('sprayLed.timeout')
                : result?.kind === 'unavailable'
                  ? t('sprayLed.unavailable')
                  : null;
  const canLight = result?.kind === 'connected' && settings?.controller.url === result.url && url === result.url;
  const canKeep = result?.url && result.kind !== 'connected' && settings?.controller.url !== result.url;

  return (
    <View>
      <PressableSurface
        onPress={() => {
          if (expanded) cancelRequest();
          setExpanded(!expanded);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('sprayLed.title')}
        accessibilityState={{ expanded }}
        style={[styles.header, { marginTop: spacing[5], paddingVertical: spacing[2] }]}
      >
        <Text variant="headline">{t('sprayLed.title')}</Text>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={18} color={systemColors.secondaryLabel} />
      </PressableSurface>
      {expanded ? (
        <View style={{ gap: spacing[2] }}>
          <SwitchRow
            label={t('sprayLed.enable')}
            value={settings?.enabled ?? false}
            disabled={locked}
            onValueChange={(enabled) => void toggleEnabled(enabled)}
          />
          {loading ? <Text variant="footnote">{t('sprayLed.loading')}</Text> : null}
          {error ? (
            <View accessibilityLiveRegion="polite">
              <Text variant="footnote" color={brandColors.error}>
                {error === 'load' ? t('sprayLed.loadFailed') : t('sprayLed.saveFailed')}
              </Text>
              <Button title={t('sprayLed.retry')} variant="text" onPress={reload} />
            </View>
          ) : null}
          {settings?.enabled ? (
            <>
              <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                <Button
                  title={t('sprayLed.bluetooth.wifi')}
                  variant="outlined"
                  disabled={locked || pending !== null || settings.controller.type === 'wled'}
                  onPress={() => {
                    cancelRequest();
                    cancelScan();
                    setResult(null);
                    setDraftUrl(null);
                    void save({ ...settings, controller: { type: 'wled', url: settings.wifiUrl ?? '' } });
                  }}
                />
                <Button
                  title={t('sprayLed.bluetooth.title')}
                  variant="outlined"
                  disabled={locked || pending !== null || settings.controller.type === 'wled-ble'}
                  onPress={() => {
                    cancelRequest();
                    cancelScan();
                    setResult(null);
                    setDraftUrl(null);
                    void save({
                      ...settings,
                      wifiUrl: settings.controller.url,
                      controller: { type: 'wled-ble', url: '' },
                    });
                  }}
                />
              </View>
              {settings.controller.type === 'wled-ble' ? (
                <WledBluetoothController
                  settings={settings}
                  disabled={locked}
                  save={save}
                  lightAll={lightAll}
                  clear={clear}
                />
              ) : (
                <>
                  <Text variant="footnote" color={systemColors.secondaryLabel}>
                    {t('sprayLed.localHint')}
                  </Text>
                  <SectionLabel>{t('sprayLed.url')}</SectionLabel>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <BuilderTextInput
                        value={url}
                        onChangeText={(next) => {
                          cancelRequest();
                          cancelScan();
                          setDraftUrl(next);
                          setResult(null);
                          setLighting(null);
                        }}
                        accessibilityLabel={t('sprayLed.url')}
                        placeholder={t('sprayLed.urlPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        maxLength={2048}
                        editable={!locked && pending !== 'lights'}
                        onSubmitEditing={() => void confirmUrl()}
                        returnKeyType="done"
                      />
                    </View>
                    <Button
                      title={t('sprayLed.confirm')}
                      variant="outlined"
                      disabled={locked || pending !== null || !url.trim()}
                      onPress={() => void confirmUrl()}
                    />
                  </View>
                  <Button
                    title={scan.kind === 'scanning' ? t('sprayLed.findStop') : t('sprayLed.find')}
                    variant="text"
                    disabled={locked || pending !== null}
                    onPress={() => (scan.kind === 'scanning' ? cancelScan() : void findOnWifi())}
                  />
                  {scan.kind === 'noWifi' || scan.kind === 'notSearchable' ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {scan.kind === 'noWifi' ? t('sprayLed.findNoWifi') : t('sprayLed.findNotSearchable')}
                    </Text>
                  ) : null}
                  {scan.kind === 'scanning' && scan.total > 0 ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.finding', { checked: scan.checked, total: scan.total })}
                    </Text>
                  ) : null}
                  {scan.kind === 'done' && !scan.found.length ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.findNone')}
                    </Text>
                  ) : null}
                  {(scan.kind === 'scanning' || scan.kind === 'done') && scan.found.length ? (
                    // A list of its own, as the Bluetooth picker has: never mapped inside the form's ScrollView.
                    <View style={{ height: 180 }}>
                      <FlashList data={scan.found} renderItem={renderFound} keyExtractor={foundKey} />
                    </View>
                  ) : null}
                  {message ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {message}
                    </Text>
                  ) : null}
                  {canKeep ? (
                    <Button
                      title={t('sprayLed.keepUrl')}
                      variant="text"
                      disabled={locked || pending !== null}
                      onPress={() => {
                        if (result?.url) void persistUrl(result.url);
                      }}
                    />
                  ) : null}
                  {settings.controller.url && settings.controller.url === url ? (
                    <Text variant="caption1" color={systemColors.secondaryLabel}>
                      {t('sprayLed.saved')}
                    </Text>
                  ) : null}
                  {canLight ? (
                    <>
                      <Button
                        title={t('sprayLed.lightAll')}
                        variant="outlined"
                        disabled={locked || pending !== null}
                        onPress={() => void sendLights(true)}
                      />
                      <Button
                        title={t('sprayLed.turnOff')}
                        variant="text"
                        disabled={locked || pending !== null}
                        onPress={() => void sendLights(false)}
                      />
                      <Text variant="caption1" color={systemColors.secondaryLabel}>
                        {t('sprayLed.lightHint')}
                      </Text>
                    </>
                  ) : null}
                  {pending === 'lights' || lighting ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {pending === 'lights'
                        ? t('sprayLed.sending')
                        : lighting === 'lit'
                          ? t('sprayLed.lit')
                          : lighting === 'off'
                            ? t('sprayLed.off')
                            : t('sprayLed.lightFailed')}
                    </Text>
                  ) : null}
                  {canInstall && !disabled && settings.controller.url ? (
                    <WledBluetoothInstaller url={settings.controller.url} disabled={locked || pending !== null} />
                  ) : null}
                </>
              )}
              <SectionLabel>{t('sprayLed.brightness')}</SectionLabel>
              <ValueSlider
                value={brightnessPercent(settings.brightness ?? DEFAULT_LED_BRIGHTNESS)}
                min={MIN_BRIGHTNESS_PERCENT}
                max={100}
                round={roundBrightnessPercent}
                notch={brightnessNotch}
                format={(percent) => t('sprayLed.brightnessValue', { percent })}
                accessibilityLabel={t('sprayLed.brightness')}
                adjust={adjustBrightnessPercent}
                disabled={locked}
                onLiveChange={() => undefined}
                onCommit={(percent) => void saveLighting({ brightness: brightnessFromPercent(percent) })}
              />
              <Text variant="caption1" color={systemColors.secondaryLabel}>
                {t('sprayLed.brightnessHint')}
              </Text>
              <SectionLabel>{t('sprayLed.autoOff')}</SectionLabel>
              <SegmentedControl
                options={SPRAY_WALL_LED_AUTO_OFF_CHOICES.map((minutes) => ({
                  key: String(minutes),
                  label: minutes ? t('sprayLed.autoOffMinutes', { minutes }) : t('sprayLed.autoOffNever'),
                }))}
                selectedKey={String(settings.autoOffMinutes)}
                onSelect={(key) => void saveLighting({ autoOffMinutes: Number(key) })}
                accessibilityLabel={t('sprayLed.autoOff')}
              />
              <Text variant="caption1" color={systemColors.secondaryLabel}>
                {t('sprayLed.autoOffHint')}
              </Text>
              {settings.controller.type === 'wled-ble' && settings.autoOffMinutes > 0 ? (
                <Text variant="caption1" color={systemColors.secondaryLabel}>
                  {t('sprayLed.autoOffBluetooth')}
                </Text>
              ) : null}
              <Button
                title={t('sprayLed.setup')}
                variant="outlined"
                onPress={() => {
                  cancelRequest();
                  router.push(sprayLedSetupHref(wallUuid));
                }}
                disabled={locked || pending !== null}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
});
