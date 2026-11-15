import { useProfile } from '../../lib/graphql/hooks';
import { UserAvatarToolbarActionView } from './UserAvatarToolbarActionView';
import { useUserDrawer } from './UserDrawerProvider';

export function UserAvatarToolbarAction({ variant }: { variant: 'glass' | 'material' }) {
  const { openUserDrawer } = useUserDrawer();
  const { data: profile } = useProfile();
  return (
    <UserAvatarToolbarActionView
      variant={variant}
      avatarName={profile?.displayName ?? profile?.email ?? null}
      avatarUrl={profile?.avatarUrl}
      onPress={openUserDrawer}
    />
  );
}
