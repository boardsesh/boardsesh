// "Add your gym": the add-a-board wizard's step for a gym that isn't listed.
// The climber names it and puts a pin on it, then goes on to its board. One
// page inside the Boards sheet, shaped like Which gym? (`GymStep`): a pinned
// header block (the step counter, the title, the name and the search field),
// then `MapCardList`, whose map card holds the pin, with Save pinned at the
// bottom.
//
// - The pin is the centre of the map: a fixed marker the climber moves the map
//   under. It starts at the device fix when location was already allowed (no
//   prompt on open; "Use my location" asks), or at a town picked from the
//   search's suggestions, or an address typed and submitted. Zoomed out past a
//   town, the centre means nowhere, so there is no pin until they zoom in.
// - Where the map can't draw (a browser, a broken native map) the card folds
//   away and the pin is the device fix, a town or a geocoded address, and the
//   line under the field says where the gym will go.
// - As the name and the pin settle, the gyms already listed nearby that look
//   like it are asked about ("Is it one of these?"). A tap on one goes to its
//   boards; Claim opens its page; "No, add a new gym" says none is.
// - Save sends the gyms the climber said are not theirs. The server checks
//   again and refuses with the ones it still finds (`GYM_SIMILAR_EXISTS`):
//   they join the same list, and "No, add a new gym" then saves straight away.
//   The per-account gym cap (`GYM_LIMIT_REACHED`) says so under the form.
//
// The created gym goes to the caller, which moves the wizard on.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { gymCreated } from '@boardsesh/analytics';
import { isGymLimitError, readSimilarGymsError } from '@boardsesh/graphql/errors';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';
import type { Gym, PlaceSuggestion, SimilarGym } from '@boardsesh/shared-schema';
import { useCreateGym, useSimilarGyms } from '../../../lib/graphql/hooks/use-create-gym';
import { useDeviceLocation, type Coords } from '../../../lib/use-device-location';
import { useGeocodePlace } from '../../../lib/use-place-search';
import { selectEffectiveOffline, useConnectivityField } from '../../../lib/connectivity/use-connectivity';
import { canOpenAppSettings, openAppSettings } from '../../../lib/open-app-settings';
import { track } from '../../../lib/analytics';
import { useTransparentHeaderInset } from '../../../hooks/use-transparent-header-inset';
import { useAuth } from '../../../providers/auth-provider';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { Text } from '../../Text';
import { Button } from '../../Button';
import { ActivityIndicator } from '../../ActivityIndicator';
import { PressableSurface } from '../../PressableSurface';
import { READABLE_CONTENT_WIDTH } from '../../ReadableColumn';
import { GymMap, type GymMapHandle } from '../../gym-directory/GymMap';
import { MapCardList, type MapCardListHandle } from '../../gym-directory/MapCardList';
import { GymSearchField } from '../../gym-directory/GymSearchField';
import { GymListEmptyRow, GymListSectionHeader } from '../../gym-directory/GymListTextRows';
import { PickPlaceRow } from '../../gym-directory/PickGymRow';
import { WizardStepHeader } from '../add-board-wizard/WizardStepHeader';
import { NewGymTextField } from './NewGymTextField';
import { SimilarGymRow } from './SimilarGymRow';
import {
  ADDRESS_ROW_KEY,
  GYM_ADDRESS_MAX_LENGTH,
  GYM_NAME_MAX_LENGTH,
  SIMILAR_HEADER_KEY,
  acknowledgeGyms,
  buildCreateGymInput,
  buildNewGymRows,
  canSaveGym,
  pinCaptionFor,
  savableGymName,
  similarGymsLookupInput,
  similarGymsToAsk,
  type GymPin,
  type NewGymRow,
} from './new-gym-step-state';

export type NewGymStepProps = {
  /** "Step 3 of 4" above the title. */
  stepLabel: string | null;
  /** A listed gym was tapped: it is this one. */
  onPickExistingGym: (gymUuid: string) => void;
  /** Claim on a listed gym: its page, where the claim lives. */
  onClaimGym: (gymUuid: string) => void;
  /** The gym was created. Called once. */
  onCreated: (gym: Gym) => void;
  /** Save tapped while signed out. */
  onSignInNeeded: () => void;
};

