'use client';

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import MuiLink from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type {
  CncArtworkKind,
  CncCatalog,
  CncCatalogEntry,
  CncLicenceTier,
  CncOrder,
  CncOrderStatus,
} from '@boardsesh/shared-schema';
import {
  cncArtworkPlaced,
  cncBuildPlansPageViewed,
  cncConfiguratorChanged,
  cncCheckoutStarted,
  cncPreviewRequested,
  type CncConfigProps,
  type CncConfiguratorStep,
} from '@boardsesh/analytics';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { trackCncFunnelEvent } from '@/app/lib/cnc-funnel-analytics';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import {
  FieldGrid,
  KeyValueList,
  PageSection,
  PreviewGallery,
  PriceTag,
  SectionCard,
  SplitLayout,
  StatusChip,
  StepHeading,
  type KeyValueItem,
} from '../ui';
import styles from '../build-plans.module.css';
import {
  CNC_CONFIGURATOR_DRAFT_KEY,
  CNC_FALLBACK_ARTWORK_FONT,
  configKey,
  configuratorReducer,
  engraveOptions,
  finaliseBlockers,
  findEntry,
  formatPrice,
  fromDraft,
  hasKickerSets,
  initialConfiguratorState,
  isPreviewStale,
  optionValueKey,
  tierPrice,
  isArtworkLocallyValid,
  isArtworkReady,
  newArtworkItem,
  toBoardConfigInput,
  toDraft,
  visibleMachiningOptions,
  type CncArtworkDraft,
  type CncConfiguratorState,
} from './configurator-state';
import type { CncLayoutPanel, CncLayoutSummary } from './layout-summary';
import ArtworkStep from './artwork-step';
import { useCncArtworkValidation } from './use-cnc-artwork-validation';
import { useCncFinalise } from './use-cnc-finalise';
import { useCncLayout } from './use-cnc-layout';
import { useCncPreview } from './use-cnc-preview';
import { useCncPreviewPoll } from './use-cnc-preview-poll';

const TIERS: readonly CncLicenceTier[] = ['personal', 'commercial_single'];

/** Frozen empty list for a layout that has not landed yet. See the note in `artwork-step.tsx`. */
const EMPTY_PANELS: readonly CncLayoutPanel[] = [];

/** Where the buyer lands after signing in, so the draft below is restored onto the right page. */
const BUILD_PLANS_PATH = '/build-plans';

/** The generator has the job and there is nothing for the buyer to do but wait. */
const WORKING_STATUSES: readonly CncOrderStatus[] = ['preview_queued', 'preview_generating'];

/**
 * Quiet period before a step's change is reported.
 *
 * `Build Plans Configurator Changed` measures step COMPLETION, not keystrokes:
 * the licensee fields alone would otherwise fire an event per character and
 * bury the one signal the funnel wants — how far down the form people get.
 */
const STEP_EVENT_DEBOUNCE_MS = 900;

/** Same idea for the draft write: one IndexedDB round trip per pause, not per keystroke. */
const DRAFT_SAVE_DEBOUNCE_MS = 600;

type ConfiguratorProps = {
  catalog: CncCatalog;
  /** Resolved on the server, so prices format the same before and after hydration. */
  locale: string;
};

/**
 * The guided flow: configure a wall, see it for free, then buy it.
 *
 * Six numbered steps in one column with a summary rail beside them. The order
 * is the buying order and the numbers are real — what gets cut, how your shop
 * cuts it, what it says, what goes on it, what it looks like, whose licence it
 * is — so a buyer can stop after any of them and come back.
 *
 * Nothing here is gated behind an account except the preview itself. Reading
 * the cut list, changing the sheet stock and placing a label all work signed
 * out, because the whole funnel starts with a stranger deciding whether this
 * wall is the one they want.
 */
