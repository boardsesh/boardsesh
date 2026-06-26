import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { ModalSheet } from './ModalSheet';
import { ClimbPreviewCard } from './ClimbPreviewCard';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { Text } from './Text';
import { PlaylistFormSheet, type PlaylistFormValues } from './playlist';
import { useToast } from '../providers/toast-provider';
import { usePlaylistsContext, type Playlist } from '../providers/playlists-provider';
import { useTheme } from '../providers/theme-provider';
import { sortPlaylistsByName } from '../lib/sort-filter-playlists';
import { iosSystemColors } from '../theme/ios-colors';
import { borderRadius, spacing } from '../theme/tokens';

type AddToPlaylistSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  /** Request an animated close (pan-down, after add/create). */
  onClose: () => void;
  /** Fired once the dismiss animation has settled — safe to unmount/clear.
   * Optional: always-mounted hosts don't unmount, so they may omit it. */
  onFullyDismissed?: () => void;
};

// Mirrors web's isValidHexColor gate before rendering a playlist's accent: a
// stray value would otherwise paint the leading swatch an undefined colour.
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function validHexColor(color: string | undefined): string | null {
  return color && HEX_COLOR.test(color) ? color : null;
}

function AddToPlaylistSheet({
  visible,
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onClose,
  onFullyDismissed,
}: AddToPlaylistSheetProps) {
  const { t } = useTranslation('climbs');
  const { brandColors, systemColors } = useTheme();
  const { showToast } = useToast();
  const { playlists, addToPlaylist, createPlaylist, isLoading, isAuthenticated } = usePlaylistsContext();
  const [createVisible, setCreateVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  // Mirror the latest open intent so an in-flight create can tell whether the
  // sheet is still open (replaces the old isPresentedRef gate).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const createRequestIdRef = useRef(0);
  const sortedPlaylists = useMemo(() => sortPlaylistsByName(playlists), [playlists]);

  const handleAddToPlaylist = useCallback(
    async (playlist: Playlist) => {
      if (!climb) return;
      try {
        // The backend addClimbToPlaylist resolver matches playlists.uuid, so
        // the playlist *uuid* (not the bigserial id) must go on the wire — the
        // id round-trips a "Playlist not found" error. It also keys the
        // post-add cache invalidation onto the detail screen's ['playlist', uuid]
        // / ['playlistClimbs', uuid] entries.
        await addToPlaylist(playlist.uuid, climb.uuid, angle);
        showToast(t('actions.playlist.toast.added'), 'success');
      } catch (error) {
        // The toast is intentionally generic, but a swallowed error makes
        // "failed to add" impossible to diagnose. Log the real reason in dev.
        if (__DEV__) {
          console.warn('[playlist] add to playlist failed', {
            playlistUuid: playlist.uuid,
            climbUuid: climb.uuid,
            angle,
            error,
          });
        }
        showToast(t('actions.playlist.toast.addFailed'), 'error');
      } finally {
        onClose();
      }
    },
    [climb, angle, addToPlaylist, showToast, t, onClose],
  );

  const handleCreatePlaylist = useCallback(
    async (values: PlaylistFormValues) => {
      if (!climb) return;
      const createRequestId = createRequestIdRef.current + 1;
      createRequestIdRef.current = createRequestId;
      const isCurrentCreateRequest = () => createRequestIdRef.current === createRequestId && visibleRef.current;
      setCreating(true);
      try {
        const created = await createPlaylist(values.name, values.description, values.color, values.icon, {
          boardType: boardName,
          layoutId,
        });
        if (!isCurrentCreateRequest()) return;
        setCreateVisible(false);
        try {
          await addToPlaylist(created.uuid, climb.uuid, angle);
          if (!isCurrentCreateRequest()) return;
          showToast(t('actions.playlist.toast.createdNamed', { name: created.name }), 'success');
          onClose();
        } catch (error) {
          if (!isCurrentCreateRequest()) return;
          if (__DEV__) {
            console.warn('[playlist] created playlist but failed to add climb', {
              playlistUuid: created.uuid,
              climbUuid: climb.uuid,
              angle,
              error,
            });
          }
          showToast(t('actions.playlist.toast.addFailed'), 'error');
        }
      } catch (error) {
        if (!isCurrentCreateRequest()) return;
        if (__DEV__) {
          console.warn('[playlist] create playlist from add sheet failed', {
            climbUuid: climb.uuid,
            boardName,
            layoutId,
            error,
          });
        }
        showToast(t('actions.playlist.toast.createFailed'), 'error');
      } finally {
        if (createRequestIdRef.current === createRequestId) setCreating(false);
      }
    },
    [climb, createPlaylist, boardName, layoutId, addToPlaylist, angle, showToast, t, onClose],
  );

  // The dismiss animation has settled: cancel any in-flight create, reset the
  // nested form, then let the parent clear the climb / unmount.
  const handleFullyDismissed = useCallback(() => {
    createRequestIdRef.current += 1;
    setCreateVisible(false);
    setCreating(false);
    onFullyDismissed?.();
  }, [onFullyDismissed]);

  const handleShowCreate = useCallback(() => {
    setCreateVisible(true);
  }, []);

  const handleCloseCreate = useCallback(() => {
    createRequestIdRef.current += 1;
    setCreateVisible(false);
    setCreating(false);
  }, []);

  const snapPoints = useMemo(() => ['50%', '90%'], []);

  return (
    <>
      <ModalSheet
        visible={visible && !!climb}
        snapPoints={snapPoints}
        onClose={onClose}
        onFullyDismissed={handleFullyDismissed}
        enablePanDownToClose
        scrollable
      >
        {climb && (
          <ClimbPreviewCard
            climb={climb}
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            angle={angle}
          />
        )}
        <View style={styles.header}>
          <Icon name="playlist" size={20} color={systemColors.accent} />
          <Text variant="headline" style={styles.headerTitle}>
            {t('actions.playlist.popover.title')}
          </Text>
          {climb && isAuthenticated ? (
            <Pressable
              onPress={handleShowCreate}
              accessibilityRole="button"
              accessibilityLabel={t('actions.playlist.popover.createNew')}
              hitSlop={8}
              style={[styles.createButton, { backgroundColor: systemColors.fill }]}
            >
              <Icon name="plus" size={18} color={brandColors.primary} />
            </Pressable>
          ) : null}
        </View>

        {!climb ? null : !isAuthenticated ? (
          <View style={styles.message}>
            <Text variant="subheadline" color={iosSystemColors.systemGray}>
              {t('actions.playlist.popover.signInBlurb')}
            </Text>
          </View>
        ) : isLoading ? (
          <View style={styles.message}>
            <ActivityIndicator />
          </View>
        ) : sortedPlaylists.length === 0 ? (
          <View style={styles.message}>
            <Text variant="subheadline" color={iosSystemColors.systemGray}>
              {t('actions.playlist.popover.empty')}
            </Text>
          </View>
        ) : (
          sortedPlaylists.map((playlist, index) => {
            const accent = validHexColor(playlist.color);
            return (
              <ListRow
                key={playlist.id}
                title={playlist.name}
                subtitle={t('multiboardList.count', { count: playlist.climbCount })}
                leading={<Icon name="playlist" size={22} color={accent ?? brandColors.primary} />}
                onPress={() => {
                  void handleAddToPlaylist(playlist);
                }}
                showSeparator={index < sortedPlaylists.length - 1}
              />
            );
          })
        )}
      </ModalSheet>

      <PlaylistFormSheet
        mode="create"
        visible={createVisible}
        submitting={creating}
        onSubmit={handleCreatePlaylist}
        onClose={handleCloseCreate}
      />
    </>
  );
}

export { AddToPlaylistSheet };

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
  },
  headerTitle: {
    flex: 1,
  },
  createButton: {
    width: spacing[8],
    height: spacing[8],
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[6],
    paddingHorizontal: spacing[4],
  },
});
