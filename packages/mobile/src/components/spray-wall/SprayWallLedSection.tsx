import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { sprayLedSetupHref } from '../../lib/spray/spray-routes';
import {
  bleControllerTarget,
  createWledDriver,
  DEFAULT_LED_BRIGHTNESS,
  discoverLedControllers,
  getLedControllerDriver,
  LedControllerError,
  normalizeLocalControllerUrl,
  wledScanHosts,
  type DiscoveredLedController,
  type LedControllerType,
} from '@boardsesh/led-controller';
import type { SprayLedBleCandidate } from '../../lib/spray/spray-led-ble-transport';
import { loadSprayLedBleTransport } from '../../lib/spray/spray-led-ble-transport-loader';
import { saveSprayWallBleDevice, useSprayWallBleDevice } from '../../lib/spray/spray-wall-led-ble-device';
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

// A short timeout per address: an empty address never answers, a WLED on the
// same Wi-Fi answers in well under a second. 254 addresses, 32 at a time.
const scanDriver = createWledDriver({ timeoutMs: 1500 });

type ScanState =
  | { kind: 'idle' }
  | { kind: 'noWifi' }
  | { kind: 'scanning'; checked: number; total: number; found: DiscoveredLedController[] }
  | { kind: 'done'; found: DiscoveredLedController[] };

const AUTO_OFF_CHOICES = [0, 15, 30, 60, 120] as const;
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

type BleScanState =
  | { kind: 'idle' }
  | { kind: 'unavailable' }
  | { kind: 'scanning' | 'done'; found: SprayLedBleCandidate[] };

type ProbeResult =
  | { kind: 'connected'; url: string; name: string; ledCount: number }
  | { kind: 'unavailable' | 'timeout' | 'notWled'; url: string }
  | { kind: 'invalidUrl' | 'notLocal'; url: null };

function probeFailureKind(failure: unknown): 'timeout' | 'notWled' | 'unavailable' {
  if (!(failure instanceof LedControllerError)) return 'unavailable';
  if (failure.code === 'timeout') return 'timeout';
  if (failure.code === 'not-wled') return 'notWled';
  return 'unavailable';
}

/** One surface and one controller, shared with setup and route lighting. */
export function SprayWallLedSection({ wallUuid, disabled = false }: { wallUuid: string; disabled?: boolean }) {
  return <SprayWallLedEditor key={wallUuid} wallUuid={wallUuid} disabled={disabled} />;
}

