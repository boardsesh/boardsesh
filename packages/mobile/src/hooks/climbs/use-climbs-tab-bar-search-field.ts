import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { NativeStackNavigationOptions } from 'expo-router';
import type { SearchBarCommands } from 'react-native-screens';
import { visibleSearchTextNeedsSync } from '../../lib/search-name';

type SearchBarOptions = NonNullable<NativeStackNavigationOptions['headerSearchBarOptions']>;

type ClimbsTabBarSearchFieldOptions = {
  /** Climbs is the bar's search tab (`useClimbsTabBarSearch`). Off, no field. */
  enabled: boolean;
  /** Filled with the native field once it mounts; the caller focuses it on a second tab tap. */
  fieldRef: RefObject<SearchBarCommands | null>;
  placeholder: string;
  /** The committed climb name. */
  name: string;
  /** The per-board search has been restored, so `name` is this board's. */
  searchReady: boolean;
  /** The name as typed but not yet committed, else the committed one. */
  readPendingName: () => string;
  /** Debounced: commits the trimmed text after a pause. */
  onChangeText: (text: string) => void;
  /** The keyboard's Search key: commit what is typed now. */
  onSubmit: () => void;
  /** Cancel: empty the name at once. */
  onClear: () => void;
  onFocus?: () => void;
};

// How often, 50 ms apart, the field is retried while the native bar is not yet
// attached to its ref (first mount, or the tab remounting after a role change).
const SYNC_ATTEMPTS = 6;
const SYNC_RETRY_MS = 50;

/**
 * The climb-name search field the bar shows when Climbs is its search tab. iOS
 * takes the Climbs screen's `headerSearchBarOptions` controller into the tab bar,
 * so this returns those options, or `undefined` when the setting is off.
 *
 * The field and Filters' name row edit the same name. The field keeps the raw
 * text typed into it; when the name changes anywhere else (Filters, a recent
 * filter, a board switch restoring that board's search), the field is re-seeded,
 * but never while the climber is mid-typing a term of its own.
 */
export function useClimbsTabBarSearchField(options: ClimbsTabBarSearchFieldOptions): SearchBarOptions | undefined {
  const { enabled, placeholder, name, searchReady, fieldRef } = options;
  const latest = useRef(options);
  latest.current = options;
  const visibleTextRef = useRef('');

  useEffect(() => {
    if (!enabled || !searchReady) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const needsSync = () =>
      latest.current.readPendingName() === name && visibleSearchTextNeedsSync(visibleTextRef.current, name);
    const sync = () => {
      timer = null;
      if (cancelled || !needsSync()) return;
      const field = fieldRef.current;
      if (field) {
        // setText does not call onChangeText, so this never re-arms the debounce.
        field.setText(name);
        visibleTextRef.current = name;
        return;
      }
      attempts += 1;
      if (attempts < SYNC_ATTEMPTS) timer = setTimeout(sync, SYNC_RETRY_MS);
    };
    sync();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, searchReady, name, fieldRef]);

  return useMemo((): SearchBarOptions | undefined => {
    if (!enabled) return undefined;
    return {
      ref: fieldRef,
      placement: 'automatic',
      placeholder,
      autoCapitalize: 'none',
      hideWhenScrolling: false,
      obscureBackground: false,
      onChangeText: (event) => {
        const text = event.nativeEvent.text ?? '';
        visibleTextRef.current = text;
        latest.current.onChangeText(text);
      },
      onSearchButtonPress: () => {
        latest.current.onSubmit();
        fieldRef.current?.blur();
      },
      onCancelButtonPress: () => {
        visibleTextRef.current = '';
        latest.current.onClear();
        fieldRef.current?.clearText();
      },
      onFocus: () => latest.current.onFocus?.(),
    };
  }, [enabled, placeholder, fieldRef]);
}