/** The zoom the camera flies to for a pin: a few streets across, so the gym's door can be found. */
const PIN_ZOOM = 16;
/** A picked town opens a little wider: its centre is rarely the gym. */
const TOWN_ZOOM = 13;
/** Zoomed out past this, the map's centre is a region, not a place. */
const PIN_MIN_ZOOM = 11;
/** How close (degrees, about 50 m) a camera report must be to a move we made to be its settle. */
const SETTLE_TOLERANCE_DEG = 0.0005;
/** How long a move we made may report frames far from its target before a report counts as a pan. */
const PROGRAMMATIC_MOVE_MS = 1500;
/** A pan reports many frames; the pin follows once it is still for this long. */
const PIN_SETTLE_MS = 250;
/** The "is it one of these?" lookup waits for the name and pin to be still this long. */
const SIMILAR_LOOKUP_DEBOUNCE_MS = 500;
/** The keyboard's rise before the address row is scrolled clear of it. */
const ADDRESS_SCROLL_DELAY_MS = 300;

const NO_MARKERS: [] = [];
const NO_PLACES: readonly PlaceSuggestion[] = [];
const NO_ACKNOWLEDGED: readonly string[] = [];

const rowKey = (row: NewGymRow) => row.key;
const rowType = (row: NewGymRow) => row.kind;

type FocusedField = 'name' | 'address' | null;

function nearTarget(coords: Coords, target: Coords): boolean {
  return (
    Math.abs(coords.latitude - target.latitude) < SETTLE_TOLERANCE_DEG &&
    Math.abs(coords.longitude - target.longitude) < SETTLE_TOLERANCE_DEG
  );
}