export default function Configurator({ catalog, locale }: ConfiguratorProps) {
  const { t } = useTranslation('cnc');
  const { openAuthModal } = useAuthModal();
  const { token, isAuthenticated } = useWsAuthToken();
  const { data: session } = useSession();

  const entries = catalog.entries;
  const [state, dispatch] = useReducer(configuratorReducer, entries[0], initialConfiguratorState);
  const entry = findEntry(entries, state) ?? entries[0];

  const configInput = useMemo(() => toBoardConfigInput(state, entry), [state, entry]);
  const currentConfigKey = useMemo(() => configKey(configInput), [configInput]);
  const hasArtwork = state.artwork.length > 0;
  // The drill pattern comes down only once somebody is actually placing a
  // label, and only for a signed-in buyer: it is the authenticated half of the
  // layout query and capped at 10 calls a minute, so asking for it on the
  // marketing view would spend a real allowance on a picture nobody is using.
  const {
    summary,
    model: layoutModel,
    isLoading: isLayoutLoading,
    errorKey: layoutErrorKey,
  } = useCncLayout(configInput, { includeHoles: isAuthenticated && hasArtwork, authToken: token });

  const {
    requestPreview,
    isRequesting: isRequestingPreview,
    downloadPreview,
    isDownloading: isDownloadingPreview,
    errorKey: previewErrorKey,
    isRateLimited,
  } = useCncPreview(token);
  const {
    order: previewOrder,
    errorKey: pollErrorKey,
    seedOrder,
  } = useCncPreviewPoll({ licenceId: state.previewLicenceId, token });
  const { finalise, isFinalising, errorKey: finaliseErrorKey } = useCncFinalise(token);

  // Published from the same constants the backend enforces, so a slider's
  // bounds and a rejected preview can never disagree. The fallbacks only cover
  // a catalogue that predates the artwork fields.
  const artworkRules = catalog.artworkRules;
  // The catalogue always publishes at least one face; the fallback is there so
  // a catalogue that somehow published none renders a usable select rather than
  // an empty one nobody can pick from.
  const artworkFonts = catalog.artworkFonts.length > 0 ? catalog.artworkFonts : [CNC_FALLBACK_ARTWORK_FONT];

  const {
    ok: artworkOk,
    collisions,
    isChecking: isCheckingArtwork,
    errorKey: artworkErrorKey,
  } = useCncArtworkValidation(configInput, token);

  const price = tierPrice(entry, state.tier);
  const blockers = finaliseBlockers(state);
  const machiningOptions = visibleMachiningOptions(entry, state.includeKicker);
  const engraveToggles = engraveOptions(entry);

  // Which labels the placement editor can already see are in trouble. Reported
  // by id rather than counted, so removing an item takes its verdict with it.
  const [collidingArtworkIds, setCollidingArtworkIds] = useState<readonly string[]>([]);
  const handleLocalCollisions = useCallback((id: string, hasCollisions: boolean) => {
    setCollidingArtworkIds((previous) => {
      const without = previous.filter((entry) => entry !== id);
      if (!hasCollisions) return without.length === previous.length ? previous : without;
      return previous.includes(id) ? previous : [...previous, id];
    });
  }, []);
  const hasLocalCollision = state.artwork.some((item) => collidingArtworkIds.includes(item.id));

  // A preview waits on the GENERATOR's verdict, not on the local bounds check.
  // The local one cannot see a T-nut keep-out, and a preview whose artwork
  // cannot be routed is a job that is guaranteed to fail. `artworkOk` is null
  // until an answer arrives, which is why this blocks on anything that is not
  // an explicit `true` — and the editor's own live check blocks too, so a label
  // visibly sitting on a hole cannot be previewed while the generator is still
  // being asked about it.
  const isArtworkBlocking =
    hasArtwork && (!isArtworkLocallyValid(state.artwork, artworkRules) || hasLocalCollision || artworkOk !== true);

  // ------------------------------------------------------------ preview state
  const previewStatus = previewOrder?.status ?? null;
  const isPreviewWorking = previewStatus !== null && WORKING_STATUSES.includes(previewStatus);
  const isStale = isPreviewStale(state, currentConfigKey);
  const isPreviewReady = previewStatus === 'preview_ready';
  const hasFreshPreview = isPreviewReady && !isStale;
  const canFinalise = hasFreshPreview && blockers.length === 0 && !isArtworkBlocking && state.previewOrderId !== null;

  // ---------------------------------------------------------------- analytics
  const analyticsConfig: CncConfigProps = useMemo(
    () => ({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      kicker: state.includeKicker,
      has_artwork: hasArtwork,
    }),
    [entry.boardName, entry.layoutId, entry.sizeId, state.includeKicker, hasArtwork],
  );

  // Read through a ref inside the debounced reporter so a config change does
  // not restart the timer — the event should describe the wall as it stands
  // when the buyer stops fiddling, not cancel itself every time they fiddle.
  const analyticsConfigRef = useRef(analyticsConfig);
  analyticsConfigRef.current = analyticsConfig;

  const stepTimersRef = useRef(new Map<CncConfiguratorStep, ReturnType<typeof setTimeout>>());
  const reportStep = useCallback((step: CncConfiguratorStep) => {
    const timers = stepTimersRef.current;
    const existing = timers.get(step);
    if (existing) clearTimeout(existing);
    timers.set(
      step,
      setTimeout(() => {
        timers.delete(step);
        trackCncFunnelEvent(cncConfiguratorChanged({ step, config: analyticsConfigRef.current }));
      }, STEP_EVENT_DEBOUNCE_MS),
    );
  }, []);

  useEffect(() => {
    const timers = stepTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const hasReportedViewRef = useRef(false);
  useEffect(() => {
    if (hasReportedViewRef.current) return;
    hasReportedViewRef.current = true;
    trackCncFunnelEvent(
      cncBuildPlansPageViewed({ config: analyticsConfigRef.current, catalog_version: catalog.version }),
    );
  }, [catalog.version]);

  // -------------------------------------------------------------------- draft
  // Restored once, before the first save can run, so a sign-in round trip comes
  // back to the wall the buyer configured — and to the preview it produced —
  // rather than to the defaults.
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getPreference<unknown>(CNC_CONFIGURATOR_DRAFT_KEY);
      if (cancelled) return;
      const restored = fromDraft(stored, entries);
      if (restored) dispatch({ type: 'restoreDraft', state: restored });
      setIsDraftRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [entries]);

  useEffect(() => {
    if (!isDraftRestored) return;
    const timer = setTimeout(() => {
      void setPreference(CNC_CONFIGURATOR_DRAFT_KEY, toDraft(state));
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state, isDraftRestored]);

  // Prefill the licensee from the session, but never overwrite typing: the
  // account's email is a good guess, not an answer, and someone buying a
  // commercial licence for a client may well want a different address on it.
  const hasPrefilledRef = useRef(false);
  // The dependency is "are these fields still empty", not how long they are.
  // Depending on `.length` re-runs this effect on every keystroke to reach a
  // guard that already returned on the first one, and it reads as though the
  // prefill cares about the value when all it cares about is emptiness.
  const isLicenseeEmailEmpty = state.licenseeEmail.length === 0;
  const isLicenseeNameEmpty = state.licenseeName.length === 0;
  useEffect(() => {
    if (hasPrefilledRef.current || !isDraftRestored) return;
    const email = session?.user?.email;
    const name = session?.user?.name;
    if (!email && !name) return;
    hasPrefilledRef.current = true;
    if (email && isLicenseeEmailEmpty) dispatch({ type: 'setLicenseeEmail', value: email });
    if (name && isLicenseeNameEmpty) dispatch({ type: 'setLicenseeName', value: name });
  }, [session, isDraftRestored, isLicenseeEmailEmpty, isLicenseeNameEmpty]);

  // ------------------------------------------------------------------- actions
  const handleSizeChange = (sizeId: number) => {
    const next = entries.find((candidate) => candidate.sizeId === sizeId);
    if (!next) return;
    dispatch({ type: 'selectSize', entry: next });
    // Picking a size is also picking a board, because a catalogue entry names
    // both. Today every entry is a Kilter Homewall so this branch never fires,
    // and `board` would be the one step in the funnel contract that never
    // appears — leaving a gap in the funnel the day a second board goes on
    // sale and the size select starts spanning two of them.
    if (next.boardName !== entry.boardName) reportStep('board');
    reportStep('size');
  };

  const handleAddArtwork = () => {
    dispatch({
      type: 'addArtwork',
      item: newArtworkItem({ rules: artworkRules, font: artworkFonts[0] }),
    });
  };

  // An upload that has already landed in the private bucket. It arrives as an
  // id, never as bytes: the file is the backend's from the moment the route
  // answered, and this list only ever holds a pointer to it plus where on the
  // wall it goes.
  const handleAddAssetArtwork = ({ assetId, kind }: { assetId: string; kind: CncArtworkKind }) => {
    dispatch({
      type: 'addArtwork',
      item: newArtworkItem({ rules: artworkRules, font: artworkFonts[0], kind, assetId }),
    });
  };

  const handleArtworkChange = (id: string, patch: Partial<Omit<CncArtworkDraft, 'id'>>) => {
    dispatch({ type: 'updateArtwork', id, patch });
  };

  // `Artwork Placed` fires once per item that BECOMES routable, not on every
  // keystroke while it is being placed. The funnel question is "did anyone
  // manage to put a label on their wall", and an event per slider frame answers
  // a question nobody asked. Reported ids are remembered so an item that is
  // edited after it fits does not fire again — and forgotten when it stops
  // fitting, so genuinely fixing a collision is counted.
  const placedArtworkIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (artworkOk !== true) {
      // Only forget the ids that are gone or no longer valid; a verdict of
      // "not ok" says nothing about which item is at fault.
      return;
    }
    // `artworkOk` is the generator's verdict on the SUBMITTED items only — an
    // empty draft card never reaches the generator at all — so a card with no
    // text yet must never be counted as newly placed just because it happens
    // to share a "true" verdict with the cards that were actually checked.
    const newlyPlaced = state.artwork.filter(
      (item) => isArtworkReady(item) && !placedArtworkIdsRef.current.has(item.id),
    );
    if (newlyPlaced.length === 0) return;
    for (const item of newlyPlaced) placedArtworkIdsRef.current.add(item.id);
    trackCncFunnelEvent(cncArtworkPlaced({ config: analyticsConfigRef.current, artwork_count: state.artwork.length }));
  }, [artworkOk, state.artwork]);

  const handlePreview = async () => {
    if (!isAuthenticated) {
      // The draft is already on disk, and OAuth leaves the page entirely, so the
      // callback has to carry the buyer back here for the restore to happen.
      openAuthModal({
        title: t('cta.signInTitle'),
        description: t('cta.signInBody'),
        callbackUrl: BUILD_PLANS_PATH,
      });
      return;
    }
    // Mirrors the button's own `disabled` condition rather than trusting it:
    // this is the function a stale click or a re-render race could reach with
    // the button's disabled state out of date, and unrouteable artwork is
    // exactly the job this check exists to keep out of the generator's queue.
    if (isArtworkBlocking || isRequestingPreview) return;

    trackCncFunnelEvent(cncPreviewRequested({ config: analyticsConfig, is_update: state.previewOrderId !== null }));

    // The key is taken from the config that is actually being sent, not read
    // back after the round trip: the buyer may well change something while the
    // generator is drawing, and this preview belongs to the wall it was asked
    // for.
    const sentConfigKey = currentConfigKey;
    const order = await requestPreview(configInput);
    if (!order) return;
    seedOrder(order);
    dispatch({ type: 'previewCreated', orderId: order.id, licenceId: order.licenceId, configKey: sentConfigKey });
  };

  const handleFinalise = () => {
    const orderId = state.previewOrderId;
    if (!orderId || !canFinalise || isFinalising) return;

    if (price) {
      trackCncFunnelEvent(
        cncCheckoutStarted({
          config: analyticsConfig,
          tier: state.tier,
          amount_cents: price.amountCents,
          currency: price.currency,
        }),
      );
    }

    void finalise({
      orderId,
      tier: state.tier,
      licenseeName: state.licenseeName.trim(),
      licenseeEmail: state.licenseeEmail.trim(),
      customerSiteName: state.tier === 'commercial_single' ? state.customerSiteName.trim() : null,
      acceptLicence: true,
    });
  };

  const errorKey = finaliseErrorKey ?? previewErrorKey ?? pollErrorKey ?? layoutErrorKey ?? artworkErrorKey;

  return (
    <Box id="configure" className={styles.configurator}>
      <PageSection title={t('configurator.heading')} intro={t('configurator.intro')}>
        <SplitLayout
          railLabel={t('configurator.summary.heading')}
          rail={
            <SummaryRail
              summary={summary}
              isLoading={isLayoutLoading}
              hasError={layoutErrorKey !== null}
              price={price ? formatPrice(price.amountCents, price.currency, locale) : null}
              tier={state.tier}
              isAuthenticated={isAuthenticated}
              isRequesting={isRequestingPreview}
              isWorking={isPreviewWorking}
              isStale={isStale}
              isFailed={previewStatus === 'preview_failed'}
              hasFreshPreview={hasFreshPreview}
              canFinalise={canFinalise}
              isFinalising={isFinalising}
              blockedReason={
                isArtworkBlocking
                  ? t('configurator.artwork.blocksPreview')
                  : hasFreshPreview && blockers.length > 0
                    ? t('configurator.licensee.required')
                    : null
              }
              onPreview={() => void handlePreview()}
              onFinalise={handleFinalise}
            />
          }
        >
          <Box className={styles.steps}>
            <SectionCard>
              <StepHeading
                step={1}
                done
                title={t('configurator.wall.heading')}
                description={t('configurator.wall.help')}
              />
              <Box className={styles.stepBody}>
                <WallStep entries={entries} state={state} onSizeChange={handleSizeChange} />
                {hasKickerSets(entry) && entry.kickerOptional && (
                  <Box className={styles.switchRow}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={state.includeKicker}
                          onChange={(event) => {
                            dispatch({ type: 'setKicker', includeKicker: event.target.checked });
                            reportStep('kicker');
                          }}
                        />
                      }
                      label={state.includeKicker ? t('configurator.kicker.include') : t('configurator.kicker.exclude')}
                    />
                    <FormHelperText>{t('configurator.kicker.help')}</FormHelperText>
                  </Box>
                )}
              </Box>
            </SectionCard>

            <SectionCard>
              <StepHeading
                step={2}
                done
                title={t('configurator.options.heading')}
                description={t('configurator.options.help')}
              />
              <Box className={styles.stepBody}>
                <FieldGrid>
                  {machiningOptions.map((option) => (
                    <FormControl key={option.key} fullWidth size="small">
                      <InputLabel id={`cnc-option-${option.key}`}>
                        {t(`configurator.options.${option.key}.label`)}
                      </InputLabel>
                      <Select
                        labelId={`cnc-option-${option.key}`}
                        label={t(`configurator.options.${option.key}.label`)}
                        value={state.options[option.key] ?? option.defaultValue}
                        onChange={(event) => {
                          dispatch({ type: 'setOption', key: option.key, value: event.target.value });
                          reportStep('options');
                        }}
                      >
                        {option.values.map((value) => (
                          <MenuItem key={value} value={value}>
                            {t(`configurator.options.${option.key}.values.${optionValueKey(value)}`)}
                          </MenuItem>
                        ))}
                      </Select>
                      <FormHelperText>{t(`configurator.options.${option.key}.help`)}</FormHelperText>
                    </FormControl>
                  ))}
                </FieldGrid>
              </Box>
            </SectionCard>

            {engraveToggles.length > 0 && (
              <SectionCard>
                <StepHeading
                  step={3}
                  done
                  title={t('configurator.engrave.heading')}
                  description={t('configurator.engrave.help')}
                />
                <Box className={styles.stepBody}>
                  {engraveToggles.map((option) => (
                    <Box key={option.key} className={styles.switchRow}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={(state.options[option.key] ?? option.defaultValue) === 'true'}
                            onChange={(event) => {
                              dispatch({
                                type: 'setOption',
                                key: option.key,
                                value: event.target.checked ? 'true' : 'false',
                              });
                              reportStep('engrave');
                            }}
                          />
                        }
                        label={t(`configurator.options.${option.key}.label`)}
                      />
                      <FormHelperText>{t(`configurator.options.${option.key}.help`)}</FormHelperText>
                    </Box>
                  ))}
                  <Typography variant="body2" component="p" className={styles.stepNote}>
                    {t('configurator.engrave.note')}
                  </Typography>
                </Box>
              </SectionCard>
            )}

            <SectionCard>
              <StepHeading
                step={4}
                done={hasArtwork && !isArtworkBlocking}
                title={t('configurator.artwork.heading')}
                description={t('configurator.artwork.help', { count: artworkRules.maxItems })}
              />
              <Box className={styles.stepBody}>
                <ArtworkStep
                  artwork={state.artwork}
                  rules={artworkRules}
                  fonts={artworkFonts}
                  panels={summary?.panels ?? EMPTY_PANELS}
                  layout={layoutModel}
                  validationOk={artworkOk}
                  collisions={collisions}
                  isChecking={isCheckingArtwork}
                  canValidate={isAuthenticated}
                  authToken={token}
                  onAdd={handleAddArtwork}
                  onAddAsset={handleAddAssetArtwork}
                  onChange={handleArtworkChange}
                  onRemove={(id) => dispatch({ type: 'removeArtwork', id })}
                  onLocalCollisions={handleLocalCollisions}
                />
              </Box>
            </SectionCard>

            <PreviewStep
              order={previewOrder}
              summary={summary}
              isAuthenticated={isAuthenticated}
              isStale={isStale}
              isRateLimited={isRateLimited}
              isDownloading={isDownloadingPreview}
              locale={locale}
              onDownload={() => {
                if (previewOrder) void downloadPreview(previewOrder.licenceId);
              }}
            />

            {isPreviewReady && (
              <SectionCard>
                <StepHeading
                  step={6}
                  done={blockers.length === 0}
                  title={t('configurator.finalise.heading')}
                  description={t('configurator.finalise.help')}
                />
                <Box className={styles.stepBody}>
                  <FormControl component="fieldset" fullWidth>
                    {/* A licence tier is a mutually exclusive choice, not a set of
                        independent switches — a `RadioGroup` says that in the
                        accessibility tree, where a checkbox row would let a
                        screen reader user believe both tiers could be on at
                        once. */}
                    <FormLabel component="legend">{t('tiers.heading')}</FormLabel>
                    <RadioGroup
                      value={state.tier}
                      onChange={(event) => {
                        dispatch({ type: 'setTier', tier: event.target.value as CncLicenceTier });
                        reportStep('tier');
                      }}
                    >
                      {TIERS.map((tier) => {
                        const tierAmount = tierPrice(entry, tier);
                        return (
                          <FormControlLabel
                            key={tier}
                            value={tier}
                            control={<Radio />}
                            label={
                              <span>
                                {tier === 'personal' ? t('tiers.personal.name') : t('tiers.commercial.name')}
                                {tierAmount ? (
                                  <Typography component="span" color="text.secondary">
                                    {` · ${formatPrice(tierAmount.amountCents, tierAmount.currency, locale)}`}
                                  </Typography>
                                ) : null}
                              </span>
                            }
                          />
                        );
                      })}
                    </RadioGroup>
                  </FormControl>

                  <FieldGrid columns="single">
                    <TextField
                      label={t('configurator.licensee.name')}
                      value={state.licenseeName}
                      onChange={(event) => dispatch({ type: 'setLicenseeName', value: event.target.value })}
                      onBlur={() => reportStep('licensee')}
                      size="small"
                      fullWidth
                      required
                    />
                    <TextField
                      label={t('configurator.licensee.email')}
                      helperText={t('configurator.licensee.emailHelp')}
                      type="email"
                      value={state.licenseeEmail}
                      onChange={(event) => dispatch({ type: 'setLicenseeEmail', value: event.target.value })}
                      onBlur={() => reportStep('licensee')}
                      size="small"
                      fullWidth
                      required
                    />
                    {state.tier === 'commercial_single' && (
                      <TextField
                        label={t('configurator.licensee.siteName')}
                        helperText={t('configurator.licensee.siteHelp')}
                        value={state.customerSiteName}
                        onChange={(event) => dispatch({ type: 'setCustomerSiteName', value: event.target.value })}
                        onBlur={() => reportStep('licensee')}
                        size="small"
                        fullWidth
                        required
                      />
                    )}
                  </FieldGrid>

                  <Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={state.licenceAccepted}
                          onChange={(event) => dispatch({ type: 'setLicenceAccepted', accepted: event.target.checked })}
                        />
                      }
                      label={t('configurator.licence.accept')}
                    />
                    <MuiLink component={LocaleLink} href="/build-plans/licence" variant="body2">
                      {t('configurator.licence.link')}
                    </MuiLink>
                  </Box>

                  {isStale && (
                    <Typography variant="body2" component="p" className={styles.stepNote}>
                      {t('configurator.finalise.stale')}
                    </Typography>
                  )}
                </Box>
              </SectionCard>
            )}

            {errorKey && (
              <Alert severity="error" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
                {t(`errors.${errorKey}`)}
              </Alert>
            )}
          </Box>
        </SplitLayout>
      </PageSection>
    </Box>
  );
}

