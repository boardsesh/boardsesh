import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type FlatListProps,
  type LayoutChangeEvent,
  type ListRenderItem,
  type TextInputProps,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { playlistMembershipStore } from '@boardsesh/climb-actions';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { useClimbPlaylistMemberships } from '../../hooks/use-climb-playlist-memberships';
import { useClimbPlaylistMembershipQuery } from '../../hooks/use-climb-playlist-membership-query';
import { usePlaylistsContext, type Playlist } from '../../providers/playlists-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { reportHandledError } from '../../lib/error-reporting';
import { filterPlaylistsByBoard, sortPlaylistsByName } from '../../lib/sort-filter-playlists';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { PLAYLIST_COLORS, normalizePlaylistColor } from './playlist-colors';
import { NAME_MAX } from './playlist-form-values';

// One-tap emoji shortcuts for the compact inline create form. The full emoji
// picker (system keyboard + description field) lives on the playlist edit
// screen; the inline form stays lightweight so it fits the reaction overlay's
// floating card.
const QUICK_EMOJI = ['🔥', '💪', '🎯', '⭐', '🧗', '🪨', '🏆'] as const;

// The subset of TextInput props the create form actually drives. Typing the
// injected component against this (not full TextInputProps) lets both the RN
// `TextInput` and @expo/ui's `BottomSheetTextInput` satisfy it without a cast.
export type PickerTextInputProps = Pick<
  TextInputProps,
  | 'value'
  | 'onChangeText'
  | 'placeholder'
  | 'placeholderTextColor'
  | 'maxLength'
  | 'style'
  | 'returnKeyType'
  | 'autoFocus'
  | 'onSubmitEditing'
>;

type InlinePlaylistPickerProps = {
  climb: Climb;
  /** Angle the membership add targets (the climb's board config angle). */
  angle: number;
  boardName: BoardName;
  layoutId: number;
  /**
   * Text input host: inject `BottomSheetTextInput` when rendered inside a
   * `ModalSheet` (so the keyboard pushes the sheet), and the plain RN
   * `TextInput` when rendered inside the reaction overlay. Keeps this body
   * presentation-agnostic — it never mounts a sheet or overlay of its own,
   * which is the whole point (#3294: stacking a second native sheet dismisses
   * the first).
   */
  TextInputComponent: ComponentType<PickerTextInputProps>;
  /** Rendered on the left of the header when the host wants a back affordance
   *  (the reaction overlay returns to its action list; the sheet omits it). */
  onBack?: () => void;
  /** When set, the header (with the back button) is pinned and the list scrolls
   *  within this height — so scrolling a long playlist list never hides "back".
   *  Omit in a sheet host, whose own scroll already scrolls the body. */
  maxHeight?: number;
  /** Virtualized list host for the playlist rows: the RN `FlatList` in the reaction
   *  overlay (default), `BottomSheetFlatList` inside a `ModalSheet` so it scrolls
   *  with the sheet. Injected rather than `.map`-ing rows in a ScrollView. */
  ListComponent?: ComponentType<FlatListProps<Playlist>>;
  /**
   * Where a failure goes once it settles *after* this picker has unmounted.
   * Defaults to a root toast, which is right when unmounting the picker IS the
   * host going away — `AddToPlaylistSheet`'s data is only cleared on the sheet's
   * `onFullyDismissed`, so by then the toast layer is on top.
   *
   * The reaction overlay outlives the picker: "back" pops to its action menu and
   * unmounts us while the `FullWindowOverlay` (iOS) / transparent `Modal`
   * (Android) is still presented, and a root toast renders BEHIND those (see
   * toast-provider). Hosts in that shape must pass their own channel — one that
   * holds the message until they are gone — or the failure is invisible again.
   */
  onDetachedFailure?: (message: string) => void;
};

const playlistKey = (playlist: Playlist) => playlist.id;

