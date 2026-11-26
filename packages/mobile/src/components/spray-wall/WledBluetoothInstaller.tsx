import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { normalizeLocalControllerUrl } from '@boardsesh/led-controller';
import {
  blocksHotspotUpdate,
  controllerName,
  createWledHotspotInstaller,
  createWledInstaller,
  CONTROLLER_NAME_BYTES,
  droppedFeaturesInUse,
  isHotspotError,
  sourceProfileFor,
  type InstallerSnapshot,
} from '../../lib/wled-installer/engine';
import type { HotspotCredentials, HotspotLink } from '../../lib/wled-installer/hotspot';
import { subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';
import { useTheme } from '../../providers/theme-provider';
import { BuilderTextInput, SectionLabel } from '../board-discovery/BoardMetaFields';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';

type InstallerSession = ReturnType<typeof createWledInstaller>;
type InstallMode = 'wifi' | 'hotspot';
// Mirrors WLED_HOTSPOT_SSID / WLED_HOTSPOT_DEFAULT_PASSWORD; hotspot.ts loads lazily with the native module.
const DEFAULT_HOTSPOT: HotspotCredentials = { ssid: 'WLED-AP', passphrase: 'wled1234' };
const BUSY_STAGES: InstallerSnapshot['stage'][] = [
  'inspecting',
  'backingUp',
  'downloading',
  'connecting',
  'uploading',
  'rebooting',
  'verifying',
];

/**
 * Rendered only in the wall owner's LED settings. No radio or LAN work occurs on mount.
 * With no Wi-Fi at the wall, the owner installs over the controller's own hotspot:
 * the firmware downloads first, then the phone joins WLED-AP for the upload and
 * leaves it again on success, failure, cancel, unmount and backgrounding.
 */
export function WledBluetoothInstaller({
  url,
  wallName,
  disabled,
  onInstalled,
}: {
  url: string;
  /** Suggested Bluetooth name; the owner can change it before installing. */
  wallName?: string;
  disabled: boolean;
  onInstalled?: (controllerId: string) => void;
}) {
  const { t } = useTranslation('boards');
  const { spacing, systemColors, brandColors } = useTheme();
  const [snapshot, setSnapshot] = useState<InstallerSnapshot>({ stage: 'idle' });
  const [mode, setMode] = useState<InstallMode>(url ? 'wifi' : 'hotspot');
  const [hotspot, setHotspot] = useState<HotspotCredentials>(DEFAULT_HOTSPOT);
  const [modelConfirmed, setModelConfirmed] = useState(false);
  // null until a backup is ready, then the owner's edit of the suggested name.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [droppedConfirmed, setDroppedConfirmed] = useState(false);
  // What the owner accepted losing at the install tap, repeated once the install completes.
  const [droppedAtInstall, setDroppedAtInstall] = useState<string[]>([]);
  const [audioDisabledConfirmed, setAudioDisabledConfirmed] = useState(false);
  const [betaConfirmed, setBetaConfirmed] = useState(false);
  const installer = useRef<InstallerSession | null>(null);
  const link = useRef<HotspotLink | null>(null);
  const active = useRef(true);
  const inspecting = useRef(false);
  const generation = useRef(0);
  const busy = BUSY_STAGES.includes(snapshot.stage);
  const hotspotMode = mode === 'hotspot';
  const web = Platform?.OS === 'web';

  function stopSession() {
    installer.current?.release();
    installer.current = null;
    link.current = null;
  }
  useEffect(() => {
    active.current = true;
    generation.current++;
    setSnapshot({ stage: 'idle' });
    setMode(url ? 'wifi' : 'hotspot');
    setModelConfirmed(false);
    setAudioDisabledConfirmed(false);
    setBetaConfirmed(false);
    stopSession();
    const unsubscribe = subscribeToCredentialChanges(() => {
      active.current = false;
      stopSession();
      setSnapshot({ stage: 'idle' });
    });
    return () => {
      active.current = false;
      installer.current?.release();
      unsubscribe();
    };
  }, [url]);
  useEffect(() => {
    if (!disabled) return;
    generation.current++;
    stopSession();
  }, [disabled]);
  useEffect(() => {
    // A binding left behind would cut the app off from the internet. Android
    // reports its own join prompt as backgrounding, so that one is let through.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'background' || !link.current || link.current.isJoining()) return;
      installer.current?.release();
    });
    return () => subscription.remove();
  }, []);

  async function inspect() {
    if (disabled || busy || inspecting.current || !active.current) return;
    inspecting.current = true;
    setModelConfirmed(false);
    setAudioDisabledConfirmed(false);
    setNameDraft(null);
    setDroppedConfirmed(false);
    setDroppedAtInstall([]);
    // The hotspot route downloads before it joins, so beta consent comes first there.
    if (!hotspotMode) setBetaConfirmed(false);
    const startedAt = generation.current;
    stopSession();
    try {
      const { nativeInstallerIO } = await import('../../lib/wled-installer/native');
      if (!active.current || startedAt !== generation.current) return;
      const publish = (next: InstallerSnapshot) => {
        if (!active.current || installer.current !== session) return;
        setSnapshot(next);
        if (next.stage === 'complete' && next.identity) onInstalled?.(next.identity.controllerId);
      };
      let session: InstallerSession;
      if (hotspotMode) {
        const { createNativeHotspotLink, hotspotInstallerIO } = await import('../../lib/wled-installer/hotspot');
        if (!active.current || startedAt !== generation.current) return;
        const hotspotLink = createNativeHotspotLink(hotspot, nativeInstallerIO);
        session = createWledHotspotInstaller(
          hotspotInstallerIO(nativeInstallerIO, hotspotLink.isJoined),
          hotspotLink,
          publish,
        );
        link.current = hotspotLink;
      } else {
        session = createWledInstaller(url, nativeInstallerIO, publish);
      }
      installer.current = session;
      await session.inspect(hotspotMode && betaConfirmed);
    } catch {
      if (active.current && startedAt === generation.current) setSnapshot({ stage: 'failed', error: 'unavailable' });
    } finally {
      inspecting.current = false;
    }
  }
  async function securitySettings() {
    try {
      await Linking.openURL(`${normalizeLocalControllerUrl(url)}/settings/sec`);
    } catch {
      setSnapshot({ ...snapshot, error: 'unavailable' });
    }
  }
  const hotspotErrorText = {
    hotspotNotFound: t('sprayLed.installer.hotspot.notFound', { ssid: hotspot.ssid }),
    hotspotDenied: t('sprayLed.installer.hotspot.denied'),
    hotspotTimeout: t('sprayLed.installer.hotspot.timeout'),
    hotspotPassword: t('sprayLed.installer.hotspot.password'),
    hotspotUnsupported: t('sprayLed.installer.hotspot.unsupported', { ssid: hotspot.ssid }),
    hotspotLost: t('sprayLed.installer.hotspot.lost'),
  };
  const hotspotMessage = isHotspotError(snapshot.error)
    ? hotspotErrorText[snapshot.error as keyof typeof hotspotErrorText]
    : null;
  const status = {
    idle: hotspotMode ? t('sprayLed.installer.hotspot.hint') : t('sprayLed.installer.hint'),
    inspecting: t('sprayLed.installer.inspecting'),
    blocked: hotspotMode
      ? t('sprayLed.installer.hotspot.locked', { ssid: hotspot.ssid })
      : t('sprayLed.installer.locked'),
    backingUp: t('sprayLed.installer.backingUp'),
    ready:
      snapshot.release?.channel === 'beta'
        ? t('sprayLed.installer.betaReady')
        : snapshot.release
          ? t('sprayLed.installer.ready')
          : t('sprayLed.installer.unqualified'),
    downloading: hotspotMode ? t('sprayLed.installer.hotspot.downloading') : t('sprayLed.installer.downloading'),
    connecting: t('sprayLed.installer.hotspot.connecting'),
    uploading:
      snapshot.progress == null
        ? t('sprayLed.installer.uploading')
        : t('sprayLed.installer.uploadProgress', { percent: Math.round(snapshot.progress * 100) }),
    rebooting: hotspotMode ? t('sprayLed.installer.hotspot.rebooting') : t('sprayLed.installer.rebooting'),
    verifying: t('sprayLed.installer.verifying'),
    complete: hotspotMode ? t('sprayLed.installer.hotspot.complete') : t('sprayLed.installer.complete'),
    interrupted: hotspotMessage ?? t('sprayLed.installer.interrupted'),
    failed:
      hotspotMessage ??
      (snapshot.error === 'checksum'
        ? t('sprayLed.installer.checksumFailed')
        : snapshot.error === 'preservation'
          ? t('sprayLed.installer.preservationFailed')
          : hotspotMode
            ? t('sprayLed.installer.hotspot.failed')
            : t('sprayLed.installer.failed')),
  }[snapshot.stage];
  const idleOrDone = !busy && !['ready', 'interrupted'].includes(snapshot.stage);
  const suggestedName = controllerName(wallName ?? '') || controllerName(snapshot.identity?.name ?? '');
  const nameInput = nameDraft ?? suggestedName;
  const advertisedName = controllerName(nameInput);
  const nameBytes = new TextEncoder().encode(advertisedName).length;
  const featureName = (feature: string) =>
    ({
      mqtt: t('sprayLed.installer.features.mqtt'),
      hue: t('sprayLed.installer.features.hue'),
      alexa: t('sprayLed.installer.features.alexa'),
      ir: t('sprayLed.installer.features.ir'),
      espnow: t('sprayLed.installer.features.espnow'),
    })[feature] ?? feature;
  const droppedFeatures =
    snapshot.stage === 'ready' && snapshot.backup && snapshot.release && snapshot.identity
      ? droppedFeaturesInUse(snapshot.backup.config, sourceProfileFor(snapshot.release, snapshot.identity))
      : [];
  const droppedNames = droppedFeatures.map(featureName).join(', ');
  const switchesSameSubnet =
    hotspotMode && snapshot.backup && snapshot.identity
      ? blocksHotspotUpdate(snapshot.backup.config, snapshot.identity.version)
      : false;
  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="headline">{t('sprayLed.installer.title')}</Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('sprayLed.installer.betaWarning')}
      </Text>
      {web ? null : (
        <SwitchRow
          label={t('sprayLed.installer.hotspot.toggle')}
          value={hotspotMode}
          // With no saved address, the hotspot is the only route.
          disabled={disabled || busy || !url}
          onValueChange={(enabled) => {
            stopSession();
            generation.current++;
            setSnapshot({ stage: 'idle' });
            setMode(enabled ? 'hotspot' : 'wifi');
          }}
        />
      )}
      <Text
        variant="footnote"
        color={snapshot.error ? brandColors.error : systemColors.secondaryLabel}
        accessibilityLiveRegion="polite"
      >
        {web ? t('sprayLed.installer.nativeOnly') : status}
      </Text>
      {hotspotMode && idleOrDone && snapshot.stage !== 'complete' && !web ? (
        <>
          <SectionLabel>{t('sprayLed.installer.hotspot.ssid')}</SectionLabel>
          <BuilderTextInput
            value={hotspot.ssid}
            onChangeText={(ssid) => setHotspot({ ...hotspot, ssid })}
            accessibilityLabel={t('sprayLed.installer.hotspot.ssid')}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={32}
            editable={!disabled}
          />
          <SectionLabel>{t('sprayLed.installer.hotspot.password')}</SectionLabel>
          <BuilderTextInput
            value={hotspot.passphrase}
            onChangeText={(passphrase) => setHotspot({ ...hotspot, passphrase })}
            accessibilityLabel={t('sprayLed.installer.hotspot.password')}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            maxLength={63}
            editable={!disabled}
          />
          <SwitchRow
            label={t('sprayLed.installer.confirmBeta')}
            value={betaConfirmed}
            onValueChange={setBetaConfirmed}
            disabled={disabled}
          />
        </>
      ) : null}
      {snapshot.stage === 'complete' && droppedAtInstall.length ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('sprayLed.installer.droppedFeaturesDone', { features: droppedAtInstall.map(featureName).join(', ') })}
        </Text>
      ) : null}
      {snapshot.error === 'preservation' && snapshot.differences?.length ? (
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {t('sprayLed.installer.differences', { paths: snapshot.differences.slice(0, 8).join(', ') })}
        </Text>
      ) : null}
      {snapshot.identity ? (
        <Text variant="caption1">
          {t('sprayLed.installer.identity', {
            name: snapshot.identity.name,
            version: snapshot.identity.version,
            count: snapshot.identity.ledCount,
          })}
        </Text>
      ) : null}
      <Button
        title={hotspotMode ? t('sprayLed.installer.hotspot.start') : t('sprayLed.installer.inspect')}
        variant="outlined"
        disabled={disabled || busy || web || (hotspotMode ? !hotspot.ssid.trim() || !betaConfirmed : !url)}
        onPress={() => {
          void inspect();
        }}
      />
      {snapshot.backup ? (
        <Button
          title={t('sprayLed.installer.exportBackup')}
          variant="text"
          disabled={disabled || busy}
          onPress={() => {
            void installer.current?.exportBackup().catch(() => setSnapshot({ ...snapshot, error: 'unavailable' }));
          }}
        />
      ) : null}
      {snapshot.stage === 'blocked' && !hotspotMode ? (
        <Button
          title={t('sprayLed.installer.securitySettings')}
          variant="text"
          disabled={disabled}
          onPress={() => {
            void securitySettings();
          }}
        />
      ) : null}
      {snapshot.stage === 'ready' && snapshot.release ? (
        <>
          <Text variant="footnote">{t('sprayLed.installer.backupHint')}</Text>
          <SectionLabel>{t('sprayLed.installer.controllerName')}</SectionLabel>
          <BuilderTextInput
            value={nameInput}
            onChangeText={setNameDraft}
            accessibilityLabel={t('sprayLed.installer.controllerName')}
            autoCorrect={false}
            maxLength={40}
            editable={!disabled}
          />
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('sprayLed.installer.controllerNameHint', { used: nameBytes, max: CONTROLLER_NAME_BYTES })}
          </Text>
          {switchesSameSubnet ? (
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('sprayLed.installer.hotspot.sameNetwork')}
            </Text>
          ) : null}
          {snapshot.release.channel === 'beta' ? (
            <SwitchRow
              label={t('sprayLed.installer.confirmBeta')}
              value={betaConfirmed}
              onValueChange={setBetaConfirmed}
              disabled={disabled}
            />
          ) : null}
          <SwitchRow
            label={t('sprayLed.installer.confirmModel')}
            value={modelConfirmed}
            onValueChange={setModelConfirmed}
            disabled={disabled}
          />
          {droppedFeatures.length ? (
            <>
              <Text variant="footnote" color={brandColors.error}>
                {t('sprayLed.installer.droppedFeatures', { features: droppedNames })}
              </Text>
              <SwitchRow
                label={t('sprayLed.installer.confirmDroppedFeatures', { features: droppedNames })}
                value={droppedConfirmed}
                onValueChange={setDroppedConfirmed}
                disabled={disabled}
              />
            </>
          ) : null}
          {!snapshot.release.audio ? (
            <SwitchRow
              label={t('sprayLed.installer.confirmNoAudio')}
              value={audioDisabledConfirmed}
              onValueChange={setAudioDisabledConfirmed}
              disabled={disabled}
            />
          ) : null}
          <Button
            title={
              snapshot.release.channel === 'beta'
                ? t('sprayLed.installer.installBeta')
                : t('sprayLed.installer.install')
            }
            disabled={
              disabled ||
              !modelConfirmed ||
              (!snapshot.release.audio && !audioDisabledConfirmed) ||
              (snapshot.release.channel === 'beta' && !betaConfirmed) ||
              (droppedFeatures.length > 0 && !droppedConfirmed)
            }
            onPress={() => {
              setDroppedAtInstall(droppedFeatures);
              void installer.current?.install(
                modelConfirmed,
                audioDisabledConfirmed,
                betaConfirmed,
                advertisedName,
                droppedConfirmed,
              );
            }}
          />
          {hotspotMode ? (
            <Button
              title={t('sprayLed.installer.hotspot.leave')}
              variant="text"
              onPress={() => {
                generation.current++;
                stopSession();
                setSnapshot({ stage: 'idle' });
              }}
            />
          ) : null}
        </>
      ) : null}
      {snapshot.stage === 'interrupted' ? (
        <Button
          title={t('sprayLed.installer.verify')}
          variant="outlined"
          disabled={disabled}
          onPress={() => {
            void installer.current?.verify();
          }}
        />
      ) : null}
      {busy ? (
        <Button title={t('sprayLed.installer.cancel')} variant="text" onPress={() => installer.current?.cancel()} />
      ) : null}
    </View>
  );
}