/**
 * Step 5: the free preview.
 *
 * A step in the flow rather than a modal, because it sits between "what goes on
 * the wall" and "whose licence is this" in the buyer's own sequence. Its state
 * lives in the chip in the card head, and the sheets themselves are never
 * dimmed, cropped or covered — the watermark is the whole point of the screen.
 */
function PreviewStep({
  order,
  summary,
  isAuthenticated,
  isStale,
  isRateLimited,
  isDownloading,
  locale,
  onDownload,
}: {
  order: CncOrder | null;
  summary: CncLayoutSummary | null;
  isAuthenticated: boolean;
  isStale: boolean;
  isRateLimited: boolean;
  isDownloading: boolean;
  locale: string;
  onDownload: () => void;
}) {
  const { t } = useTranslation('cnc');
  const status = order?.status ?? null;
  const isReady = status === 'preview_ready';

  const note = (() => {
    if (isRateLimited) return t('configurator.preview.rateLimited');
    if (!order) return isAuthenticated ? t('configurator.preview.idle') : t('configurator.preview.signedOut');
    if (status === 'preview_failed') return t('configurator.preview.failed');
    if (!isReady) return t('configurator.preview.working');
    return isStale ? t('configurator.preview.stale') : t('configurator.preview.ready');
  })();

  /**
   * A sheet's caption.
   *
   * The generator names its files `panel1.png` … `assembly.png`, and those
   * names are a contract with the worker rather than copy — so they are
   * translated here rather than shown raw, and a name we do not recognise falls
   * back to itself instead of to an empty caption.
   */
  const sheetLabel = (name: string): string => {
    const base = name.replace(/\.[^.]+$/, '');
    const panel = /^panel(\d+)$/.exec(base);
    if (panel) return t('configurator.preview.panel', { number: Number(panel[1]) });
    if (base === 'assembly') return t('configurator.preview.assembly');
    return base;
  };

  const generatedAt = order?.previewGeneratedAt ?? null;
  const panelCount = summary?.panelCount ?? null;
  const sheetCount = summary?.sheets ?? null;
  const tnutCount = summary?.tnutCount ?? null;
  const ledCount = summary?.ledCount ?? null;

  const bom: KeyValueItem[] = [];
  if (generatedAt !== null) {
    bom.push({
      key: 'generated',
      label: t('configurator.preview.generated'),
      value: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(generatedAt)),
    });
  }
  if (panelCount !== null) {
    bom.push({
      key: 'panels',
      label: t('configurator.summary.panels'),
      value: t('configurator.summary.panelsValue', { count: panelCount }),
    });
  }
  if (sheetCount !== null) {
    bom.push({
      key: 'sheets',
      label: t('configurator.summary.sheets'),
      value: t('configurator.summary.sheetsValue', { count: sheetCount }),
    });
  }
  if (tnutCount !== null) {
    bom.push({ key: 'tnuts', label: t('configurator.summary.tnuts'), value: String(tnutCount) });
  }
  if (ledCount !== null) {
    bom.push({ key: 'leds', label: t('configurator.summary.leds'), value: String(ledCount) });
  }

  return (
    <SectionCard tone={isReady && !isStale ? 'accent' : 'default'}>
      <Box className={styles.stepHead}>
        <StepHeading step={5} done={isReady && !isStale} title={t('configurator.preview.heading')} />
        {status && <StatusChip status={status} label={t(`status.${status}`)} />}
      </Box>
      <Box className={styles.stepBody}>
        {status === 'preview_failed' && order?.errorMessage ? (
          <Alert severity="error" sx={{ borderRadius: 'var(--border-radius-lg)' }}>
            {order.errorMessage}
          </Alert>
        ) : null}

        {order && isReady && order.previewImages.length > 0 ? (
          <PreviewGallery
            aria-label={t('configurator.preview.galleryLabel')}
            images={order.previewImages.map((image) => ({
              name: image.name,
              url: image.url,
              label: sheetLabel(image.name),
            }))}
            note={note}
            actions={
              <Button variant="outlined" onClick={onDownload} disabled={isDownloading}>
                {isDownloading ? t('configurator.preview.downloading') : t('configurator.preview.download')}
              </Button>
            }
          />
        ) : (
          <Typography variant="body2" component="p" className={styles.stepNote}>
            {note}
          </Typography>
        )}

        {isReady && bom.length > 0 && <KeyValueList items={bom} aria-label={t('configurator.preview.bomLabel')} />}
      </Box>
    </SectionCard>
  );
}

