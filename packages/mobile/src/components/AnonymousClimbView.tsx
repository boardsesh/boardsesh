// The read-only climb view a signed-out visitor gets on app.boardsesh.com.
//
// www links every indexed climb page into this app at the same path. Until now
// that arrival hit a login form — 209 characters of body copy where the SEO
// funnel was supposed to end — because the board routes are redirectors: they
// adopt the URL's board (a write that needs an account) and hand off to the
// Climbs tab plus the `/play` modal.
//
// Neither half was necessary to DRAW the climb. Every render input is in the
// URL: the tuple carries the whole board config, board art is a local catalogue
// lookup, and the `climb` resolver takes no viewer at all. So this screen skips
// adoption and, crucially, skips the navigation: `PlayDrawer` renders here in
// its existing `presentation="pane"` mode, in place, on the canonical
// `/…/{angle}/view/{segment}` URL.
//
// Staying put is not a style choice. `/(tabs)/climbs` and `/play` are both
// outside the anonymous allow-set, and `AuthProvider` re-reads
// `window.location.pathname` on every navigation — so a hand-off would bounce
// the visitor back to the login wall the moment the drawer opened. Anything
// added here that navigates off the allow-set does the same thing silently; see
// `PlayDrawerActionBar`'s `viewer` prop for the affordances that were removed
// for exactly that reason.
//
// Native never renders this. The whole anonymous branch sits behind
// `RELAXES_ANONYMOUS_ROUTES`, whose native fork is a literal `false`.

import { memo, useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Climb } from '@boardsesh/shared-schema';
import { PlayDrawer } from './play-drawer/PlayDrawer';
import { Button } from './Button';
import { Text } from './Text';
import { climbToQueueItem } from '../lib/climb-to-queue-item';
import { buildLoginHrefWithReturn } from '../lib/routing/anonymous-auth-gate';
import { useTheme } from '../providers/theme-provider';
import type { BoardConfig } from '../providers/drawer-host-provider';
import { spacing } from '../theme/tokens';

/** Nothing to open: the queue button is hidden for an anonymous viewer. */
function noop() {}

export const AnonymousClimbView = memo(function AnonymousClimbView({
  climb,
  boardConfig,
}: {
  climb: Climb;
  boardConfig: BoardConfig;
}) {
  const { t } = useTranslation('session');
  const router = useRouter();
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  // The angle pill stays live, and the drawer's board config is the only thing
  // it moves — exactly what the signed-in deep-link path does, where an angle
  // change rewrites `boardConfigOverride` and leaves the climb object alone.
  // The URL is not rewritten for the same reason it is not there either.
  const [angle, setAngle] = useState(boardConfig.angle);

  // Bumped alongside the angle so the open target re-applies. PlayDrawer clears
  // its preview item on every angle change and then re-reads `openTarget`
  // (whose effect is declared after that one, so it wins in the same commit) —
  // without a fresh nonce the anonymous drawer would fall back to the queue's
  // current climb, which is empty here, and blank itself.
  const [openNonce, setOpenNonce] = useState(1);
  const handleAngleChange = useCallback((nextAngle: number) => {
    // Both writes are conditional on the angle actually moving. Re-opening the
    // drawer for an angle it is already on would rebuild the preview item for
    // nothing.
    setAngle((currentAngle) => {
      if (currentAngle === nextAngle) return currentAngle;
      setOpenNonce((nonce) => nonce + 1);
      return nextAngle;
    });
  }, []);

  const paneBoardConfig = useMemo<BoardConfig>(() => ({ ...boardConfig, angle }), [boardConfig, angle]);

  // `previewQueueItem` is what keeps the queue untouched: with it set, the
  // drawer renders the climb without dispatching `setCurrentClimb`. The deep
  // link already opens this way for a signed-in visitor.
  const openTarget = useMemo(
    () => ({ climb, options: { previewQueueItem: climbToQueueItem(climb) }, nonce: openNonce }),
    [climb, openNonce],
  );

  // Always the builder, never a hand-rolled `/auth/login`: it validates the
  // current path against the same allow-set the gate produced it from and
  // encodes it as `?next=`, which is what brings the visitor back to THIS climb
  // instead of Home once they sign in.
  const handleSignIn = useCallback(() => {
    router.push(buildLoginHrefWithReturn());
  }, [router]);

  return (
    <View style={[styles.root, { backgroundColor: systemColors.secondaryBackground }]}>
      {/* Headerless, like the redirector it replaces: these routes mount at the
          root stack, and a back chevron here would point at nothing. */}
      <Stack.Screen options={{ headerShown: false }} />
      <PlayDrawer
        presentation="pane"
        viewer="anonymous"
        boardConfig={paneBoardConfig}
        onAngleChange={handleAngleChange}
        onOpenQueue={noop}
        openTarget={openTarget}
        onSignIn={handleSignIn}
      />
      {/* The standing invitation, below the drawer rather than over it: the
          board art and the below-fold reads are the reason someone followed the
          link, and covering them to ask for an account is how a read-only view
          ends up feeling worse than the wall it replaced. */}
      <View
        style={[
          styles.signInBar,
          { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] },
        ]}
      >
        <View style={styles.signInCopy}>
          <Text variant="subheadline" style={styles.signInHeadline}>
            {t('mobile.anonymous.signInHeadline')}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.anonymous.signInSubtitle')}
          </Text>
        </View>
        <Button title={t('mobile.anonymous.signInAction')} onPress={handleSignIn} variant="filled" />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  signInBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  signInCopy: {
    flex: 1,
    gap: spacing[1],
  },
  signInHeadline: {
    fontWeight: '600',
  },
});
