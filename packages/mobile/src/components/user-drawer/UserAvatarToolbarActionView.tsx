import { selectByVariant } from '../../theme/variants';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { Avatar } from '../Avatar';
import { GlassToolbarAction, useToolbarActionCount, useToolbarActionSize } from '../chrome/GlassActionToolbar';

// 34pt in a 44pt or larger slot. In UIKit's narrower native bar slot the face
// shrinks to stay 4pt inside each edge (30pt in 38pt).
const GLASS_AVATAR_SIZE = 34;
const GLASS_AVATAR_INSET = 8;
// M3 top app bar: a 32dp avatar in a 48dp target. Paper's IconButton pads the
// icon box by 8dp a side, so the icon size must match the avatar; the default
// 24dp box clips the avatar into a lopsided shape.
const MATERIAL_AVATAR_SIZE = 32;

const uiVariantByAppearance = { glass: 'liquidGlass', material: 'material' } as const;

export type UserAvatarToolbarActionViewProps = {
  variant: 'glass' | 'material';
  avatarName: string | null;
  avatarUrl?: string | null;
  onPress: () => void;
};

export function UserAvatarToolbarActionView({
  variant,
  avatarName,
  avatarUrl,
  onPress,
}: UserAvatarToolbarActionViewProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const actionSize = useToolbarActionSize();
  const actionCount = useToolbarActionCount();
  const accessibilityLabel = t('ariaLabels.userMenu');

  return selectByVariant(uiVariantByAppearance[variant], {
    material: (
      <Appbar.Action
        icon={() => <Avatar uri={avatarUrl} name={avatarName} size={MATERIAL_AVATAR_SIZE} />}
        size={MATERIAL_AVATAR_SIZE}
        color={systemColors.label as string}
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
      />
    ),
    liquidGlass: (
      <GlassToolbarAction onPress={onPress} accessibilityLabel={accessibilityLabel}>
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
            uri={avatarUrl}
            name={avatarName}
            size={Math.min(GLASS_AVATAR_SIZE, actionSize - GLASS_AVATAR_INSET)}
          />
        </View>
      </GlassToolbarAction>
    ),
  });
}

const styles = StyleSheet.create({
  glassAvatarFrame: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