function SprayWallLedEditor({ wallUuid, disabled }: { wallUuid: string; disabled: boolean }) {
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
  const bleDevice = useSprayWallBleDevice(wallUuid).device;
  const [bleScan, setBleScan] = useState<BleScanState>({ kind: 'idle' });
  const stopBleScan = useRef<(() => void) | null>(null);
  const cancelBleScan = useCallback(() => {
    stopBleScan.current?.();
    stopBleScan.current = null;
    setBleScan((current) => (current.kind === 'scanning' ? { kind: 'idle' } : current));
  }, []);
  useEffect(
    () => () => {
      request.current?.abort();
      scanRequest.current?.abort();
      stopBleScan.current?.();
    },
    [wallUuid],
  );
  useEffect(() => {
    if (disabled) {
      cancelRequest();
      cancelScan();
      cancelBleScan();
    }
  }, [disabled, cancelRequest, cancelScan, cancelBleScan]);

  const bluetooth = settings?.controller.type === 'ble';
  const url = draftUrl ?? settings?.controller.url ?? '';
  // What the preview and route lighting contact: the Wi-Fi address, or this phone's controller.
  const target = bluetooth ? (bleDevice ? bleControllerTarget(bleDevice.id) : '') : url;
  const savedTarget = bluetooth ? target : (settings?.controller.url ?? '');
  const locked = disabled || loading || saving || savingRef.current || !settings;

  /** Wi-Fi or Bluetooth: saved to the wall, so every phone there knows how to reach it. */
  async function chooseControllerType(type: LedControllerType) {
    if (locked || !settings || savingRef.current || settings.controller.type === type) return;
    cancelRequest();
    cancelScan();
    cancelBleScan();
    setResult(null);
    setLighting(null);
    savingRef.current = true;
    try {
      await save({ ...settings, controller: { ...settings.controller, type } });
    } finally {
      savingRef.current = false;
    }
  }

  /** List the controllers advertising the Boardsesh LED service nearby. */
  function findBluetooth() {
    if (locked || stopBleScan.current) return;
    setBleScan({ kind: 'scanning', found: [] });
    // Holds the slot while the Bluetooth module loads; a stop before then cancels the scan.
    let cancelled = false;
    let stopScan: (() => void) | null = null;
    const stop = () => {
      cancelled = true;
      stopScan?.();
    };
    stopBleScan.current = stop;
    const finish = (outcome: 'done' | 'unavailable') => {
      if (stopBleScan.current !== stop) return;
      stopBleScan.current = null;
      setBleScan((current) =>
        outcome === 'unavailable'
          ? { kind: 'unavailable' }
          : { kind: 'done', found: current.kind === 'scanning' ? current.found : [] },
      );
    };
    void loadSprayLedBleTransport().then(
      ({ scanForSprayLedControllers }) => {
        if (cancelled) return;
        stopScan = scanForSprayLedControllers((found) => {
          if (stopBleScan.current === stop) setBleScan({ kind: 'scanning', found });
        }, finish);
      },
      () => finish('unavailable'),
    );
  }

  /** Check a Bluetooth controller answers, then keep it on this phone (never on the server). */
  async function confirmBluetooth(candidate: { id: string; name: string }) {
    if (locked || !settings?.enabled || request.current) return;
    const bleTarget = bleControllerTarget(candidate.id);
    const controller = new AbortController();
    request.current = controller;
    setPending('probe');
    setResult(null);
    setLighting(null);
    try {
      const info = await getLedControllerDriver('ble').probe(bleTarget, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      await saveSprayWallBleDevice(wallUuid, { id: candidate.id, name: info.name });
      if (request.current !== controller || controller.signal.aborted) return;
      setResult({ kind: 'connected', url: bleTarget, name: info.name, ledCount: info.ledCount });
    } catch (failure) {
      if (request.current !== controller || controller.signal.aborted) return;
      setResult({ kind: probeFailureKind(failure), url: bleTarget });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

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
    if (locked || scanRequest.current) return;
    const network = await NetInfo.fetch();
    const details = network.type === 'wifi' ? network.details : null;
    const hosts = details?.ipAddress ? wledScanHosts(details.ipAddress, details.subnet) : [];
    if (!hosts.length) {
      setScan({ kind: 'noWifi' });
      return;
    }
    const controller = new AbortController();
    scanRequest.current = controller;
    setScan({ kind: 'scanning', checked: 0, total: hosts.length, found: [] });
    try {
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
      if (scanRequest.current === controller) setScan({ kind: 'done', found });
    } catch {
      // Cancelled: the climber typed, left or turned LEDs off.
    } finally {
      if (scanRequest.current === controller) scanRequest.current = null;
    }
  }

  async function confirmUrl(candidate = url) {
    if (locked || !settings?.enabled || request.current) return;
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
      setResult({ kind: probeFailureKind(failure), url: normalized });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  async function sendLights(on: boolean) {
    if (locked || !settings?.enabled || request.current || result?.kind !== 'connected') return;
    if (target !== result.url || savedTarget !== result.url) return;
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

  const message =
    pending === 'probe'
      ? t('sprayLed.checking')
      : result?.kind === 'connected'
        ? bluetooth
          ? t('sprayLed.bleConnected', { name: result.name })
          : t('sprayLed.connected', { name: result.name, count: result.ledCount })
        : result?.kind === 'invalidUrl'
          ? t('sprayLed.invalidUrl')
          : result?.kind === 'notLocal'
            ? t('sprayLed.notLocal')
            : result?.kind === 'notWled'
              ? t(bluetooth ? 'sprayLed.bleNotController' : 'sprayLed.notWled')
              : result?.kind === 'timeout'
                ? t(bluetooth ? 'sprayLed.bleTimeout' : 'sprayLed.timeout')
                : result?.kind === 'unavailable'
                  ? t(bluetooth ? 'sprayLed.bleUnreachable' : 'sprayLed.unavailable')
                  : null;
  const canLight = result?.kind === 'connected' && savedTarget === result.url && target === result.url;
  const canKeep = !bluetooth && result?.url && result.kind !== 'connected' && settings?.controller.url !== result.url;

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
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('sprayLed.localHint')}
              </Text>
              <SectionLabel>{t('sprayLed.connection')}</SectionLabel>
              <SegmentedControl
                options={[
                  { key: 'wled', label: t('sprayLed.connectionWifi') },
                  { key: 'ble', label: t('sprayLed.connectionBluetooth') },
                ]}
                selectedKey={settings.controller.type}
                onSelect={(key) => void chooseControllerType(key as LedControllerType)}
                accessibilityLabel={t('sprayLed.connection')}
              />
              {bluetooth ? (
                <>
                  <Text variant="footnote" color={systemColors.secondaryLabel}>
                    {t('sprayLed.bleHint')}
                  </Text>
                  {bleDevice ? (
                    <>
                      <Text variant="caption1" color={systemColors.secondaryLabel}>
                        {t('sprayLed.bleSaved', { name: bleDevice.name })}
                      </Text>
                      <Button
                        title={t('sprayLed.bleCheck')}
                        variant="outlined"
                        disabled={locked || pending !== null}
                        onPress={() => void confirmBluetooth(bleDevice)}
                      />
                    </>
                  ) : null}
                  <Button
                    title={bleScan.kind === 'scanning' ? t('sprayLed.findStop') : t('sprayLed.bleFind')}
                    variant="text"
                    disabled={locked || pending !== null}
                    onPress={() => (bleScan.kind === 'scanning' ? cancelBleScan() : findBluetooth())}
                  />
                  {bleScan.kind === 'scanning' ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.bleFinding')}
                    </Text>
                  ) : null}
                  {bleScan.kind === 'unavailable' ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.bleUnavailable')}
                    </Text>
                  ) : null}
                  {bleScan.kind === 'done' && !bleScan.found.length ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.bleFindNone')}
                    </Text>
                  ) : null}
                  {bleScan.kind === 'scanning' || bleScan.kind === 'done'
                    ? bleScan.found.map((found) => (
                        <Button
                          key={found.id}
                          title={t('sprayLed.bleResult', { name: found.name })}
                          variant="outlined"
                          disabled={locked || pending !== null}
                          onPress={() => {
                            cancelBleScan();
                            setBleScan({ kind: 'idle' });
                            void confirmBluetooth(found);
                          }}
                        />
                      ))
                    : null}
                </>
              ) : null}
              {!bluetooth ? (
                <>
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
                  {scan.kind === 'noWifi' ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.findNoWifi')}
                    </Text>
                  ) : null}
                  {scan.kind === 'scanning' ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.finding', { checked: scan.checked, total: scan.total })}
                    </Text>
                  ) : null}
                  {scan.kind === 'done' && !scan.found.length ? (
                    <Text variant="footnote" accessibilityLiveRegion="polite">
                      {t('sprayLed.findNone')}
                    </Text>
                  ) : null}
                  {scan.kind === 'scanning' || scan.kind === 'done'
                    ? scan.found.map((found) => (
                        <Button
                          key={found.url}
                          title={t('sprayLed.findResult', {
                            name: found.name,
                            address: found.url.replace('http://', ''),
                          })}
                          variant="outlined"
                          disabled={locked || pending !== null}
                          onPress={() => {
                            cancelScan();
                            setScan({ kind: 'idle' });
                            setDraftUrl(found.url);
                            void confirmUrl(found.url);
                          }}
                        />
                      ))
                    : null}
                </>
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
              {!bluetooth && settings.controller.url && settings.controller.url === url ? (
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
              {bluetooth ? (
                // The Aurora frames carry no brightness or auto-off: the controller keeps its own.
                <Text variant="caption1" color={systemColors.secondaryLabel}>
                  {t('sprayLed.bleLightingHint')}
                </Text>
              ) : (
                <>
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
                    options={AUTO_OFF_CHOICES.map((minutes) => ({
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
                </>
              )}
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
