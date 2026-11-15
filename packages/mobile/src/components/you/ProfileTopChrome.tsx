import { useMemo } from 'react';
import { useNativeRootBarItems } from '../../hooks/use-native-root-bar-items';
import { useProfile } from '../../lib/graphql/hooks';
import { createVariantComponent } from '../../theme/variants';
import { GlassActionToolbar } from '../chrome';
import { barItemsFactory } from '../chrome/root-bar-items';
import { useAccountRailItem, useBarItemsOnRail } from '../chrome/use-root-bar-items';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { ProfileTopChromeView, type ProfileTopChromeViewProps } from './ProfileTopChromeView';

export type { ProfileTabKey } from './ProfileTopChromeView';
export type ProfileTopChromeProps = Omit<ProfileTopChromeViewProps, 'accountAction' | 'displayName' | 'leftItems'>;

export const ProfileTopChrome = createVariantComponent<ProfileTopChromeProps>('ProfileTopChrome', {
  material: ProfileTopChromeMaterial,
  liquidGlass: ProfileTopChromeGlass,
});
function ProfileTopChromeMaterial(props: ProfileTopChromeProps) {
  const { data: profile } = useProfile();
  return (
    <ProfileTopChromeView
      {...props}
      displayName={profile?.displayName}
      accountAction={<UserAvatarToolbarAction variant="material" />}
    />
  );
}
function ProfileTopChromeGlass(props: ProfileTopChromeProps) {
  const nativeBarItems = useNativeRootBarItems();
  const onRail = useBarItemsOnRail();
  const accountItem = useAccountRailItem();
  const leftItems = useMemo(
    () => (nativeBarItems && onRail ? barItemsFactory([accountItem]) : undefined),
    [nativeBarItems, onRail, accountItem],
  );
  return (
    <ProfileTopChromeView
      {...props}
      leftItems={leftItems}
      accountAction={
        <GlassActionToolbar actionCount={1}>
          <UserAvatarToolbarAction variant="glass" />
        </GlassActionToolbar>
      }
    />
  );
}
