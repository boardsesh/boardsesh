import { StyleSheet, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { Avatar } from '../Avatar';
import { GlassToolbarAction, useToolbarActionCount, useToolbarActionSize } from '../chrome/GlassActionToolbar';
import { useUserDrawer } from './UserDrawerProvider';

// 34pt in a 44pt or larger slot. In UIKit's narrower native bar slot the face
// shrinks to stay 4pt inside each edge (30pt in 38pt).
const GLASS_AVATAR_SIZE = 34;
const GLASS_AVATAR_INSET = 8;
// M3 top app bar: a 32dp avatar in a 48dp target. Paper's IconButton pads the
// icon box by 8dp a side, so the icon size must match the avatar; the default
// 24dp box clips the avatar into a lopsided shape.
const MATERIAL_AVATAR_SIZE = 32;

type UserAvatarToolbarActionProps = {
  variant: 'glass' | 'material';
};

export function UserAvatarToolbarAction({ variant }: UserAvatarToolbarActionProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const actionSize = useToolbarActionSize();
  const actionCount = useToolbarActionCount();
  const { openUserDrawer } = useUserDrawer();
  const profileQuery = useProfile();
  const profile = profileQuery.data;
  const avatarName = profile?.displayName ?? profile?.email ?? null;
  const accessibilityLabel = t('ariaLabels.userMenu');

  if (variant === 'material') {
    return (
      <Appbar.Action
        icon={() => <Avatar uri={profile?.avatarUrl} name={avatarName} size={MATERIAL_AVATAR_SIZE} />}
        size={MATERIAL_AVATAR_SIZE}
        color={systemColors.label as string}
        onPress={openUserDrawer}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }

  return (
    <GlassToolbarAction onPress={openUserDrawer} accessibilityLabel={accessibilityLabel}>
      <View
        style={[
          styles.glassAvatarFrame,
          {
            width: actionSize,
            height: actionSize,
            borderColor: systemColors.separator,
            borderRightWidth: actionCount > 1 ? StyleSheet.hairlineWidth : 0,
          },
        ]}
      >
        <Avatar
          uri={profile?.avatarUrl}
          name={avatarName}
          size={Math.min(GLASS_AVATAR_SIZE, actionSize - GLASS_AVATAR_INSET)}
        />
      </View>
    </GlassToolbarAction>
  );
}

const styles = StyleSheet.create({
  glassAvatarFrame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
