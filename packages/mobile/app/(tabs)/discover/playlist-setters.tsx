import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { usePlaylistSetters, type PlaylistSetterSource } from '@boardsesh/playlists-react';
import { SetterPickerList, type SetterPickerItem } from '../../../src/components/filter-sheet/SetterPickerList';
import { useHeaderActions } from '../../../src/hooks/use-header-actions';
import { emitSetterFilterSelection } from '../../../src/lib/setter-filter-handoff';
import {
  parsePlaylistSetterSource,
  type PlaylistSetterSourceParams,
} from '../../../src/lib/playlists/playlist-setter-source';

type Params = PlaylistSetterSourceParams & {
  /** The sheet's current picks (JSON array of usernames). */
  setters?: string;
  /** Which filter sheet gets the picks back (see lib/filter-picker-handoff-id.ts). */
  handoffId?: string;
};

/** Stands in for a malformed or missing source: the query stays off. */
const NO_LIST: PlaylistSetterSource = { kind: 'playlist', playlistId: '' };

function parseSelectedSetters(serialized: string | undefined): string[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The Setters filter of a playlist or smart list (#6651): the setters of the
 * list's own climbs, most climbs first, as a multi-select. A pushed route in the
 * Discover stack rather than a stacked sheet (native sheets can't stack); the
 * list's filter sheet suspends while it is on top
 * (docs/mobile-sheets-vs-routes.md).
 *
 * Two ways out: "Show climbs" hands the picks back and returns to the list; the
 * back chevron or swipe-back hands them back too, and the suspended sheet comes
 * back with them applied. Either way the picks go only to the sheet that opened
 * this route (`handoffId`).
 *
 * No count on "Show climbs" and no Following scope: the list counts its own
 * matches once the sheet has them, and the setters here are already the list's.
 */
export default function PlaylistSettersScreen() {
  const params = useLocalSearchParams<Params>();
  const navigation = useNavigation();
  const { t } = useTranslation('playlists');
  const { t: tClimbs } = useTranslation('climbs');

  const handoffId = params.handoffId ?? '';
  const { playlistId, smartType, userId } = params;
  const source = useMemo(
    () => parsePlaylistSetterSource({ playlistId, smartType, userId }) ?? NO_LIST,
    [playlistId, smartType, userId],
  );
  const [selectedSetters, setSelectedSetters] = useState<string[]>(() => parseSelectedSetters(params.setters));
  const selectedSettersRef = useRef(selectedSetters);
  selectedSettersRef.current = selectedSetters;
  // Set once "Show climbs" has handed the picks back, so the removal that
  // follows doesn't hand them back a second time.
  const appliedRef = useRef(false);

  // The list debounces the search field and hands the settled text back here.
  const [search, setSearch] = useState('');
  const { setters, isLoading, isError, refetch } = usePlaylistSetters({ source, search });
  const pickerItems = useMemo<SetterPickerItem[] | undefined>(
    () => setters?.map((setter) => ({ setterUsername: setter.username, count: setter.climbCount })),
    [setters],
  );

  // Only removing the picker hands its picks back, never a push on top of it.
  useEffect(() => {
    const unsubscribe = navigation.addListener('removed', () => {
      if (appliedRef.current) return;
      emitSetterFilterSelection({ handoffId, setters: selectedSettersRef.current });
    });
    // `removed` arrives after unmount. Its callback only publishes to the
    // handoff store; a mounted guard would discard the picks.
    return () => queueMicrotask(unsubscribe);
  }, [navigation, handoffId]);

  // The ref moves with each pick, so two taps before a render build on each other.
  const commitSelection = useCallback((next: string[]) => {
    selectedSettersRef.current = next;
    setSelectedSetters(next);
  }, []);
  const toggle = useCallback(
    (setterUsername: string) => {
      const current = selectedSettersRef.current;
      commitSelection(
        current.includes(setterUsername)
          ? current.filter((picked) => picked !== setterUsername)
          : [...current, setterUsername],
      );
    },
    [commitSelection],
  );
  const clear = useCallback(() => commitSelection([]), [commitSelection]);

  const handleApply = useCallback(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    emitSetterFilterSelection({ handoffId, setters: selectedSettersRef.current, apply: true });
    navigation.goBack();
  }, [navigation, handoffId]);

  useHeaderActions({
    trailing: { kind: 'forward', label: t('detail.setterPicker.showClimbs'), onPress: handleApply, prominent: true },
  });

  const formatCount = useCallback((count: number) => tClimbs('mobile.search.climbsCount', { count }), [tClimbs]);

  return (
    <SetterPickerList
      setters={pickerItems}
      isLoading={isLoading}
      onSearchChange={setSearch}
      searchPlaceholder={tClimbs('mobile.filter.searchSetters')}
      formatCount={formatCount}
      selected={selectedSetters}
      onToggle={toggle}
      onClearAll={clear}
      error={
        isError
          ? { message: t('detail.setterPicker.error'), retryLabel: t('detail.errors.tryAgain'), onRetry: refetch }
          : null
      }
      emptyLabel={tClimbs('mobile.filter.noSetters')}
    />
  );
}
