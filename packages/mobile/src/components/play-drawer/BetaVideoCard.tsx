import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
import type { BetaReaderOwner } from '../../lib/graphql/hooks/use-beta-links';
import type { ToastGuard } from '../Toast';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { isBetaVideoUrl } from '@boardsesh/shared-schema';
import * as Haptics from 'expo-haptics';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '../../lib/analytics';
import { openValidatedUrl } from '../../lib/open-external-link';
import { useToast } from '../../providers/toast-provider';
import { BetaVideoCardView, detectPlatform, type BetaVideoCardViewProps } from './BetaVideoCardView';
export {
  BETA_CARD_COMPACT_HEIGHT,
  BETA_CARD_COMPACT_WIDTH,
  BETA_CARD_HEIGHT,
  BETA_CARD_WIDTH,
} from './BetaVideoCardView';
const NativeBetaVideoCard = memo(function NativeBetaVideoCard(
  props: Omit<BetaVideoCardViewProps, 'onPress' | 'onImageDisplayed' | 'onImageError'>,
) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const { link } = props;
  const onPress = useCallback(async () => {
    void Haptics.selectionAsync();
    track(SHARED_EVENTS.BetaVideoLinkClicked, {
      climbUuid: link.climb_uuid,
      platform: detectPlatform(link.link)?.name ?? null,
    });
    if (!(await openValidatedUrl(link.link, isBetaVideoUrl))) showToast(t('mobile.betaVideos.openError'), 'error');
  }, [link.climb_uuid, link.link, showToast, t]);
  return <BetaVideoCardView {...props} onPress={onPress} />;
});

type BetaVideoProps = Omit<BetaVideoCardViewProps, 'onPress' | 'onImageDisplayed' | 'onImageError'> & {
  originalOwner?: BetaReaderOwner;
};
export const BetaVideoCard = memo(function BetaVideoCard(props: BetaVideoProps) {
  return props.originalOwner ? (
    <OwnedBetaVideoCard {...props} originalOwner={props.originalOwner} />
  ) : (
    <NativeBetaVideoCard {...props} />
  );
});
function OwnedBetaVideoCard({ originalOwner, ...props }: BetaVideoProps & { originalOwner: BetaReaderOwner }) {
  const { t } = useTranslation('session');
  const { showGuardedToast } = useToast();
  const actions = useHttpActionScope();
  const { link } = props;
  const onPress = useCallback(async () => {
    let action: ReturnType<typeof actions.capture> | undefined;
    let transferred = false;
    try {
      originalOwner.assertCurrent();
      action = actions.capture();
      const originalAction = action;
      const assertCurrent = () => {
        originalOwner.assertCurrent();
        originalAction.assertView();
      };
      assertCurrent();
      void Haptics.selectionAsync();
      assertCurrent();
      track(SHARED_EVENTS.BetaVideoLinkClicked, {
        climbUuid: link.climb_uuid,
        platform: detectPlatform(link.link)?.name ?? null,
      });
      assertCurrent();
      const opened = await openValidatedUrl(link.link, isBetaVideoUrl);
      assertCurrent();
      if (!opened) {
        let active = true;
        const guard: ToastGuard = Object.freeze({
          assertCurrent() {
            if (!active) throw new BrowserBackendConsumerError('superseded');
            assertCurrent();
          },
          subscribe(listener: () => void) {
            const releaseOwner = originalOwner.subscribe(listener);
            originalAction.signal.addEventListener('abort', listener);
            return () => {
              releaseOwner();
              originalAction.signal.removeEventListener('abort', listener);
            };
          },
          release() {
            if (!active) return;
            active = false;
            originalAction.finish();
          },
        });
        try {
          showGuardedToast(t('mobile.betaVideos.openError'), 'error', guard);
          transferred = true;
        } catch {
          guard.release();
        }
      }
    } catch {
      /* Retired local action. */
    } finally {
      if (!transferred) action?.finish();
    }
  }, [actions, originalOwner, link.climb_uuid, link.link, showGuardedToast, t]);
  try {
    originalOwner.assertCurrent();
  } catch {
    return null;
  }
  return <BetaVideoCardView {...props} onPress={onPress} />;
}