function WallStep({
  entries,
  state,
  onSizeChange,
}: {
  entries: readonly CncCatalogEntry[];
  state: CncConfiguratorState;
  onSizeChange: (sizeId: number) => void;
}) {
  const { t } = useTranslation('cnc');
  // Boards, not sizes: v1 sells one board, so the board control is a read-only
  // statement of that rather than a select with a single option pretending to
  // be a choice. It becomes a select the day a second board is on sale.
  const boardNames = [...new Set(entries.map((candidate) => getBoardDisplayName(candidate.boardName)))];

  return (
    <FieldGrid>
      <Box>
        <Typography variant="body2" component="p" className={styles.readOnlyLabel}>
          {t('configurator.board.label')}
        </Typography>
        <Typography variant="body1" component="p">
          {boardNames.join(', ')}
        </Typography>
        <FormHelperText>{t('configurator.board.help')}</FormHelperText>
      </Box>

      <FormControl fullWidth size="small">
        <InputLabel id="cnc-size">{t('configurator.size.label')}</InputLabel>
        <Select
          labelId="cnc-size"
          label={t('configurator.size.label')}
          value={String(state.sizeId)}
          onChange={(event) => onSizeChange(Number(event.target.value))}
        >
          {entries.map((candidate) => (
            <MenuItem key={candidate.sizeId} value={String(candidate.sizeId)}>
              {candidate.label}
            </MenuItem>
          ))}
        </Select>
        <FormHelperText>{t('configurator.size.help')}</FormHelperText>
      </FormControl>
    </FieldGrid>
  );
}

