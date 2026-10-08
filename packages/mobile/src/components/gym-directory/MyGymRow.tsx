import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Gym } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

/** The four role labels a gym row can show, resolved by the screen (i18n lives there). */
export type MyGymRoleLabels = {
  owner: string;
  admin: string;
  editor: string;
  member: string;
};

type MyGymRowProps = {
  gym: Gym;
  /** The signed-in user's id — an `ownerId` match wins the "Owner" badge. */
  currentUserId?: string;
  roleLabels: MyGymRoleLabels;
  manageLabel: string;
  manageAccessibilityLabel: string;
  noAddressLabel: string;
  /** Open the gym editor (only wired when `gym.canEdit`). */
  onOpenGym: (gym: Gym) => void;
  /** Hand off to the web kiosk/TV manage console (only wired when `gym.canEdit`). */
  onManageKiosks: (gym: Gym) => void;
};

// Owner beats any membership role: an owner is always the owner even if they also
// hold an editor/admin membership row. Falls back to the membership role, then to
// no badge (the query currently returns only owned gyms, but the badge is built to
// survive the backend broadening to co-run gyms).
function resolveRoleLabel(gym: Gym, currentUserId: string | undefined, labels: MyGymRoleLabels): string | null {
  if (currentUserId && gym.ownerId === currentUserId) return labels.owner;
  switch (gym.myRole) {
    case 'admin':
      return labels.admin;
    case 'editor':
      return labels.editor;
    case 'member':
      return labels.member;
    default:
      return null;
  }
}

function MyGymRowComponent({
  gym,
  currentUserId,
  roleLabels,
  manageLabel,
  manageAccessibilityLabel,
  noAddressLabel,
  onOpenGym,
  onManageKiosks,
}: MyGymRowProps) {
  const { systemColors, brandColors } = useTheme();

  const isOwner = !!currentUserId && gym.ownerId === currentUserId;
  const roleLabel = resolveRoleLabel(gym, currentUserId, roleLabels);
  const addressLine = gym.address?.trim() ? gym.address.trim() : noAddressLabel;

  const handleOpen = useCallback(() => onOpenGym(gym), [onOpenGym, gym]);
  const handleManage = useCallback(() => onManageKiosks(gym), [onManageKiosks, gym]);

  // The name / address / badge block. It's the edit tap target when the viewer can
  // edit; otherwise it's a plain detail block (no-op tap).
  const summary = (
    <View style={styles.summary}>
      <View style={styles.summaryText}>
        <Text variant="headline" numberOfLines={1}>
          {gym.name}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.address}>
          {addressLine}
        </Text>
      </View>
      {roleLabel ? (
        <View style={[styles.badge, { backgroundColor: isOwner ? brandColors.primary : systemColors.fill }]}>
          <Text variant="caption1" color={isOwner ? brandColors.onPrimary : systemColors.secondaryLabel}>
            {roleLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      {gym.canEdit ? (
        <PressableSurface
          onPress={handleOpen}
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={gym.name}
        >
          {summary}
        </PressableSurface>
      ) : (
        <View>{summary}</View>
      )}

      {gym.canEdit ? (
        <>
          <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
          {/* Kiosk/TV management is web-only by design — this is a hand-off to the
              browser console, not an in-app screen. */}
          <PressableSurface
            onPress={handleManage}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={manageAccessibilityLabel}
            style={styles.manageRow}
          >
            <Icon name="tv" size={18} color={systemColors.secondaryLabel} />
            <Text variant="subheadline" color={systemColors.label} style={styles.manageLabel} numberOfLines={1}>
              {manageLabel}
            </Text>
            <Icon name="open.external" size={16} color={systemColors.tertiaryLabel} />
          </PressableSurface>
        </>
      ) : null}
    </View>
  );
}

/** Memoized so a My-gyms list re-render doesn't re-render every settled row. */
export const MyGymRow = memo(MyGymRowComponent);

const styles = StyleSheet.create({
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 60,
  },
  summaryText: {
    flex: 1,
  },
  address: {
    marginTop: spacing[1],
  },
  badge: {
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginStart: spacing[4],
  },
  manageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 48,
  },
  manageLabel: {
    flex: 1,
  },
});
