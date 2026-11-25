import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '../Card';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import {
  shouldOfferLocationAsk,
  snoozeLocationAsk,
  trackLocationAskAnswered,
  trackLocationAskShown,
  useLocationAskSnoozed,
  type LocationAskSurface,
} from '../../lib/location-ask';
import type { LocationPermission, LocationRequest } from '../../lib/use-device-location';

export type LocationAskCardProps = {
  /** Which screen it sits on, for the events. */
  surface: LocationAskSurface;
  /** The permission as the screen's `useDeviceLocation` last read it. */
  permission: LocationPermission;
  /**
   * Shows the system prompt: the location hook's `request`. The card reports
   * the answer from its `onAnswer`, as soon as the prompt closes, not after
   * the fix.
   */
  onAllow: LocationRequest;
  /**
   * Reads the permission again without asking: the location hook's
   * `requestIfAllowed`. Runs when the climber comes back from Settings, so a
   * grant there gets them their gyms with no second tap.
   */
  onRecheck: () => Promise<LocationPermission>;
  /**
   * Around the card, drawn only with it: a screen's gutter, so a hidden card
   * leaves no padding (or list gap) behind.
   */
  style?: StyleProp<ViewStyle>;
};

/**
 * "See boards near you" in the picker (whose Near you lists boards), "See
 * gyms near you" on the gym map: the one way any screen asks for location
 * again. It says what location gets the climber, and that search works
 * without it.
 *
 * - Allow shows the system prompt while it can still ask. Once only Settings
 *   can turn location on (iOS after one no, Android "Don't ask again"), Allow
 *   opens Settings, and the permission is read again when the app comes back.
 *   In a browser, where nothing can open its settings, the line says where to
 *   turn it on and only Not now is offered.
 * - Not now hides it on every surface for 14 days (`lib/location-ask.ts`).
 * - Hidden while location is allowed, before the permission is read, and
 *   while a Not now holds.
 */
export function LocationAskCard({ surface, permission, onAllow, onRecheck, style }: LocationAskCardProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const snoozed = useLocationAskSnoozed();
  const visible = shouldOfferLocationAsk(permission, snoozed);
  const askablePermission = permission === 'ask' || permission === 'blocked' ? permission : null;

  // Once per card on screen, as it first shows.
  const shownTracked = useRef(false);
  useEffect(() => {
    if (!visible || shownTracked.current || askablePermission === null) return;
    shownTracked.current = true;
    trackLocationAskShown(surface, askablePermission);
  }, [visible, askablePermission, surface]);

  // Set by Allow while blocked: the climber is in Settings. The next return to
  // the foreground reads the permission again and reports what they chose.
  const [awaitingSettings, setAwaitingSettings] = useState(false);
  // The system prompt is up: a second tap would send a second, stale answer.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!awaitingSettings) return undefined;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      setAwaitingSettings(false);
      void onRecheck().then((permissionAfter) => {
        trackLocationAskAnswered(surface, 'open_settings', permissionAfter);
      });
    });
    return () => subscription.remove();
  }, [awaitingSettings, onRecheck, surface]);

  if (!visible) return null;

  const settingsOnly = permission === 'blocked';
  const canAllow = !settingsOnly || canOpenAppSettings();

  const onPressAllow = () => {
    if (asking) return;
    if (settingsOnly) {
      setAwaitingSettings(true);
      void openAppSettings();
      return;
    }
    setAsking(true);
    void onAllow({
      onAnswer: (permissionAfter) => {
        setAsking(false);
        trackLocationAskAnswered(surface, 'allow', permissionAfter);
      },
    });
  };

  const onPressNotNow = () => {
    snoozeLocationAsk();
    trackLocationAskAnswered(surface, 'not_now', permission);
  };

  return (
    <View style={style} testID="location-ask-card">
      <Card>
        <View style={styles.stack}>
          <View style={styles.copy}>
            <Text variant="headline">
              {surface === 'board_picker' ? t('mobile.locationAsk.titleBoards') : t('mobile.locationAsk.titleGyms')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {canAllow ? t('mobile.locationAsk.body') : t('mobile.locationAsk.browserBody')}
            </Text>
          </View>
          <View style={styles.buttonRow}>
            {canAllow ? (
              <Button
                title={settingsOnly ? t('mobile.locationAsk.openSettings') : t('mobile.locationAsk.allow')}
                size="small"
                variant="tonal"
                icon="location"
                disabled={asking}
                onPress={onPressAllow}
              />
            ) : null}
            <Button title={t('mobile.locationAsk.notNow')} size="small" variant="text" onPress={onPressNotNow} />
          </View>
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: spacing[3],
  },
  copy: {
    gap: spacing[1],
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