export function NewGymStep({ stepLabel, onPickExistingGym, onClaimGym, onCreated, onSignInNeeded }: NewGymStepProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const offline = useConnectivityField(selectEffectiveOffline);
  const headerInset = useTransparentHeaderInset();
  const mapRef = useRef<GymMapHandle>(null);
  const listRef = useRef<MapCardListHandle>(null);
  const createGym = useCreateGym();
  const { geocode, isGeocoding } = useGeocodePlace();

  // --- the fields ---
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  // The address the climber typed is theirs: a later search never replaces it.
  const addressEditedRef = useRef(false);
  const [searchText, setSearchText] = useState('');
  const [placeSuggestions, setPlaceSuggestions] = useState<readonly PlaceSuggestion[]>(NO_PLACES);
  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  // As on Which gym?: the map card folds while the search is in use, so the
  // keyboard never covers the towns, and comes back on a pick or a clear.
  const [searchFolded, setSearchFolded] = useState(false);

  // --- the pin ---
  const [pin, setPin] = useState<GymPin | null>(null);
  // The pin as of the last camera report, ahead of the state that follows it
  // once the pan is still: Save reads this one.
  const pinRef = useRef<GymPin | null>(null);
  const [zoomedOut, setZoomedOut] = useState(false);
  // The town picked or the address searched, for the line under the map.
  const [placeLabel, setPlaceLabel] = useState<string | null>(null);
  const [placeNotFound, setPlaceNotFound] = useState(false);
  const programmaticMoveRef = useRef<{ target: Coords; issuedAtMs: number } | null>(null);
  // The map has been flown somewhere: until then its centre is the world view's.
  const mapCenteredRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    },
    [],
  );

  // The gyms a refused save named. A changed name or pin is a new question,
  // so either clears them: the lookup asks again.
  const [refused, setRefused] = useState<readonly SimilarGym[] | null>(null);

  const placePin = useCallback((next: GymPin, zoom: number) => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    pinRef.current = next;
    setPin(next);
    setRefused(null);
    setZoomedOut(false);
    const target = { latitude: next.latitude, longitude: next.longitude };
    programmaticMoveRef.current = { target, issuedAtMs: Date.now() };
    mapCenteredRef.current = true;
    mapRef.current?.setCenter(target, zoom);
  }, []);

  // --- location: read on open, asked only from "Use my location" ---
  const location = useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: true });
  const { requestIfAllowed, request: requestLocation, coords: deviceCoords } = location;
  useEffect(() => {
    void requestIfAllowed();
  }, [requestIfAllowed]);
  const deviceCoordsRef = useRef(deviceCoords);
  deviceCoordsRef.current = deviceCoords;
  const locateRequestedRef = useRef(false);
  // A fix starts the pin when nothing else has; after "Use my location" it
  // moves the pin there whatever was chosen before.
  useEffect(() => {
    if (!deviceCoords) return;
    const asked = locateRequestedRef.current;
    locateRequestedRef.current = false;
    if (!asked && pinRef.current !== null) return;
    placePin({ ...deviceCoords, source: 'device' }, PIN_ZOOM);
  }, [deviceCoords, placePin]);
  useEffect(() => {
    if (location.status === 'denied' || location.status === 'unavailable') locateRequestedRef.current = false;
  }, [location.status]);

  const permissionRef = useRef(location.permission);
  permissionRef.current = location.permission;
  const onUseMyLocation = useCallback(() => {
    const coords = deviceCoordsRef.current;
    if (coords) {
      placePin({ ...coords, source: 'device' }, PIN_ZOOM);
      return;
    }
    if (permissionRef.current === 'blocked') {
      if (canOpenAppSettings()) void openAppSettings();
      return;
    }
    locateRequestedRef.current = true;
    void requestLocation();
  }, [placePin, requestLocation]);

  // --- the map: its centre is the pin ---
  const onRegionChange = useCallback((coords: Coords, zoom?: number) => {
    const programmaticMove = programmaticMoveRef.current;
    if (programmaticMove) {
      // Our own move settling (the pin is already there), or one of its
      // animation frames: neither is the climber's pan.
      if (nearTarget(coords, programmaticMove.target)) {
        programmaticMoveRef.current = null;
        return;
      }
      if (Date.now() - programmaticMove.issuedAtMs < PROGRAMMATIC_MOVE_MS) return;
      programmaticMoveRef.current = null;
    }
    const meansAPlace = zoom !== undefined ? zoom >= PIN_MIN_ZOOM : mapCenteredRef.current;
    const next: GymPin | null = meansAPlace ? { ...coords, source: 'map' } : null;
    if (meansAPlace) mapCenteredRef.current = true;
    pinRef.current = next;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setPin(next);
      setRefused(null);
      setZoomedOut(next === null);
    }, PIN_SETTLE_MS);
  }, []);

  // A browser has no native map: start folded there, so no empty card flashes.
  const [mapAvailable, setMapAvailable] = useState(Platform.OS !== 'web');
  const [mapAttempt, setMapAttempt] = useState(0);
  const [mapOpeningCenter, setMapOpeningCenter] = useState<Coords | null>(null);
  const handleMapUnavailable = useCallback(() => setMapAvailable(false), []);
  const handleMapReady = useCallback(() => setMapAvailable(true), []);
  const retryMap = useCallback(() => {
    const current = pinRef.current;
    setMapAvailable(true);
    setMapOpeningCenter(current ? { latitude: current.latitude, longitude: current.longitude } : null);
    mapCenteredRef.current = current !== null;
    setMapAttempt((attempt) => attempt + 1);
  }, []);

  const mapElement = useMemo(
    () => (
      <>
        <GymMap
          key={mapAttempt}
          ref={mapRef}
          center={mapOpeningCenter}
          zoom={PIN_ZOOM}
          markers={NO_MARKERS}
          onRegionChange={onRegionChange}
          onMapUnavailable={handleMapUnavailable}
          onMapReady={handleMapReady}
          style={StyleSheet.absoluteFill}
        />
        {/* The pin: the map's centre, which the climber moves the map under. */}
        <View pointerEvents="none" style={styles.pinLayer} testID="new-gym-pin">
          <View
            style={[styles.pinDot, { backgroundColor: brandColors.primary, borderColor: systemColors.background }]}
          />
        </View>
      </>
    ),
    [
      mapAttempt,
      mapOpeningCenter,
      onRegionChange,
      handleMapUnavailable,
      handleMapReady,
      brandColors.primary,
      systemColors.background,
    ],
  );

  // --- the search: a town or an address moves the map ---
  const onChangeSearchText = useCallback((text: string) => {
    setSearchText(text);
    setPlaceNotFound(false);
  }, []);
  const seedAddress = useCallback((text: string) => {
    if (!addressEditedRef.current) setAddress(text.slice(0, GYM_ADDRESS_MAX_LENGTH));
  }, []);
  const onSelectPlace = useCallback(
    (place: PlaceSuggestion) => {
      const label = placeSuggestionLabel(place);
      Keyboard.dismiss();
      setSearchFolded(false);
      setSearchText(label);
      setPlaceLabel(label);
      setPlaceNotFound(false);
      seedAddress(label);
      listRef.current?.scrollToTop();
      placePin({ latitude: place.latitude, longitude: place.longitude, source: 'town' }, TOWN_ZOOM);
    },
    [placePin, seedAddress],
  );
  const searchTextRef = useRef(searchText);
  searchTextRef.current = searchText;
  const onSubmitSearch = useCallback(() => {
    const text = searchTextRef.current.trim();
    if (!text) return;
    void geocode(text).then((coords) => {
      // The text changed while it was looked up: that answer is for old text.
      if (searchTextRef.current.trim() !== text) return;
      if (!coords) {
        setPlaceNotFound(true);
        return;
      }
      Keyboard.dismiss();
      setSearchFolded(false);
      setPlaceLabel(text);
      setPlaceNotFound(false);
      seedAddress(text);
      listRef.current?.scrollToTop();
      placePin({ ...coords, source: 'address' }, PIN_ZOOM);
    });
  }, [geocode, placePin, seedAddress]);
  const onClearSearch = useCallback(() => {
    setSearchText('');
    setPlaceNotFound(false);
    setSearchFolded(false);
  }, []);
  const onSearchFocusChange = useCallback((focused: boolean) => {
    if (focused) {
      setSearchFolded(true);
      listRef.current?.scrollToTop();
      return;
    }
    if (searchTextRef.current.trim().length === 0) setSearchFolded(false);
  }, []);

  // --- the name and the address ---
  const nameRef = useRef(name);
  nameRef.current = name;
  const addressRef = useRef(address);
  addressRef.current = address;
  const [notice, setNotice] = useState<string | null>(null);
  const onChangeName = useCallback((text: string) => {
    setName(text);
    setRefused(null);
    setNotice(null);
  }, []);
  const onChangeAddress = useCallback((text: string) => {
    addressEditedRef.current = true;
    setAddress(text);
  }, []);
  const onNameFocusChange = useCallback((focused: boolean) => {
    setFocusedField((current) => (focused ? 'name' : current === 'name' ? null : current));
  }, []);
  const onAddressFocusChange = useCallback((focused: boolean) => {
    setFocusedField((current) => (focused ? 'address' : current === 'address' ? null : current));
    if (!focused) return;
    // Clear of the keyboard once it is up (the map card folds meanwhile).
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      listRef.current?.scrollToItemKey(ADDRESS_ROW_KEY);
    }, ADDRESS_SCROLL_DELAY_MS);
  }, []);

  // --- "Is it one of these?" ---
  const [acknowledged, setAcknowledged] = useState<readonly string[]>(NO_ACKNOWLEDGED);
  const acknowledgedRef = useRef(acknowledged);
  acknowledgedRef.current = acknowledged;
  const lookupNow = similarGymsLookupInput(name, pin);
  const lookupKey = lookupNow ? `${lookupNow.name}|${lookupNow.latitude ?? ''}|${lookupNow.longitude ?? ''}` : '';
  const lookupNowRef = useRef(lookupNow);
  lookupNowRef.current = lookupNow;
  const [lookupInput, setLookupInput] = useState(lookupNow);
  useEffect(() => {
    const timer = setTimeout(() => setLookupInput(lookupNowRef.current), SIMILAR_LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lookupKey]);
  const similarQuery = useSimilarGyms(lookupInput, { enabled: isAuthenticated && !offline });
  const lookupGyms = lookupInput ? similarQuery.data : undefined;
  const similar = useMemo(
    () => similarGymsToAsk(lookupGyms, refused, acknowledged),
    [lookupGyms, refused, acknowledged],
  );
  // Every listed gym the climber was shown, for `Gym Created`'s `similarShown`.
  const shownSimilarRef = useRef(new Set<string>());
  useEffect(() => {
    for (const gym of similar) shownSimilarRef.current.add(gym.uuid);
  }, [similar]);

  // --- Save ---
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const { mutateAsync: createGymAsync } = createGym;
  const save = useCallback(
    async (acknowledgedGymUuids: readonly string[]) => {
      if (!isAuthenticated) {
        onSignInNeeded();
        return;
      }
      const savedName = savableGymName(nameRef.current);
      const savedPin = pinRef.current;
      if (!savedName || !savedPin || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setNotice(null);
      Keyboard.dismiss();
      const input = buildCreateGymInput({
        name: savedName,
        pin: savedPin,
        address: addressRef.current,
        acknowledged: acknowledgedGymUuids,
      });
      try {
        const gym = await createGymAsync(input);
        const event = gymCreated({
          surface: 'wizard',
          similarShown: shownSimilarRef.current.size,
          confirmedSeparate: acknowledgedGymUuids.length > 0,
          hasAddress: input.address !== undefined,
          locationSource: savedPin.source,
        });
        track(event.name, event.properties);
        // Stays "submitting": the caller moves on, and a second tap must
        // never add the gym twice.
        onCreated(gym);
        return;
      } catch (error) {
        submittingRef.current = false;
        setSubmitting(false);
        const refusedGyms = readSimilarGymsError(error);
        if (refusedGyms && similarGymsToAsk(undefined, refusedGyms, acknowledgedGymUuids).length > 0) {
          setRefused(refusedGyms);
          return;
        }
        setNotice(isGymLimitError(error) ? t('mobile.newGym.limitReached') : t('mobile.newGym.saveFailed'));
      }
    },
    [isAuthenticated, onSignInNeeded, createGymAsync, onCreated, t],
  );
  const onSave = useCallback(() => void save(acknowledgedRef.current), [save]);
  // "No, add a new gym": none of the gyms shown is theirs. After a refused
  // save it saves again at once, naming every gym shown so far.
  const refusedRef = useRef(refused);
  refusedRef.current = refused;
  const similarRef = useRef(similar);
  similarRef.current = similar;
  const onAddNew = useCallback(() => {
    const next = acknowledgeGyms(
      acknowledgedRef.current,
      similarRef.current.map((gym) => gym.uuid),
    );
    const wasRefused = refusedRef.current !== null;
    acknowledgedRef.current = next;
    setAcknowledged(next);
    setRefused(null);
    if (wasRefused) void save(next);
  }, [save]);
  // A refusal brings its gyms into view.
  useEffect(() => {
    if (refused) listRef.current?.scrollToItemKey(SIMILAR_HEADER_KEY);
  }, [refused]);

  // --- the rows ---
  const rows = useMemo(
    () =>
      buildNewGymRows({
        places: {
          suggestions: placeSuggestions,
          label: t('mobile.gymStep.places'),
          // The browser's field carries its own GeoNames link.
          attribution: Platform.OS === 'web' ? null : t('mobile.gyms.placesAttribution'),
        },
        similar,
        notice,
        labels: {
          similarTitle: t('mobile.newGym.similarTitle'),
          similarBody: refused ? t('mobile.newGym.similarRefusedBody') : t('mobile.newGym.similarBody'),
        },
      }),
    [placeSuggestions, similar, notice, refused, t],
  );

  const caption = pinCaptionFor({ pin, mapAvailable, zoomedOut, deviceCoords, placeLabel });
  let captionText: string;
  switch (caption.kind) {
    case 'needed':
      captionText = t('mobile.newGym.pinNeeded');
      break;
    case 'zoomIn':
      captionText = t('mobile.newGym.pinZoomIn');
      break;
    case 'atYou':
      captionText = t('mobile.newGym.pinAtYou');
      break;
    case 'fromYou':
      captionText = t('mobile.newGym.pinFromYou', { distance: caption.distance });
      break;
    case 'nearPlace':
      captionText = t('mobile.newGym.pinNearPlace', { place: caption.place });
      break;
    case 'set':
      captionText = t('mobile.newGym.pinSet');
      break;
    case 'fallbackNeeded':
      captionText = t('mobile.newGym.fallbackNeeded');
      break;
    case 'fallbackYou':
      captionText = t('mobile.newGym.fallbackYou');
      break;
    case 'fallbackPlace':
      captionText = t('mobile.newGym.fallbackPlace', { place: caption.place });
      break;
  }
  // Moving the map is how the pin is placed: say so once there is one.
  const showMoveHint = mapAvailable && pin !== null;
  const showMapUnavailable = !mapAvailable && Platform.OS !== 'web';
  const locating = location.status === 'loading';
  const pinRow = useMemo(
    () => (
      <View style={styles.pinRow} testID="new-gym-pin-row">
        <Text variant="subheadline" accessibilityLiveRegion="polite" testID="new-gym-pin-caption">
          {captionText}
        </Text>
        {showMoveHint ? (
          <Text variant="footnote" tone="secondary">
            {t('mobile.newGym.pinMoveHint')}
          </Text>
        ) : null}
        {placeNotFound ? (
          <Text variant="footnote" color={systemColors.error} accessibilityLiveRegion="polite">
            {t('mobile.newGym.placeNotFound')}
          </Text>
        ) : null}
        <View style={styles.pinActions}>
          {pin?.source !== 'device' ? (
            <PressableSurface
              onPress={onUseMyLocation}
              accessibilityRole="button"
              hitSlop={8}
              testID="new-gym-use-location"
            >
              <Text variant="subheadline" color={systemColors.accent}>
                {t('mobile.gyms.grantLocation')}
              </Text>
            </PressableSurface>
          ) : null}
          {locating ? <ActivityIndicator /> : null}
          {showMapUnavailable ? (
            <PressableSurface onPress={retryMap} accessibilityRole="button" hitSlop={8}>
              <Text variant="subheadline" color={systemColors.accent}>
                {t('mobile.gyms.retryMap')}
              </Text>
            </PressableSurface>
          ) : null}
        </View>
      </View>
    ),
    [
      captionText,
      showMoveHint,
      placeNotFound,
      pin?.source,
      locating,
      showMapUnavailable,
      onUseMyLocation,
      retryMap,
      t,
      systemColors.error,
      systemColors.accent,
    ],
  );

  const addressRow = useMemo(
    () => (
      <View style={styles.gutter}>
        <NewGymTextField
          label={t('mobile.newGym.addressLabel')}
          showLabel
          value={address}
          placeholder={t('mobile.newGym.addressPlaceholder')}
          maxLength={GYM_ADDRESS_MAX_LENGTH}
          onChangeText={onChangeAddress}
          onFocusChange={onAddressFocusChange}
          autoCapitalize="sentences"
          testID="new-gym-address"
        />
      </View>
    ),
    [address, onChangeAddress, onAddressFocusChange, t],
  );

  const addNewRow = useMemo(
    () => (
      <View style={styles.addNew}>
        <Button
          title={t('similarGyms.refusal.addNew')}
          onPress={onAddNew}
          variant="tonal"
          size="medium"
          disabled={submitting}
        />
      </View>
    ),
    [onAddNew, submitting, t],
  );

  const renderRow = useCallback(
    ({ item }: { item: NewGymRow }) => {
      switch (item.kind) {
        case 'sectionHeader':
          return (
            <View style={styles.gutter}>
              <GymListSectionHeader label={item.label} />
            </View>
          );
        case 'place':
          return (
            <PickPlaceRow
              place={item.place}
              label={placeSuggestionLabel(item.place)}
              position={item.position}
              onSelectPlace={onSelectPlace}
            />
          );
        case 'placesAttribution':
          return (
            <Text variant="caption2" tone="secondary" style={styles.attribution}>
              {item.label}
            </Text>
          );
        case 'pin':
          return pinRow;
        case 'similarIntro':
          return (
            <Text variant="subheadline" tone="secondary" style={styles.intro}>
              {item.label}
            </Text>
          );
        case 'similarGym':
          return (
            <SimilarGymRow
              gym={item.gym}
              subtitle={item.subtitle}
              position={item.position}
              onPickGym={onPickExistingGym}
              onClaimGym={onClaimGym}
            />
          );
        case 'addNew':
          return addNewRow;
        case 'address':
          return addressRow;
        case 'notice':
          return (
            <View style={styles.gutter}>
              <GymListEmptyRow label={item.label} />
            </View>
          );
      }
    },
    [onSelectPlace, pinRow, onPickExistingGym, onClaimGym, addNewRow, addressRow],
  );

  const saveEnabled = canSaveGym(name, pin);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          title={t('mobile.newGym.save')}
          onPress={onSave}
          disabled={!saveEnabled || submitting}
          loading={submitting}
          size="large"
        />
        {!saveEnabled ? (
          <Text variant="footnote" tone="secondary" style={styles.footerHint}>
            {t('mobile.newGym.saveHint')}
          </Text>
        ) : null}
      </View>
    ),
    [onSave, saveEnabled, submitting, t],
  );

  return (
    <View
      style={[styles.screen, { backgroundColor: systemColors.groupedBackground, paddingTop: headerInset }]}
      testID="new-gym-step"
    >
      <View style={styles.headerBlock}>
        <WizardStepHeader stepLabel={stepLabel} title={t('mobile.newGym.title')} />
        <View style={styles.fields}>
          <NewGymTextField
            label={t('mobile.newGym.nameLabel')}
            value={name}
            placeholder={t('mobile.newGym.namePlaceholder')}
            maxLength={GYM_NAME_MAX_LENGTH}
            onChangeText={onChangeName}
            onFocusChange={onNameFocusChange}
            testID="new-gym-name"
          />
          <GymSearchField
            text={searchText}
            hasSelectedPlace={placeLabel !== null && searchText === placeLabel}
            isGeocoding={isGeocoding}
            placeholder={t('mobile.newGym.searchPlaceholder')}
            onChangeText={onChangeSearchText}
            onSubmit={onSubmitSearch}
            onSelectPlace={onSelectPlace}
            onClear={onClearSearch}
            onFocusChange={onSearchFocusChange}
            suggestionsPlacement="inline"
            onSuggestionsChange={setPlaceSuggestions}
          />
        </View>
      </View>
      <MapCardList
        ref={listRef}
        data={rows}
        renderItem={renderRow}
        keyExtractor={rowKey}
        getItemType={rowType}
        map={mapElement}
        mapAvailable={mapAvailable}
        mapHidden={searchFolded || focusedField !== null}
        onLocate={onUseMyLocation}
        locateLabel={t('mobile.gyms.grantLocation')}
        footer={footer}
        testID="new-gym-list"
      />
    </View>
  );
}

const PIN_DOT_SIZE = 18;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  // Pinned under the bar; wide windows keep the readable column, as the list does.
  headerBlock: {
    width: '100%',
    maxWidth: READABLE_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
    gap: spacing[3],
  },
  fields: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  pinLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinDot: {
    width: PIN_DOT_SIZE,
    height: PIN_DOT_SIZE,
    borderRadius: PIN_DOT_SIZE / 2,
    borderWidth: 3,
  },
  pinRow: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
    gap: spacing[1],
  },
  pinActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[4],
    rowGap: spacing[1],
    paddingTop: spacing[1],
  },
  gutter: {
    paddingHorizontal: spacing[4],
  },
  intro: {
    paddingHorizontal: spacing[6],
    paddingBottom: spacing[2],
  },
  attribution: {
    paddingHorizontal: spacing[6],
    paddingTop: spacing[1],
  },
  addNew: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  footer: {
    paddingHorizontal: spacing[4],
    gap: spacing[1],
  },
  footerHint: {
    textAlign: 'center',
  },
});
