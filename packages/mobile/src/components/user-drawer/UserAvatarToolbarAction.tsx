import { StyleSheet, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { Avatar } from '../Avatar';
import { GlassToolbarAction, useToolbarActionCount, useToolbarActionSize } from '../chrome/GlassActionToolbar';
import { useUserDrawer } from './UserDrawerProvider';

const GLASS_AVATAR_SIZE = 34;
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
        <Avatar uri={profile?.avatarUrl} name={avatarName} size={GLASS_AVATAR_SIZE} />
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
