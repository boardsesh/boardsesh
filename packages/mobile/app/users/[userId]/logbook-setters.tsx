import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { MAX_LOGBOOK_SETTER_FILTERS } from '@boardsesh/logbook';
import { SetterPickerList, type SetterPickerItem } from '../../../src/components/filter-sheet/SetterPickerList';
import { useHeaderActions } from '../../../src/hooks/use-header-actions';
import { useUserLoggedSetters } from '../../../src/lib/graphql/hooks/use-user-logged-setters';
import { emitLogbookSetterSelection } from '../../../src/lib/logbook-setter-handoff';

type Params = {
  userId: string;
  /** The Logbook's current picks (JSON array of usernames). */
  setters?: string;
  /** The Logbook's Board filter: the picker lists setters on that board only. */
  boardType?: string;
  /** JSON array of layout ids within `boardType`. */
  layoutIds?: string;
  /** Which mounted Logbook gets the picks back (see logbook-setter-handoff.ts). */
  handoffId?: string;
};

function parseJsonArray<Item>(serialized: string | undefined, isItem: (value: unknown) => value is Item): Item[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed.filter(isItem) : [];
  } catch {
    return [];
  }
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isLayoutId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/**
 * The Logbook's setter filter: the setters of climbs this climber has logged,
 * most-logged first, as a multi-select. A pushed route rather than a stacked
 * sheet (native sheets can't stack); the filter sheet suspends while it is on
 * top, and the capsule row pushes it directly. It lives beside the public
 * profile and is mirrored into every tab's stack, so it opens from your own
 * You tab and from anyone's profile in any tab (docs/mobile-sheets-vs-routes.md).
 *
 * Two ways out: "Show climbs" hands the picks back and returns to the list;
 * the back chevron or swipe-back hands them back too, and a suspended filter
 * sheet comes back with them applied.
 */
export default function LogbookSettersScreen() {
  const params = useLocalSearchParams<Params>();
  const navigation = useNavigation();
  const { t } = useTranslation('you');
  const { t: tClimbs } = useTranslation('climbs');

  const handoffId = params.handoffId ?? '';
  const scope = useMemo(
    () => ({ boardType: params.boardType ?? '', layoutIds: parseJsonArray(params.layoutIds, isLayoutId) }),
    [params.boardType, params.layoutIds],
  );
  const [selectedSetters, setSelectedSetters] = useState<string[]>(() =>
    parseJsonArray(params.setters, isString).slice(0, MAX_LOGBOOK_SETTER_FILTERS),
  );
  const selectedSettersRef = useRef(selectedSetters);
  selectedSettersRef.current = selectedSetters;
  const [limitReached, setLimitReached] = useState(false);
  // Set once "Show climbs" has handed the picks back, so the removal that
  // follows doesn't hand them back a second time.
  const appliedRef = useRef(false);

  const [search, setSearch] = useState('');
  const { setters, isLoading, isError, refetch } = useUserLoggedSetters(params.userId, scope, search);
  const pickerItems = useMemo<SetterPickerItem[] | undefined>(
    () => setters?.map((setter) => ({ setterUsername: setter.setterUsername, count: setter.tickCount })),
    [setters],
  );

  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      headerTransparent: false,
      headerBlurEffect: undefined,
      title: t('mobile.logbook.setterPicker.title'),
    });
  }, [navigation, t]);

  // Only removing the picker hands its picks back, never a push on top of it.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        if (appliedRef.current) return;
        emitLogbookSetterSelection({ handoffId, setterUsernames: selectedSettersRef.current, apply: false });
      }),
    [navigation, handoffId],
  );

  // The ref moves with each pick, so two taps before a render build on each other.
  const commitSelection = useCallback((next: string[]) => {
    selectedSettersRef.current = next;
    setSelectedSetters(next);
  }, []);

  const toggle = useCallback(
    (setterUsername: string) => {
      const current = selectedSettersRef.current;
      if (current.includes(setterUsername)) {
        setLimitReached(false);
        commitSelection(current.filter((picked) => picked !== setterUsername));
        return;
      }
      if (current.length >= MAX_LOGBOOK_SETTER_FILTERS) {
        setLimitReached(true);
        return;
      }
      commitSelection([...current, setterUsername]);
    },
    [commitSelection],
  );

  const clear = useCallback(() => {
    setLimitReached(false);
    commitSelection([]);
  }, [commitSelection]);

  const handleApply = useCallback(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    emitLogbookSetterSelection({ handoffId, setterUsernames: selectedSettersRef.current, apply: true });
    navigation.goBack();
  }, [navigation, handoffId]);

  useHeaderActions({
    trailing: {
      kind: 'forward',
      label: t('mobile.logbook.setterPicker.showResults'),
      onPress: handleApply,
      prominent: true,
    },
  });

  const formatCount = useCallback((count: number) => t('mobile.logbook.setterPicker.tickCount', { count }), [t]);

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
      notice={limitReached ? t('mobile.logbook.setterPicker.limit', { count: MAX_LOGBOOK_SETTER_FILTERS }) : undefined}
      error={
        isError
          ? { message: t('mobile.logbook.setterPicker.error'), retryLabel: t('mobile.logbook.retry'), onRetry: refetch }
          : null
      }
      emptyLabel={t('mobile.logbook.setterPicker.empty')}
    />
  );
}
