import { useMemo } from 'react';
import { useNativeRootBarItems } from '../../hooks/use-native-root-bar-items';
import { useProfileShareOptions } from '../../hooks/use-profile-share-options';
import { useShareLinkAction } from '../../hooks/use-share-link-action';
import { useProfile } from '../../lib/graphql/hooks';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { createVariantComponent } from '../../theme/variants';
import { GlassActionToolbar } from '../chrome';
import { barItemsFactory, symbolBarItem } from '../chrome/root-bar-items';
import { ShareIconButton } from '../ShareIconButton';
import { useAccountRailItem, useBarItemsOnRail } from '../chrome/use-root-bar-items';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { ProfileTopChromeView, type ProfileTopChromeViewProps } from './ProfileTopChromeView';

export type { ProfileTabKey } from './ProfileTopChromeView';
export type ProfileTopChromeProps = Omit<
  ProfileTopChromeViewProps,
  'accountAction' | 'displayName' | 'leftItems' | 'rightItems' | 'shareAction'
>;

function useOwnProfileShare() {
  const { data: profile } = useProfile();
  const { data: privacy } = usePrivacySettings();
  const share = useProfileShareOptions({
    userId: profile?.id,
    displayName: profile?.displayName,
    isPrivate: privacy?.isPrivate,
  });
  return { profile, share };
}

export const ProfileTopChrome = createVariantComponent<ProfileTopChromeProps>('ProfileTopChrome', {
  material: ProfileTopChromeMaterial,
  liquidGlass: ProfileTopChromeGlass,
});
function ProfileTopChromeMaterial(props: ProfileTopChromeProps) {
  const { profile, share } = useOwnProfileShare();
  return (
    <ProfileTopChromeView
      {...props}
      displayName={profile?.displayName}
      accountAction={<UserAvatarToolbarAction variant="material" />}
      shareAction={share.url ? <ShareIconButton {...share} url={share.url} appearance="nativeHeader" /> : undefined}
    />
  );
}
function ProfileTopChromeGlass(props: ProfileTopChromeProps) {
  const { share } = useOwnProfileShare();
  const handleShare = useShareLinkAction(share);
  const nativeBarItems = useNativeRootBarItems();
  const onRail = useBarItemsOnRail();
  const accountItem = useAccountRailItem();
  const leftItems = useMemo(
    () => (nativeBarItems && onRail ? barItemsFactory([accountItem]) : undefined),
    [nativeBarItems, onRail, accountItem],
  );
  const rightItems = useMemo(
    () =>
      nativeBarItems && share.url
        ? barItemsFactory([
            symbolBarItem({
              label: share.accessibilityLabel,
              symbol: 'square.and.arrow.up',
              onPress: handleShare,
              identifier: 'root.shareProfile',
            }),
          ])
        : undefined,
    [nativeBarItems, share.url, share.accessibilityLabel, handleShare],
  );
  return (
    <ProfileTopChromeView
      {...props}
      leftItems={leftItems}
      rightItems={rightItems}
      shareAction={
        !nativeBarItems && share.url ? (
          <GlassActionToolbar actionCount={1}>
            <ShareIconButton {...share} url={share.url} />
          </GlassActionToolbar>
        ) : undefined
      }
      accountAction={
        <GlassActionToolbar actionCount={1}>
          <UserAvatarToolbarAction variant="glass" />
        </GlassActionToolbar>
      }
    />
  );
}