/**
 * The rail: what gets cut, what it costs, and the one thing to press.
 *
 * The only element on this surface allowed a shadow, because it is the only one
 * that floats — it follows the buyer down a long form so the figures they are
 * changing and the button they are heading for are never off screen. On a phone
 * it falls below the form in DOM order, which is where a buyer meets it after
 * answering the questions.
 */
function SummaryRail({
  summary,
  isLoading,
  hasError,
  price,
  tier,
  isAuthenticated,
  isRequesting,
  isWorking,
  isStale,
  isFailed,
  hasFreshPreview,
  canFinalise,
  isFinalising,
  blockedReason,
  onPreview,
  onFinalise,
}: {
  summary: CncLayoutSummary | null;
  isLoading: boolean;
  hasError: boolean;
  /** Already formatted for the request's locale, or null when the tier has no price. */
  price: string | null;
  tier: CncLicenceTier;
  isAuthenticated: boolean;
  isRequesting: boolean;
  isWorking: boolean;
  isStale: boolean;
  isFailed: boolean;
  hasFreshPreview: boolean;
  canFinalise: boolean;
  isFinalising: boolean;
  /** Why the action is disabled. Never a disabled button with no explanation. */
  blockedReason: string | null;
  onPreview: () => void;
  onFinalise: () => void;
}) {
  const { t } = useTranslation('cnc');

  // Rows keep their place while the layout is computed: a summary that changes
  // height as figures arrive makes the whole card jump under the cursor.
  const figure = (value: string | null): React.ReactNode =>
    value !== null ? value : isLoading ? <Skeleton width={64} /> : '—';

  const wallWidthMm = summary?.wallWidthMm ?? null;
  const wallHeightMm = summary?.wallHeightMm ?? null;
  const panelCount = summary?.panelCount ?? null;
  const sheetCount = summary?.sheets ?? null;
  const tnutCount = summary?.tnutCount ?? null;
  const ledCount = summary?.ledCount ?? null;

  const items: KeyValueItem[] = [
    {
      key: 'wall',
      label: t('configurator.summary.wall'),
      value: figure(
        wallWidthMm !== null && wallHeightMm !== null
          ? t('configurator.summary.wallValue', { width: wallWidthMm, height: wallHeightMm })
          : null,
      ),
    },
    {
      key: 'panels',
      label: t('configurator.summary.panels'),
      value: figure(panelCount !== null ? t('configurator.summary.panelsValue', { count: panelCount }) : null),
    },
    {
      key: 'sheets',
      label: t('configurator.summary.sheets'),
      value: figure(sheetCount !== null ? t('configurator.summary.sheetsValue', { count: sheetCount }) : null),
    },
    {
      key: 'tnuts',
      label: t('configurator.summary.tnuts'),
      value: figure(tnutCount !== null ? String(tnutCount) : null),
    },
    {
      key: 'leds',
      label: t('configurator.summary.leds'),
      value: figure(ledCount !== null ? String(ledCount) : null),
    },
  ];

  // Two rows that only exist for some walls, so they are appended rather than
  // held open: a wall with no kicker has no kicker height to skeleton, and a
  // seam that swallowed no LEDs is not a figure anyone needs.
  const kickerHeightMm = summary?.kickerHeightMm ?? null;
  if (kickerHeightMm !== null) {
    items.push({
      key: 'kickerHeight',
      label: t('configurator.summary.kickerHeight'),
      value: t('configurator.summary.kickerHeightValue', { height: kickerHeightMm }),
    });
  }
  const skippedSeamLeds = summary?.skippedSeamLeds ?? null;
  if (skippedSeamLeds !== null && skippedSeamLeds > 0) {
    items.push({
      key: 'skippedLeds',
      label: t('configurator.summary.skippedLeds'),
      value: String(skippedSeamLeds),
    });
  }

  const previewLabel = (() => {
    if (isRequesting) return t('cta.previewing');
    if (!isAuthenticated) return t('cta.previewSignedOut');
    if (isFailed && !isStale) return t('cta.previewRetry');
    if (isStale) return t('cta.previewUpdate');
    return t('cta.preview');
  })();

  const showFinalise = hasFreshPreview;

  return (
    <SectionCard tone="raised" title={t('configurator.summary.heading')}>
      {hasError ? (
        // An outage does not blank the rail: the error above already says what
        // happened, and a card full of dashes says nothing.
        <Typography variant="body2" component="p" className={styles.stepNote}>
          {t('configurator.summary.unavailable')}
        </Typography>
      ) : (
        <KeyValueList items={items} dense aria-label={t('configurator.summary.heading')} />
      )}

      {summary && summary.warnings.length > 0 && (
        <Box className={styles.railWarnings}>
          <Typography variant="body2" component="p" className={styles.railWarningsHeading}>
            {t('configurator.summary.warningsHeading')}
          </Typography>
          {summary.warnings.map((warning) => (
            <Typography key={warning} variant="body2" component="p" className={styles.stepNote}>
              {warning}
            </Typography>
          ))}
        </Box>
      )}

      <Box className={styles.railAction}>
        <Typography variant="body2" component="p" className={styles.railPriceLabel}>
          {tier === 'personal' ? t('tiers.personal.name') : t('tiers.commercial.name')}
        </Typography>
        <PriceTag amount={price ?? '—'} note={t('tiers.perWall')} />

        <Button
          variant="contained"
          size="large"
          fullWidth
          className={styles.railButton}
          disabled={showFinalise ? !canFinalise || isFinalising : isRequesting || isWorking}
          onClick={showFinalise ? onFinalise : onPreview}
        >
          {showFinalise ? (isFinalising ? t('cta.finalising') : t('cta.finalise')) : previewLabel}
        </Button>

        <Typography variant="body2" component="p" className={styles.stepNote}>
          {blockedReason ?? (isWorking ? t('configurator.preview.working') : t('cta.free'))}
        </Typography>
      </Box>
    </SectionCard>
  );
}
