'use client';

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
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
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { CncCatalog, CncCatalogEntry, CncLicenceTier } from '@boardsesh/shared-schema';
import {
  cncBuildPlansPageViewed,
  cncConfiguratorChanged,
  cncCheckoutStarted,
  type CncConfigProps,
  type CncConfiguratorStep,
} from '@boardsesh/analytics';
import { getBoardDisplayName } from '@boardsesh/climb-actions';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { trackCncFunnelEvent } from '@/app/lib/cnc-funnel-analytics';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import { themeTokens } from '@/app/theme/theme-config';
import styles from '../build-plans.module.css';
import {
  CNC_CONFIGURATOR_DRAFT_KEY,
  checkoutBlockers,
  configuratorReducer,
  engraveOptions,
  findEntry,
  formatPrice,
  fromDraft,
  hasKickerSets,
  initialConfiguratorState,
  optionValueKey,
  tierPrice,
  toBoardConfigInput,
  toDraft,
  visibleMachiningOptions,
  type CncConfiguratorState,
} from './configurator-state';
import { useCncCheckout } from './use-cnc-checkout';
import { useCncLayout } from './use-cnc-layout';

const TIERS: readonly CncLicenceTier[] = ['personal', 'commercial_single'];

/** Where the buyer lands after signing in, so the draft below is restored onto the right page. */
const BUILD_PLANS_PATH = '/build-plans';

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

