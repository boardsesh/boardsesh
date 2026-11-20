import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { WEB_BASE_URL } from '../../lib/env';
import { buildPlaceOgImageUrl } from '../../lib/share-prewarm';
import { ShareIconButton } from '../ShareIconButton';

/** The expanded public gym's heading shares its browser page. */
export const GymShareButton = memo(function GymShareButton({ gym }: { gym: Pick<Gym, 'name' | 'slug' | 'isPublic'> }) {
  const { t } = useTranslation('boards');
  if (!gym.isPublic || !gym.slug) return null;
  return (
    <ShareIconButton
      appearance="nativeHeader"
      url={`${WEB_BASE_URL}/gym/${encodeURIComponent(gym.slug)}`}
      message={t('mobile.gyms.shareText', { name: gym.name })}
      accessibilityLabel={t('mobile.gyms.shareAriaLabel', { name: gym.name })}
      copiedMessage={t('mobile.gyms.linkCopied')}
      errorMessage={t('mobile.gyms.shareFailed')}
      prewarmOgImageUrl={buildPlaceOgImageUrl('gym', gym.slug)}
    />
  );
});
