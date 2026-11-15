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
export const BetaVideoCard = memo(function BetaVideoCard(
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