export default function Configurator({ catalog, locale }: ConfiguratorProps) {
  const { t } = useTranslation('cnc');
  const { openAuthModal } = useAuthModal();
  const { token, isAuthenticated } = useWsAuthToken();
  const { data: session } = useSession();

  const entries = catalog.entries;
  const [state, dispatch] = useReducer(configuratorReducer, entries[0], initialConfiguratorState);
  const entry = findEntry(entries, state) ?? entries[0];

  const configInput = useMemo(() => toBoardConfigInput(state, entry), [state, entry]);
  const { summary, isLoading: isLayoutLoading, errorKey: layoutErrorKey } = useCncLayout(configInput);
  const { startCheckout, isStarting, errorKey: checkoutErrorKey } = useCncCheckout(token);

  const price = tierPrice(entry, state.tier);
  const blockers = checkoutBlockers(state);
  const machiningOptions = visibleMachiningOptions(entry, state.includeKicker);
  const engraveToggles = engraveOptions(entry);

  // ---------------------------------------------------------------- analytics
  const analyticsConfig: CncConfigProps = useMemo(
    () => ({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      kicker: state.includeKicker,
      // Artwork arrives with the placement editor; the property is in the
      // contract from the first event so the funnel does not gain a column
      // halfway through its own history.
      has_artwork: false,
    }),
    [entry.boardName, entry.layoutId, entry.sizeId, state.includeKicker],
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
  // back to the wall the buyer configured rather than to the defaults.
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
  useEffect(() => {
    if (hasPrefilledRef.current || !isDraftRestored) return;
    const email = session?.user?.email;
    const name = session?.user?.name;
    if (!email && !name) return;
    hasPrefilledRef.current = true;
    if (email && state.licenseeEmail.length === 0) dispatch({ type: 'setLicenseeEmail', value: email });
    if (name && state.licenseeName.length === 0) dispatch({ type: 'setLicenseeName', value: name });
  }, [session, isDraftRestored, state.licenseeEmail.length, state.licenseeName.length]);

  // ------------------------------------------------------------------- actions
  const handleSizeChange = (sizeId: number) => {
    const next = entries.find((candidate) => candidate.sizeId === sizeId);
    if (!next) return;
    dispatch({ type: 'selectSize', entry: next });
    reportStep('size');
  };

  const handleBuy = () => {
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
    if (blockers.length > 0 || !price) return;

    trackCncFunnelEvent(
      cncCheckoutStarted({
        config: analyticsConfig,
        tier: state.tier,
        amount_cents: price.amountCents,
        currency: price.currency,
      }),
    );
    void startCheckout({
      config: configInput,
      tier: state.tier,
      licenseeName: state.licenseeName.trim(),
      licenseeEmail: state.licenseeEmail.trim(),
      customerSiteName: state.tier === 'commercial_single' ? state.customerSiteName.trim() : null,
      acceptLicence: true,
    });
  };

  const errorKey = checkoutErrorKey ?? layoutErrorKey;

  return (
    <Card component="section" className={styles.configurator} id="configure">
      <CardContent>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h2" className={styles.sectionHeading}>
              {t('configurator.heading')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('configurator.intro')}
            </Typography>
          </Box>

          <BoardAndSizeStep entries={entries} state={state} onSizeChange={handleSizeChange} />

          {hasKickerSets(entry) && entry.kickerOptional && (
            <Box>
              <Typography variant="subtitle1" className={styles.stepHeading}>
                {t('configurator.kicker.label')}
              </Typography>
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
              <Typography variant="body2" color="text.secondary">
                {t('configurator.kicker.help')}
              </Typography>
            </Box>
          )}

          <Divider />

          <Box>
            <Typography variant="subtitle1" className={styles.stepHeading}>
              {t('configurator.options.heading')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t('configurator.options.help')}
            </Typography>
            <Box className={styles.optionGrid}>
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
            </Box>
          </Box>

          {engraveToggles.length > 0 && (
            <Box>
              <Typography variant="subtitle1" className={styles.stepHeading}>
                {t('configurator.engrave.heading')}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('configurator.engrave.help')}
              </Typography>
              <Stack sx={{ mt: 1 }}>
                {engraveToggles.map((option) => (
                  <FormControlLabel
                    key={option.key}
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
                ))}
              </Stack>
              <Typography variant="caption" color="text.secondary" component="p">
                {t('configurator.engrave.note')}
              </Typography>
            </Box>
          )}

          <LayoutSummaryCard summary={summary} isLoading={isLayoutLoading} hasError={layoutErrorKey !== null} />

          <Divider />

          <Box>
            <Typography variant="subtitle1" className={styles.stepHeading}>
              {t('configurator.licensee.heading')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t('configurator.licensee.help')}
            </Typography>
            <Stack spacing={2}>
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
            </Stack>
          </Box>

          <Box>
            {/* A licence tier is a mutually exclusive choice, not a set of
                independent switches — a `RadioGroup` says that in the
                accessibility tree, where the old checkbox row let a screen
                reader user believe both tiers could be on at once. */}
            <FormControl component="fieldset">
              <FormLabel component="legend" className={styles.stepHeading}>
                {t('tiers.heading')}
              </FormLabel>
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
                          <Typography component="span" fontWeight={themeTokens.typography.fontWeight.semibold}>
                            {tier === 'personal' ? t('tiers.personal.name') : t('tiers.commercial.name')}
                          </Typography>
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
          </Box>

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
            <MuiLink component={LocaleLink} href="/build-plans/licence" variant="body2" sx={{ ml: 1 }}>
              {t('configurator.licence.link')}
            </MuiLink>
          </Box>

          {errorKey && <Alert severity="error">{t(`errors.${errorKey}`)}</Alert>}

          <Box>
            <Button
              variant="contained"
              size="large"
              onClick={handleBuy}
              disabled={isStarting || (isAuthenticated && (blockers.length > 0 || !price))}
              sx={{ textTransform: 'none' }}
            >
              {isStarting ? t('cta.buying') : isAuthenticated ? t('cta.buy') : t('cta.buySignedOut')}
            </Button>
            {isAuthenticated && blockers.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {t('configurator.licensee.required')}
              </Typography>
            )}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function BoardAndSizeStep({
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
  const boardNames = [...new Set(entries.map((entry) => getBoardDisplayName(entry.boardName)))];

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle1" className={styles.stepHeading}>
          {t('configurator.board.label')}
        </Typography>
        <Typography variant="body1">{boardNames.join(', ')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('configurator.board.help')}
        </Typography>
      </Box>

      <FormControl fullWidth size="small">
        <InputLabel id="cnc-size">{t('configurator.size.label')}</InputLabel>
        <Select
          labelId="cnc-size"
          label={t('configurator.size.label')}
          value={String(state.sizeId)}
          onChange={(event) => onSizeChange(Number(event.target.value))}
        >
          {entries.map((entry) => (
            <MenuItem key={entry.sizeId} value={String(entry.sizeId)}>
              {entry.label}
            </MenuItem>
          ))}
        </Select>
        <FormHelperText>{t('configurator.size.help')}</FormHelperText>
      </FormControl>
    </Stack>
  );
}

function LayoutSummaryCard({
  summary,
  isLoading,
  hasError,
}: {
  summary: ReturnType<typeof useCncLayout>['summary'];
  isLoading: boolean;
  hasError: boolean;
}) {
  const { t } = useTranslation('cnc');

  // An outage does not blank the configurator: the summary is a confidence
  // builder, and the error banner above already says what happened. Rendering
  // nothing here beats rendering a card full of dashes.
  if (hasError) return null;

  return (
    <Box className={styles.summary}>
      <Typography variant="subtitle1" className={styles.stepHeading}>
        {t('configurator.summary.heading')}
      </Typography>
      {!summary && isLoading && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            {t('configurator.summary.loading')}
          </Typography>
        </Stack>
      )}
      {summary && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          {summary.wallWidthMm !== null && summary.wallHeightMm !== null && (
            <SummaryRow
              label={t('configurator.summary.wall')}
              value={t('configurator.summary.wallValue', {
                width: summary.wallWidthMm,
                height: summary.wallHeightMm,
              })}
            />
          )}
          {summary.kickerHeightMm !== null && (
            <SummaryRow
              label={t('configurator.summary.kickerHeight')}
              value={t('configurator.summary.kickerHeightValue', { height: summary.kickerHeightMm })}
            />
          )}
          {summary.panelCount !== null && (
            <SummaryRow
              label={t('configurator.summary.panels')}
              value={t('configurator.summary.panelsValue', { count: summary.panelCount })}
            />
          )}
          {summary.sheets !== null && (
            <SummaryRow
              label={t('configurator.summary.sheets')}
              value={t('configurator.summary.sheetsValue', { count: summary.sheets })}
            />
          )}
          {summary.tnutCount !== null && (
            <SummaryRow label={t('configurator.summary.tnuts')} value={String(summary.tnutCount)} />
          )}
          {summary.ledCount !== null && (
            <SummaryRow label={t('configurator.summary.leds')} value={String(summary.ledCount)} />
          )}
          {summary.skippedSeamLeds !== null && summary.skippedSeamLeds > 0 && (
            <SummaryRow label={t('configurator.summary.skippedLeds')} value={String(summary.skippedSeamLeds)} />
          )}
          {summary.warnings.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" fontWeight={themeTokens.typography.fontWeight.semibold}>
                {t('configurator.summary.warningsHeading')}
              </Typography>
              {summary.warnings.map((warning) => (
                <Typography key={warning} variant="body2" color="text.secondary">
                  {warning}
                </Typography>
              ))}
            </Box>
          )}
        </Stack>
      )}
    </Box>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" className={styles.summaryRow}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={themeTokens.typography.fontWeight.semibold}>
        {value}
      </Typography>
    </Stack>
  );
}
