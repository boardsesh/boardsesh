import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { WEB_BASE_URL } from '../lib/env';
import { buildProfileOgImageUrl } from '../lib/share-prewarm';

type ProfileShareIdentity = {
  userId: string | undefined;
  displayName: string | null | undefined;
  isPrivate: boolean | undefined;
};

/** Only an explicitly public profile has a link with a public smart card. */
export function useProfileShareOptions({ userId, displayName, isPrivate }: ProfileShareIdentity) {
  const { t } = useTranslation('profile');
  return useMemo(
    () => ({
      url: userId && isPrivate === false ? `${WEB_BASE_URL}/profile/${encodeURIComponent(userId)}` : null,
      message: t('page.shareText', { name: displayName || t('page.displayNameFallback') }),
      accessibilityLabel: t('page.shareAriaLabel'),
      copiedMessage: t('page.linkCopied'),
      errorMessage: t('page.shareFailed'),
      prewarmOgImageUrl: userId && isPrivate === false ? buildProfileOgImageUrl(userId) : undefined,
    }),
    [userId, displayName, isPrivate, t],
  );
}
