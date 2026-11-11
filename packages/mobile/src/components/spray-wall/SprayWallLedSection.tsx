import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { sprayLedSetupHref } from '../../lib/spray/spray-routes';
import { getLedControllerDriver, LedControllerError, normalizeLocalControllerUrl } from '@boardsesh/led-controller';
import { useSprayLedPreviewForSettings } from '../../lib/spray/use-spray-led-preview';
import { useSprayWallLedSettings } from '../../lib/spray/use-spray-wall-led-settings';
import { useTheme } from '../../providers/theme-provider';
import { BuilderTextInput, SectionLabel } from '../board-discovery/BoardMetaFields';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';

type ProbeResult =
  | { kind: 'connected'; url: string; name: string; ledCount: number }
  | { kind: 'unavailable' | 'timeout' | 'notWled'; url: string }
  | { kind: 'invalidUrl' | 'notLocal'; url: null };

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
  useEffect(() => () => request.current?.abort(), [wallUuid]);
  useEffect(() => {
    if (disabled) cancelRequest();
  }, [disabled, cancelRequest]);

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

  async function confirmUrl() {
    if (locked || !settings?.enabled || request.current) return;
    let normalized: string;
    try {
      normalized = normalizeLocalControllerUrl(url);
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
