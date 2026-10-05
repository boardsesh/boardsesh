import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { track } from '../../lib/analytics';
import { getFirstConnectSnapshot } from '../../lib/onboarding/first-connect-store';
import {
  claimSavedClimbNoticeShow,
  ensureSaveNextSessionLoaded,
} from '../../lib/save-next-session/save-next-session-store';
import { useSaveNextSessionEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { borderRadius, shadowColor, spacing } from '../../theme/tokens';

const NOTICE_DURATION_MS = 4000;
/** Where the prompt sits, for the day a second surface shows one. */
const SAVE_PROMPT_SOURCE = 'play_drawer_heart';

type NoticeState = { kind: 'saved'; connected: boolean; nonce: number } | { kind: 'error'; nonce: number } | null;

export type SavedClimbNoticeHandle = {
  /**
   * A heart was just added. Shows "Saved · View" when the feature is on and
   * this phone has shows left; otherwise clears whatever was up.
   */
  showSaved: (connected: boolean) => void;
  /**
   * The heart did not stick. Returns false when the feature is off, so the
   * caller can fall back to the toast it used before.
   */
  showError: () => boolean;
  /** The heart was removed: a "Saved" line would now be wrong. */
  hide: () => void;
};

type SavedClimbNoticeProps = {
  /** The climb on screen. The notice is about that climb, so it leaves with it. */
  climbUuid: string;
  /** "View": leave the player for the liked list. */
  onView: () => void;
};

/**
 * The play drawer's own line of feedback for the heart (#6002): "Saved for your
 * next session · View" after an add, and the "couldn't update" line when the
 * write fails.
 *
 * It lives INSIDE the drawer because `/play` is a root transparent modal and the
 * root toast overlay renders behind it (see the comment in toast-provider.tsx).
 * It overlays the bottom of the board art, so it takes no layout and never
 * covers the action bar, the commit bar or the connect pill below.
 *
 * Driven through a ref, not props: the drawer is a heavy component, and a
 * notice that appears and times out must not re-render it twice per heart.
 */
const SavedClimbNoticeComponent = forwardRef<SavedClimbNoticeHandle, SavedClimbNoticeProps>(function SavedClimbNotice(
  { climbUuid, onView },
  ref,
) {
  const { t } = useTranslation('session');
  const { variant, systemColors, brandColors, m3SurfaceContainers } = useTheme();
  const enabled = useSaveNextSessionEnabled();
  const [notice, setNotice] = useState<NoticeState>(null);
  const nonceRef = useRef(0);

  // The cap is read synchronously in the tap handler, so have it in memory
  // before the first heart.
  useEffect(() => {
    ensureSaveNextSessionLoaded();
  }, []);

  // A notice about the previous climb must not ride onto the next one.
  useEffect(() => {
    setNotice(null);
  }, [climbUuid]);

  // The kill switch landing mid-notice takes the "Saved" line down with it.
  useEffect(() => {
    if (!enabled) setNotice(null);
  }, [enabled]);

  const noticeNonce = notice?.nonce;
  useEffect(() => {
    if (noticeNonce === undefined) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [noticeNonce]);

  useImperativeHandle(
    ref,
    () => ({
      showSaved: (connected: boolean) => {
        if (!enabled || !claimSavedClimbNoticeShow()) {
          setNotice(null);
          return;
        }
        nonceRef.current += 1;
        setNotice({ kind: 'saved', connected, nonce: nonceRef.current });
        const device = getFirstConnectSnapshot().device;
        track(SHARED_EVENTS.SavePromptShown, {
          source: SAVE_PROMPT_SOURCE,
          connected,
          phone_has_connected: device ? device.connectedAt !== null : null,
        });
      },
      showError: () => {
        if (!enabled) return false;
        nonceRef.current += 1;
        setNotice({ kind: 'error', nonce: nonceRef.current });
        return true;
      },
      hide: () => setNotice(null),
    }),
    [enabled],
  );

  const savedConnected = notice?.kind === 'saved' ? notice.connected : null;
  const handleView = useCallback(() => {
    if (savedConnected === null) return;
    track(SHARED_EVENTS.SavePromptTapped, { source: SAVE_PROMPT_SOURCE, connected: savedConnected });
    setNotice(null);
    onView();
  }, [savedConnected, onView]);

  const surface = selectByVariant(variant, {
    liquidGlass: systemColors.secondaryBackground,
    material: m3SurfaceContainers.high,
  });
  let message = '';
  if (notice?.kind === 'error') message = t('playView.favoriteError');
  else if (notice?.kind === 'saved') {
    message = notice.connected ? t('mobile.savedNotice.saved') : t('mobile.savedNotice.savedForNextSession');
  }

  // The anchor stays mounted so the pill's exit animation has a parent to run in.
  return (
    <View pointerEvents="box-none" style={styles.anchor}>
      {notice ? (
        <Animated.View
          key={notice.nonce}
          entering={FadeInDown.duration(220)}
          exiting={FadeOutDown.duration(180)}
          style={[styles.notice, { backgroundColor: surface }]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Text variant="subheadline" color={systemColors.label} style={styles.message} numberOfLines={2}>
            {message}
          </Text>
          {notice.kind === 'saved' ? (
            <Pressable
              onPress={handleView}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.savedNotice.viewAria')}
            >
              <Text variant="subheadline" color={brandColors.primary} style={styles.view}>
                {t('mobile.savedNotice.view')}
              </Text>
            </Pressable>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
});

export const SavedClimbNotice = memo(SavedClimbNoticeComponent);

const styles = StyleSheet.create({
  // Pinned to the bottom edge of the board section it is rendered in.
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing[2],
    zIndex: 3,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.lg,
    shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  message: {
    flexShrink: 1,
  },
  view: {
    fontWeight: '700',
  },
});
