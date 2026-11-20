import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { SEARCH_PLACES, type SearchPlacesQueryResponse } from '@boardsesh/graphql/operations';
import { isPlaceSearchQuery, PLACE_SEARCH_DEBOUNCE_MS, placeSuggestionLabel } from '@boardsesh/gym-filters';
import { getHttpClient } from '../../lib/graphql/client';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { GymSearchFieldProps } from './GymSearchField.types';

type PlaceLookup = {
  query: string;
  status: 'ready' | 'error';
  suggestions: PlaceSuggestion[];
};

/** Browser city search uses our gazetteer, independently of GPS permission. */
export function GymSearchField({
  text,
  hasSelectedPlace,
  onChangeText,
  onSubmit,
  onSelectPlace,
  onClear,
}: GymSearchFieldProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const listId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [lookup, setLookup] = useState<PlaceLookup | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = text.trim();
  const canSearch = !hasSelectedPlace && isPlaceSearchQuery(query);
  const currentLookup = canSearch && lookup?.query === query ? lookup : null;
  const suggestions = currentLookup?.suggestions ?? [];
  const showSuggestions = isOpen && suggestions.length > 0;
  const activePlace = showSuggestions ? suggestions[activeIndex] : undefined;

  useEffect(() => {
    if (!canSearch) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await getHttpClient().request<SearchPlacesQueryResponse>({
          document: SEARCH_PLACES,
          variables: { query },
          signal: controller.signal,
        });
        if (!controller.signal.aborted)
          setLookup({ query, status: 'ready', suggestions: response.searchPlaces.slice(0, 5) });
      } catch {
        if (!controller.signal.aborted) setLookup({ query, status: 'error', suggestions: [] });
      }
    }, PLACE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canSearch, query]);

  const selectPlace = (place: PlaceSuggestion) => {
    setIsOpen(false);
    setActiveIndex(-1);
    onSelectPlace(place);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsOpen(false);
      setActiveIndex(-1);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length > 0) {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((previous) =>
        event.key === 'ArrowDown'
          ? (previous + 1) % suggestions.length
          : (previous <= 0 ? suggestions.length : previous) - 1,
      );
    }
  };

  const foreground = systemColors.label as string;
  const secondary = systemColors.secondaryLabel as string;
  const surface = systemColors.background as string;
  const separator = systemColors.separator as string;
  const accent = brandColors.primary as string;
  const buttonStyle: CSSProperties = {
    background: surface,
    border: `1px solid ${separator}`,
    borderRadius: borderRadius.lg,
    color: foreground,
    cursor: 'pointer',
    font: 'inherit',
    minHeight: 44,
    padding: `${spacing[2]}px ${spacing[3]}px`,
  };
  const status =
    canSearch && !currentLookup
      ? t('mobile.gyms.placesLoading')
      : currentLookup?.status === 'error'
        ? t('mobile.gyms.placesError')
        : currentLookup && suggestions.length === 0
          ? t('mobile.gyms.placesEmpty')
          : t('mobile.gyms.placesHint');

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        if (activePlace) selectPlace(activePlace);
        else {
          setIsOpen(false);
          onSubmit();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
      }}
      style={{ width: '100%' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing[2] }}>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          value={text}
          aria-label={t('mobile.gyms.searchPlaceholder')}
          placeholder={t('mobile.gyms.searchPlaceholder')}
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={activePlace ? `${listId}-${activePlace.id}` : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          enterKeyHint="search"
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setActiveIndex(-1);
            setIsOpen(true);
            onChangeText(event.currentTarget.value);
          }}
          onKeyDown={handleKeyDown}
          style={{ ...buttonStyle, flex: '1 1 180px', minWidth: 0, cursor: 'text' }}
        />
        {text.length > 0 || hasSelectedPlace ? (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              setIsOpen(false);
              setActiveIndex(-1);
              onClear();
              inputRef.current?.focus();
            }}
          >
            {t('mobile.gyms.clearSearch')}
          </button>
        ) : null}
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            setIsOpen(false);
            setActiveIndex(-1);
            onSubmit();
          }}
        >
          {t('mobile.gyms.searchSubmit')}
        </button>
      </div>
      {showSuggestions ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('mobile.gyms.placesLabel')}
          style={{
            listStyle: 'none',
            margin: `${spacing[1]}px 0`,
            padding: 0,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {suggestions.map((place, index) => (
            <li key={place.id} role="presentation">
              <button
                id={`${listId}-${place.id}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectPlace(place)}
                style={{
                  ...buttonStyle,
                  width: '100%',
                  textAlign: 'left',
                  borderColor: activeIndex === index ? accent : separator,
                }}
              >
                {placeSuggestionLabel(place)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div id={statusId} role="status" aria-live="polite" style={{ color: secondary, marginTop: spacing[1] }}>
        {status}
      </div>
      <a href="https://www.geonames.org/" target="_blank" rel="noreferrer" style={{ color: accent }}>
        {t('mobile.gyms.placesAttribution')}
      </a>
    </form>
  );
}
