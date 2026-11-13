import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { normalizeLocalControllerUrl } from '@boardsesh/led-controller';
import { createWledInstaller, type InstallerSnapshot } from '../../lib/wled-installer/engine';
import { subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';
import { useTheme } from '../../providers/theme-provider';
import { Button } from '../Button';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';

/** Rendered only in the wall owner's LED settings. No radio or LAN work occurs on mount. */
export function WledBluetoothInstaller({
  url,
  disabled,
  onInstalled,
}: {
  url: string;
  disabled: boolean;
  onInstalled?: (controllerId: string) => void;
}) {
  const { t } = useTranslation('boards');
  const { spacing, systemColors, brandColors } = useTheme();
  const [snapshot, setSnapshot] = useState<InstallerSnapshot>({ stage: 'idle' });
  const [modelConfirmed, setModelConfirmed] = useState(false);
  const [audioDisabledConfirmed, setAudioDisabledConfirmed] = useState(false);
  const installer = useRef<ReturnType<typeof createWledInstaller> | null>(null);
  const active = useRef(true);
  const inspecting = useRef(false);
  const generation = useRef(0);
  const busy = ['inspecting', 'backingUp', 'downloading', 'uploading', 'rebooting', 'verifying'].includes(
    snapshot.stage,
  );
  useEffect(() => {
    active.current = true;
    generation.current++;
    setSnapshot({ stage: 'idle' });
    setModelConfirmed(false);
    setAudioDisabledConfirmed(false);
    installer.current?.cancel();
    installer.current = null;
    const unsubscribe = subscribeToCredentialChanges(() => {
      active.current = false;
      installer.current?.cancel();
      installer.current = null;
      setSnapshot({ stage: 'idle' });
    });
    return () => {
      active.current = false;
      installer.current?.cancel();
      unsubscribe();
    };
  }, [url]);
  useEffect(() => {
    if (!disabled) return;
    generation.current++;
    installer.current?.cancel();
    installer.current = null;
  }, [disabled]);

  async function inspect() {
    if (disabled || busy || inspecting.current || !active.current) return;
    inspecting.current = true;
    const startedAt = generation.current;
    try {
      const { nativeInstallerIO } = await import('../../lib/wled-installer/native');
      if (!active.current || startedAt !== generation.current) return;
      const session = createWledInstaller(url, nativeInstallerIO, (next) => {
        if (!active.current || installer.current !== session) return;
        setSnapshot(next);
        if (next.stage === 'complete' && next.identity) onInstalled?.(next.identity.controllerId);
      });
      installer.current = session;
      await session.inspect();
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
  const status = {
    idle: t('sprayLed.installer.hint'),
    inspecting: t('sprayLed.installer.inspecting'),
    blocked: t('sprayLed.installer.locked'),
    backingUp: t('sprayLed.installer.backingUp'),
    ready: snapshot.release ? t('sprayLed.installer.ready') : t('sprayLed.installer.unqualified'),
    downloading: t('sprayLed.installer.downloading'),
    uploading:
      snapshot.progress == null
        ? t('sprayLed.installer.uploading')
        : t('sprayLed.installer.uploadProgress', { percent: Math.round(snapshot.progress * 100) }),
    rebooting: t('sprayLed.installer.rebooting'),
    verifying: t('sprayLed.installer.verifying'),
    complete: t('sprayLed.installer.complete'),
    interrupted: t('sprayLed.installer.interrupted'),
    failed:
      snapshot.error === 'checksum'
        ? t('sprayLed.installer.checksumFailed')
        : snapshot.error === 'preservation'
          ? t('sprayLed.installer.preservationFailed')
          : t('sprayLed.installer.failed'),
  }[snapshot.stage];
  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="headline">{t('sprayLed.installer.title')}</Text>
      <Text
        variant="footnote"
        color={snapshot.error ? brandColors.error : systemColors.secondaryLabel}
        accessibilityLiveRegion="polite"
      >
        {Platform?.OS === 'web' ? t('sprayLed.installer.nativeOnly') : status}
      </Text>
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
        title={t('sprayLed.installer.inspect')}
        variant="outlined"
        disabled={disabled || busy || Platform?.OS === 'web' || !url}
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
      {snapshot.stage === 'blocked' ? (
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
          <SwitchRow
            label={t('sprayLed.installer.confirmModel')}
            value={modelConfirmed}
            onValueChange={setModelConfirmed}
            disabled={disabled}
          />
          {!snapshot.release.audio ? (
            <SwitchRow
              label={t('sprayLed.installer.confirmNoAudio')}
              value={audioDisabledConfirmed}
              onValueChange={setAudioDisabledConfirmed}
              disabled={disabled}
            />
          ) : null}
          <Button
            title={t('sprayLed.installer.install')}
            disabled={disabled || !modelConfirmed || (!snapshot.release.audio && !audioDisabledConfirmed)}
            onPress={() => {
              void installer.current?.install(modelConfirmed, audioDisabledConfirmed);
            }}
          />
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