/**
 * Membership-aware "add to playlist" body: a toggle list (checkmark = the climb
 * is in that playlist; tap to add or remove) plus an inline create form. Shared
 * by the reaction overlay (`ClimbReactionMenu`) and the add-to-playlist
 * `ModalSheet` (`AddToPlaylistSheet`).
 *
 * Feedback is inline *while the picker is on screen*: a toast fired while a
 * `FullWindowOverlay` or native sheet is up renders behind it and is invisible.
 * Success is the optimistic checkmark itself; failures revert the optimistic
 * state and surface an inline error line. Once this picker is gone (the climber
 * dismissed the sheet/overlay, or popped back to the reaction menu, while the
 * request was still in flight — which on gym wifi is most of the window) the
 * inline line has nowhere to render, so the failure is handed to
 * `onDetachedFailure`, defaulting to a toast on whatever they dismissed to
 * (#3891).
 */
export function InlinePlaylistPicker({
  climb,
  angle,
  boardName,
  layoutId,
  TextInputComponent,
  onBack,
  maxHeight,
  ListComponent = FlatList,
  onDetachedFailure,
}: InlinePlaylistPickerProps) {
  const { t } = useTranslation('climbs');
  const { t: tc } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const queryClient = useQueryClient();
  const { playlists, addToPlaylist, removeFromPlaylist, createPlaylist, isLoading, isAuthenticated } =
    usePlaylistsContext();

  // This climb's current memberships. The provider's membership map is empty
  // (see use-mobile-climb-actions-data) and the shared chip store is only
  // populated behind an opt-in setting, so fetch the single climb's memberships
  // directly — the source of truth for the checkmarks. Optimistic writes go
  // through `setQueryData` on this key so they survive the host unmounting and
  // re-mounting the picker (the reaction overlay does exactly that on back), and
  // so the play-drawer header's chips pick up a toggle without a refetch.
  const { membershipKey, memberUuids } = useClimbPlaylistMembershipQuery({
    climbUuid: climb.uuid,
    boardName,
    layoutId,
    enabled: isAuthenticated,
  });

  // Seed checkmarks from the shared membership store (the climb list populates it
  // when playlist tags are on) so they show instantly; the per-climb query then
  // confirms. The list itself never waits on this fetch — no membership spinner.
  const seededMembers = useClimbPlaylistMemberships(climb.uuid);
  const members = useMemo(() => new Set(memberUuids ?? seededMembers), [memberUuids, seededMembers]);

  const [error, setError] = useState<string | null>(null);

  // Whether this picker is still on screen. Read inside a settled request's catch
  // block to pick the channel the climber can actually see — see `surfaceFailure`.
  const mountedRef = useRef(true);

  /**
   * Report a membership failure through whichever channel is visible right now.
   * Mounted: the inline error line (a root toast would render behind the sheet /
   * FullWindowOverlay hosting us). Unmounted: hand it to the host's detached
   * channel, defaulting to a toast — `setError` on a dead component is a silent
   * no-op, and that is how a failed add used to reach nobody at all (#3891).
   * Mutually exclusive, so there is never a double signal; the choice is made at
   * the moment the rejection lands, not when the tap happened.
   *
   * The two messages differ on purpose: the inline line sits inside the picker
   * the climber is looking at, so it stays generic, while the detached one has to
   * say which playlist it is about.
   */
  const { showToast } = useToast();
  // Read through a ref so a host that rebuilds the callback each render can't
  // churn `surfaceFailure` (and through it `handleToggle`, and through that every
  // memoized row).
  const detachedFailureRef = useRef(onDetachedFailure);
  detachedFailureRef.current = onDetachedFailure;
  const surfaceFailure = useCallback(
    (inlineMessage: string, detachedMessage: string) => {
      if (mountedRef.current) {
        setError(inlineMessage);
        return;
      }
      const reportDetached = detachedFailureRef.current;
      if (reportDetached) {
        reportDetached(detachedMessage);
        return;
      }
      showToast(detachedMessage, 'error');
    },
    [showToast],
  );

  // Scope the "add to playlist" list to the climb's own board+layout — the
  // provider's `playlists` spans every board the user has playlists on, and
  // adding a climb to a wrong-board playlist isn't guarded server-side (#4224).
  const sortedPlaylists = useMemo(
    () => sortPlaylistsByName(filterPlaylistsByBoard(playlists, boardName, layoutId)),
    [playlists, boardName, layoutId],
  );

  // Write a membership set to the cache and mirror it into the shared chip store
  // (so climb-list playlist chips reflect the change without a refetch).
  const writeMembership = useCallback(
    (nextUuids: string[]) => {
      queryClient.setQueryData<string[]>(membershipKey, nextUuids);
      playlistMembershipStore.setMembershipForClimb(climb.uuid, nextUuids);
    },
    [queryClient, membershipKey, climb.uuid],
  );

  // Serialize toggles per playlist: a row stays tappable while its mutation is in
  // flight, so ignore repeat taps on the same row until it settles — otherwise a
  // fast add-then-remove could reorder on the backend and leave the cache/UI out
  // of sync with the row's real membership.
  const togglingRef = useRef<Set<string>>(new Set());

  // Toggle one playlist's membership. Reads and writes are surgical — computed
  // against the *latest* cache each time — so overlapping toggles of DIFFERENT rows
  // never clobber each other. Rows are tappable before the membership fetch
  // resolves, so cancel it first: a late response must not overwrite the checkmark.
  const handleToggle = useCallback(
    async (playlist: Playlist) => {
      if (togglingRef.current.has(playlist.uuid)) return;
      togglingRef.current.add(playlist.uuid);
      try {
        await queryClient.cancelQueries({ queryKey: membershipKey });
        const before = queryClient.getQueryData<string[]>(membershipKey) ?? [...members];
        const willBeMember = !before.includes(playlist.uuid);
        setError(null);
        writeMembership(willBeMember ? [...before, playlist.uuid] : before.filter((uuid) => uuid !== playlist.uuid));
        try {
          if (willBeMember) {
            // The backend resolvers key on playlists.uuid, so the uuid (not the
            // bigserial id) goes on the wire.
            await addToPlaylist(playlist.uuid, climb.uuid, angle);
          } else {
            await removeFromPlaylist(playlist.uuid, climb.uuid);
          }
        } catch (toggleError) {
          // Undo ONLY this row's change against the current cache — not a stale
          // snapshot — so a sibling toggle that succeeded meanwhile is preserved.
          const current = queryClient.getQueryData<string[]>(membershipKey) ?? [];
          writeMembership(
            willBeMember ? current.filter((uuid) => uuid !== playlist.uuid) : [...new Set([...current, playlist.uuid])],
          );
          surfaceFailure(
            t(willBeMember ? 'actions.playlist.toast.addFailed' : 'actions.playlist.toast.removeFailed'),
            t(willBeMember ? 'actions.playlist.toast.addFailedNamed' : 'actions.playlist.toast.removeFailedNamed', {
              playlist: playlist.name,
            }),
          );
          // Unconditional, regardless of mount state: before this, a toggle that
          // failed after the host was dismissed left no trace anywhere — not even
          // in a release build's logs (the console.warn below is __DEV__-only).
          reportHandledError(toggleError, { tags: { source: 'playlist', op: 'toggle-membership' } });
          if (__DEV__) {
            console.warn('[playlist] toggle membership failed', {
              playlistUuid: playlist.uuid,
              climbUuid: climb.uuid,
              add: willBeMember,
              error: toggleError,
            });
          }
        }
      } finally {
        togglingRef.current.delete(playlist.uuid);
      }
    },
    [
      queryClient,
      membershipKey,
      members,
      writeMembership,
      addToPlaylist,
      removeFromPlaylist,
      climb.uuid,
      angle,
      surfaceFailure,
      t,
    ],
  );

  // === Inline create form ===
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | undefined>(undefined);
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Guards the async create flow against cancel/unmount: each submit takes a token;
  // cancelling the form or unmounting the picker bumps it, so an in-flight create's
  // continuation (add + UI updates) aborts instead of adding the climb after the
  // user backed out.
  const createRequestIdRef = useRef(0);
  useEffect(() => {
    // Set on mount as well as cleared on unmount: a mount/cleanup/mount cycle
    // (StrictMode, Fast Refresh) would otherwise leave a live picker classified
    // as detached forever, sending every failure to an invisible toast.
    mountedRef.current = true;
    return () => {
      createRequestIdRef.current += 1;
      mountedRef.current = false;
    };
  }, []);

  const resetCreate = useCallback(() => {
    setName('');
    setColor(undefined);
    setIcon(undefined);
    setCreateError(null);
  }, []);

  const handleOpenCreate = useCallback(() => {
    setError(null);
    resetCreate();
    setSubmitting(false);
    setCreateOpen(true);
  }, [resetCreate]);

  const handleCloseCreate = useCallback(() => {
    // Bump the token so an in-flight create's continuation aborts, then reset.
    createRequestIdRef.current += 1;
    resetCreate();
    setSubmitting(false);
    setCreateOpen(false);
  }, [resetCreate]);

  const handleSubmitCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError(t('actions.playlist.validation.nameRequired'));
      return;
    }
    // No length check needed: the input caps at NAME_MAX (maxLength) and trim only
    // shortens, so the name can't exceed it.
    const requestId = (createRequestIdRef.current += 1);
    const isCurrent = () => createRequestIdRef.current === requestId;
    setSubmitting(true);
    setCreateError(null);
    // Create and add are separate operations with separate failure handling: if
    // the playlist is created but the add fails, we must NOT report "create
    // failed" and leave the name in the form, or a retry creates a duplicate.
    let created;
    try {
      created = await createPlaylist(trimmed, undefined, color, icon, { boardType: boardName, layoutId });
    } catch (submitError) {
      // Inline, not a toast — the picker (and its host overlay/sheet) stays up.
      if (isCurrent()) {
        setCreateError(t('actions.playlist.toast.createFailed'));
        setSubmitting(false);
      }
      if (__DEV__) {
        console.warn('[playlist] inline create failed', {
          climbUuid: climb.uuid,
          boardName,
          layoutId,
          error: submitError,
        });
      }
      return;
    }
    // If the user cancelled / dismissed while the playlist was being created, stop:
    // don't add the climb or touch UI they've left (the empty playlist may persist).
    if (!isCurrent()) return;
    // Playlist exists now; close the form so a retry can't duplicate it. The new
    // (still-unchecked) playlist is already in the list to tap if the add fails.
    setCreateOpen(false);
    resetCreate();
    try {
      await addToPlaylist(created.uuid, climb.uuid, angle);
      if (!isCurrent()) return;
      // Cancel any in-flight membership fetch (it was sent before this playlist
      // existed) so it can't overwrite the new checkmark, then optimistically add.
      await queryClient.cancelQueries({ queryKey: membershipKey });
      const current = queryClient.getQueryData<string[]>(membershipKey) ?? [...members];
      writeMembership([...new Set([...current, created.uuid])]);
    } catch (addError) {
      // Not gated on isCurrent(). The token goes stale two ways here and both
      // want the message shown: the picker went away (so `surfaceFailure` routes
      // to the detached channel), or a SECOND inline create was submitted while
      // this add was in flight (so the climber is looking at that form, and
      // suppressing this would silently lose the first playlist's add). Because
      // the second case can leave the create form open — where the list header's
      // error line isn't rendered — both channels name the playlist.
      surfaceFailure(
        t('actions.playlist.toast.addFailedNamed', { playlist: created.name }),
        t('actions.playlist.toast.addFailedNamed', { playlist: created.name }),
      );
      reportHandledError(addError, { tags: { source: 'playlist', op: 'create-then-add' } });
      if (__DEV__) {
        console.warn('[playlist] created playlist but failed to add climb', {
          playlistUuid: created.uuid,
          climbUuid: climb.uuid,
          error: addError,
        });
      }
    } finally {
      if (isCurrent()) setSubmitting(false);
    }
  }, [
    name,
    color,
    icon,
    createPlaylist,
    boardName,
    layoutId,
    addToPlaylist,
    climb.uuid,
    angle,
    resetCreate,
    queryClient,
    membershipKey,
    members,
    writeMembership,
    surfaceFailure,
    t,
  ]);

  const inputStyle = useMemo(
    () => [
      styles.input,
      { backgroundColor: systemColors.fill, color: systemColors.label, borderColor: systemColors.separator },
    ],
    [systemColors],
  );

  // Bound the scroll area to the space left under the pinned header, measured so
  // the list scrolls (not clips) whatever the header's height.
  const [headerHeight, setHeaderHeight] = useState(0);
  const scrollMaxHeight = maxHeight != null ? Math.max(120, maxHeight - headerHeight) : undefined;
  const onHeaderLayout = useCallback(
    (event: LayoutChangeEvent) => setHeaderHeight(event.nativeEvent.layout.height),
    [],
  );

  const renderPlaylistRow = useCallback<ListRenderItem<Playlist>>(
    ({ item, index }) => {
      const accent = normalizePlaylistColor(item.color) ?? brandColors.primary;
      const member = members.has(item.uuid);
      return (
        <ListRow
          title={item.name}
          subtitle={t('multiboardList.count', { count: item.climbCount })}
          leading={<Icon name="playlist" size={22} color={accent} />}
          trailing={member ? <Icon name="check.small" size={18} color={brandColors.primary} /> : undefined}
          onPress={() => void handleToggle(item)}
          accessibilityLabel={item.name}
          accessibilityHint={member ? t('actions.playlist.toast.removed') : t('actions.playlist.toast.added')}
          showSeparator={index < sortedPlaylists.length - 1}
        />
      );
    },
    [sortedPlaylists, members, handleToggle, brandColors, t],
  );

  return (
    <View style={[styles.container, maxHeight != null ? { maxHeight } : null]}>
      <View style={styles.header} onLayout={onHeaderLayout}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={tc('actions.back')}
            hitSlop={8}
            style={styles.backButton}
          >
            <Icon name="chevron.left" size={20} color={systemColors.label} />
          </Pressable>
        ) : (
          <Icon name="playlist" size={20} color={systemColors.accent} />
        )}
        <Text variant="headline" style={styles.headerTitle} numberOfLines={1}>
          {t('actions.playlist.popover.title')}
        </Text>
        {isAuthenticated && !createOpen ? (
          <Pressable
            onPress={handleOpenCreate}
            accessibilityRole="button"
            accessibilityLabel={t('actions.playlist.popover.createNew')}
            hitSlop={8}
            style={[styles.createButton, { backgroundColor: systemColors.fill }]}
          >
            <Icon name="plus" size={18} color={brandColors.primary} />
          </Pressable>
        ) : null}
      </View>

      {createOpen ? (
        <ScrollView
          style={scrollMaxHeight != null ? { maxHeight: scrollMaxHeight } : undefined}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View style={styles.createForm}>
            <TextInputComponent
              value={name}
              onChangeText={(text) => {
                setCreateError(null);
                setName(text);
              }}
              placeholder={t('actions.playlist.create.namePlaceholder')}
              placeholderTextColor={systemColors.tertiaryLabel}
              maxLength={NAME_MAX}
              style={inputStyle}
              returnKeyType="done"
              autoFocus
              onSubmitEditing={() => {
                void handleSubmitCreate();
              }}
            />
            <View style={styles.swatchRow}>
              {PLAYLIST_COLORS.map((swatch) => {
                const selected = color === swatch;
                return (
                  <Pressable
                    key={swatch}
                    onPress={() => setColor(selected ? undefined : swatch)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[
                      styles.swatch,
                      { backgroundColor: swatch, borderColor: systemColors.separator },
                      selected && styles.swatchSelected,
                    ]}
                  >
                    {selected ? <Icon name="check.small" size={14} color={iosSystemColors.white} /> : null}
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.emojiRow}>
              {QUICK_EMOJI.map((preset) => {
                const selected = icon === preset;
                return (
                  <Pressable
                    key={preset}
                    onPress={() => setIcon(selected ? undefined : preset)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[
                      styles.emojiChip,
                      { backgroundColor: systemColors.fill },
                      selected && [styles.emojiChipSelected, { borderColor: brandColors.primary }],
                    ]}
                  >
                    <Text style={styles.emoji} allowFontScaling={false}>
                      {preset}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {/* The list header's error line isn't mounted while this form is open,
                so a membership failure that lands here (an add from before the form
                was opened) shows in the form's slot instead of nowhere. */}
            {(createError ?? error) ? (
              <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.errorText}>
                {createError ?? error}
              </Text>
            ) : null}
            <View style={styles.createActions}>
              <Pressable
                onPress={handleCloseCreate}
                accessibilityRole="button"
                accessibilityLabel={tc('actions.cancel')}
                hitSlop={8}
                style={styles.cancelButton}
                disabled={submitting}
              >
                <Text variant="body" color={systemColors.secondaryLabel}>
                  {tc('actions.cancel')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  void handleSubmitCreate();
                }}
                accessibilityRole="button"
                accessibilityLabel={t('actions.playlist.create.submit')}
                hitSlop={8}
                style={[styles.submitButton, { backgroundColor: brandColors.primary }]}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color={iosSystemColors.white} />
                ) : (
                  <Text variant="body" color={iosSystemColors.white} style={styles.submitLabel}>
                    {t('actions.playlist.create.submit')}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </ScrollView>
      ) : !isAuthenticated ? (
        <View style={styles.message}>
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {t('actions.playlist.popover.signInBlurb')}
          </Text>
        </View>
      ) : isLoading && sortedPlaylists.length === 0 ? (
        // Spinner only before the user's playlists are cached at all; once they're
        // available we render immediately and checkmarks fill in.
        <View style={styles.message}>
          <ActivityIndicator />
        </View>
      ) : (
        // Virtualized (FlatList in the overlay, BottomSheetFlatList in a sheet) — a
        // toggle-failure line rides in the header, the empty state in ListEmpty.
        <ListComponent
          data={sortedPlaylists}
          keyExtractor={playlistKey}
          renderItem={renderPlaylistRow}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
          style={scrollMaxHeight != null ? { maxHeight: scrollMaxHeight } : undefined}
          ListHeaderComponent={
            error ? (
              <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.errorText}>
                {error}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.message}>
              <Text variant="subheadline" color={iosSystemColors.systemGray}>
                {t('actions.playlist.popover.empty')}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  backButton: {
    width: spacing[6],
    alignItems: 'flex-start',
    justifyContent: 'center',
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
  createForm: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[3],
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[3],
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchSelected: {
    borderWidth: 3,
    borderColor: iosSystemColors.white,
  },
  emojiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  emojiChip: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiChipSelected: {
    borderWidth: 2,
  },
  emoji: {
    fontSize: 20,
  },
  createActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[3],
    marginTop: spacing[1],
  },
  cancelButton: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  submitButton: {
    minWidth: 96,
    height: spacing[10],
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  submitLabel: {
    fontWeight: '600',
  },
  message: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[6],
    paddingHorizontal: spacing[4],
  },
  errorText: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
});
