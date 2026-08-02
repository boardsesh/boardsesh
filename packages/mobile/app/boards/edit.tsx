import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoard, useProfile, useUpdateBoard, useLinkBoardToGym } from '../../src/lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { extractGraphqlMessage } from '../../src/lib/graphql/extract-error-message';
import { useAuth } from '../../src/providers/auth-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { useBoardBuilder, type BoardBuilderSeed } from '../../src/components/board-discovery/use-board-builder';
import { BoardForm } from '../../src/components/board-discovery/BoardForm';
import { formatDefaultBoardName } from '../../src/components/board-discovery/board-builder-labels';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { useTheme } from '../../src/providers/theme-provider';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

export default function EditBoard() {
  const router = useRouter();
  const { boardUuid } = useLocalSearchParams<{ boardUuid?: string }>();
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  const { data: board, isLoading } = useBoard(boardUuid ?? null);
  const boardName = board ? toBoardName(board.boardType) : null;

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Missing (deleted elsewhere / stale link) or an unrenderable board type:
  // there's nothing to edit, so offer a way back rather than a broken form.
  if (!board || !boardName) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.edit.notFound')}
        </Text>
        <Button
          title={t('mobile.edit.back')}
          variant="outlined"
          onPress={() => router.back()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  // The edit affordance is only shown when the viewer can edit, but a direct
  // deep-link can still land here. The server rejects the save regardless, so
  // show a clear "no access" state instead of a form that can only fail.
  if (!board.canEdit) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="lock" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.edit.noAccess')}
        </Text>
        <Button
          title={t('mobile.edit.back')}
          variant="outlined"
          onPress={() => router.back()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  // Remount the form per board so the builder seeds (incl. the More-options meta,
  // which only applies via the state initialisers) from a fully-loaded board.
  return <EditBoardForm key={board.uuid} board={board} />;
}

function EditBoardForm({ board }: { board: UserBoard }) {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('boards');

  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const updateBoard = useUpdateBoard();
  const linkBoardToGym = useLinkBoardToGym();

  // Authorized editors (owner, or a community admin/leader for this board type —
  // the server reports this as `canEdit`) may change the config even when the
  // board has ticks: a config change reflects a real physical reconfiguration and
  // the old ticks are preserved server-side. Anyone without edit access keeps the
  // config chips locked.
  const lockedConfig = !board.canEdit;

  const seed = useMemo<BoardBuilderSeed>(() => {
    const seedBoardName = toBoardName(board.boardType)!;
    return {
      boardName: seedBoardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      name: board.name,
      isOwned: board.isOwned,
      isPublic: board.isPublic,
      isUnlisted: board.isUnlisted,
      hideLocation: board.hideLocation,
      isAngleAdjustable: board.isAngleAdjustable,
      locationName: board.locationName ?? undefined,
      latitude: board.latitude ?? undefined,
      longitude: board.longitude ?? undefined,
      serialNumber: board.serialNumber ?? undefined,
      timerName: board.timerName ?? undefined,
      gymUuid: board.gymUuid,
      gymName: board.gymName,
    };
  }, [board]);

  const builder = useBoardBuilder(seed);

  const selectedSize = useMemo(
    () => builder.sizes.find((size) => size.id === builder.sizeId) ?? null,
    [builder.sizes, builder.sizeId],
  );
  const defaultName = useMemo(
    () =>
      formatDefaultBoardName({
        userName: profile?.displayName,
        boardName: builder.boardName,
        layoutName: builder.rawLayoutName,
        size: selectedSize,
      }),
    [profile?.displayName, builder.boardName, builder.rawLayoutName, selectedSize],
  );

  const [submitting, setSubmitting] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleUpdate = useCallback(async () => {
    if (submitting) return;
    const input = builder.buildUpdateInput(board.uuid, { lockedConfig, fallbackName: defaultName });
    if (!input) return;
    setSubmitting(true);
    setUpdateError(null);
    hapticSelection();
    try {
      const updated = await updateBoard.mutateAsync(input);

      // `UpdateBoardInput` carries no gym, so a changed gym is its own mutation.
      // It can be rejected on its own terms (too far from a gym the user doesn't
      // run), so it's reported separately rather than failing the whole save.
      const nextGymUuid = builder.selectedGym?.uuid ?? null;
      let gymLinkError: string | null = null;
      if (nextGymUuid !== (board.gymUuid ?? null)) {
        try {
          await linkBoardToGym.mutateAsync({ boardUuid: board.uuid, gymUuid: nextGymUuid });
        } catch (error) {
          gymLinkError = extractGraphqlMessage(error) ?? t('mobile.gymPicker.linkError');
        }
      }

      // The active board is a denormalised AsyncStorage copy — re-persist it so
      // the rename / angle / visibility change reaches BLE + the play drawer.
      // This runs even when the gym link failed: the rest of the edit DID save,
      // and bailing early left the stored copy stale against the server.
      if (activeBoard?.uuid === updated.uuid) await setActiveBoard(updated);

      if (gymLinkError) {
        setUpdateError(gymLinkError);
        setSubmitting(false);
        return;
      }
      router.back();
      // Navigated away on success — leave `submitting` set (unmounting).
    } catch (error) {
      // Covers the config-locked race and the duplicate-config guard, both of
      // which the server enforces authoritatively. Inline, not a toast: this is
      // a `presentation: 'modal'` route and the toast overlay draws behind it.
      setUpdateError(extractGraphqlMessage(error) ?? t('mobile.edit.updateError'));
      setSubmitting(false);
    }
  }, [
    submitting,
    builder,
    board.uuid,
    board.gymUuid,
    lockedConfig,
    defaultName,
    updateBoard,
    linkBoardToGym,
    activeBoard?.uuid,
    setActiveBoard,
    router,
    t,
  ]);

  return (
    <BoardForm
      builder={builder}
      defaultName={defaultName}
      submitting={submitting}
      errorMessage={updateError}
      onSubmit={() => void handleUpdate()}
      submitLabel={t('mobile.edit.save')}
      lockedConfig={lockedConfig}
    />
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing[4],
  },
});
