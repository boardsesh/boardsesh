import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { topBarFor } from '../../theme/top-bar';
import { spacing } from '../../theme/tokens';
import { AppMenu, type AppMenuAction } from '../AppMenu';
import { GymShareButton } from '../gym-directory/GymShareButton';
import { useToggleGymFollow } from './use-gym-page-data';

type MenuEntry = { action: AppMenuAction; run: () => void };

type GymPageHeaderActionsProps = {
  gym: Pick<Gym, 'uuid' | 'name' | 'slug' | 'isPublic'>;
  isFollowing: boolean;
  /** Following needs an account; signed out, the row logs in first. */
  canFollow: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onSignIn: () => void;
  /** Report a problem, once the report sheet is wired (`useGymReportAction`). Absent hides the row. */
  onReport?: () => void;
};

/**
 * The gym page's trailing header items: the gym's share button (public gyms
 * with a page on the website) and a ⋯ menu with Follow or Unfollow, Edit gym
 * details for anyone who can edit it, and Report a problem for everyone else.
 * One element for `useHeaderActions`' accessory slot, so on iOS 26 both sit in
 * one custom bar item.
 */
export const GymPageHeaderActions = memo(function GymPageHeaderActions({
  gym,
  isFollowing,
  canFollow,
  canEdit,
  onEdit,
  onSignIn,
  onReport,
}: GymPageHeaderActionsProps) {
  const { t } = useTranslation('boards');
  const { variant } = useTheme();
  const { showToast } = useToast();
  const toggleFollow = useToggleGymFollow();
  const toggleFollowMutate = toggleFollow.mutate;
  const followPending = toggleFollow.isPending;

  const onToggleFollow = useCallback(() => {
    if (!canFollow) {
      onSignIn();
      return;
    }
    if (followPending) return;
    hapticSelection();
    toggleFollowMutate(
      { gymUuid: gym.uuid, follow: !isFollowing },
      { onError: () => showToast(t('mobile.gymPage.followError'), 'error') },
    );
  }, [canFollow, onSignIn, followPending, toggleFollowMutate, gym.uuid, isFollowing, showToast, t]);

  const entries = useMemo<MenuEntry[]>(() => {
    const list: MenuEntry[] = [
      {
        action: {
          label: isFollowing ? t('mobile.gymPage.unfollow') : t('mobile.gymPage.follow'),
          systemIcon: isFollowing ? 'star.slash' : 'star',
        },
        run: onToggleFollow,
      },
    ];
    if (canEdit) {
      list.push({ action: { label: t('mobile.gymPage.editDetails'), systemIcon: 'pencil' }, run: onEdit });
    }
    if (onReport) {
      list.push({
        action: { label: t('mobile.gymPage.report'), systemIcon: 'flag', dividerBefore: true },
        run: onReport,
      });
    }
    return list;
  }, [isFollowing, onToggleFollow, canEdit, onEdit, onReport, t]);
  const actions = useMemo(() => entries.map((entry) => entry.action), [entries]);
  const handleSelect = useCallback((index: number) => entries[index]?.run(), [entries]);

  return (
    <View style={styles.row}>
      <GymShareButton gym={gym} />
      <AppMenu
        iconName="more"
        iconAppearance="plain"
        anchorSize={topBarFor(variant).nativeBarGlyphFrame}
        accessibilityLabel={t('mobile.gymPage.actionsAria', { gym: gym.name })}
        actions={actions}
        onSelectIndex={handleSelect}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
