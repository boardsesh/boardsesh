'use client';

import React, { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import {
  GitHub,
  FavoriteBorderOutlined,
  CreditCardOutlined,
  InfoOutlined,
  GroupOutlined,
  VolunteerActivismOutlined,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell, PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import { resolveShellStaticAssetUrl } from '@/app/lib/shell-static-asset-url';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import styles from './support.module.css';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  CREATE_SUPPORT_BILLING_PORTAL,
  CREATE_SUPPORT_CHECKOUT,
  UPDATE_SUPPORTER_VISIBILITY,
  type SupportConfiguration,
  type SupporterStatus,
} from '@boardsesh/graphql/operations/support';

const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/boardsesh';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
const LOCALE_CATALOGS_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';
const GITHUB_REPO_URL = 'https://github.com/boardsesh/boardsesh';
const DISCORD_URL = 'https://discord.gg/YXA8GsXfQK';
const DONATION_CTA_SX = brandCtaSx();
const useIdentityLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const EMPTY_SUPPORT_STATUS: SupporterStatus = {
  linked: false,
  hasSupported: false,
  showPublicly: false,
  hasActiveSubscription: false,
  cancelAtPeriodEnd: false,
};

type SupportContentProps = {
  configuration: SupportConfiguration;
  initialStatus: SupporterStatus;
  initialUserId: string | null;
  locale: string;
};

function supportErrorCode(requestError: unknown): string | null {
  if (!requestError || typeof requestError !== 'object' || !('response' in requestError)) return null;
  const response = requestError.response;
  if (!response || typeof response !== 'object' || !('errors' in response) || !Array.isArray(response.errors))
    return null;
  for (const graphqlError of response.errors as unknown[]) {
    if (!graphqlError || typeof graphqlError !== 'object' || !('extensions' in graphqlError)) continue;
    const extensions = graphqlError.extensions;
    if (extensions && typeof extensions === 'object' && 'code' in extensions && typeof extensions.code === 'string') {
      return extensions.code;
    }
  }
  return null;
}

function SupportResultAlert() {
  const { t } = useTranslation('marketing');
  const result = useSearchParams().get('support');
  if (result === 'thanks') return <Alert severity="success">{t('support.stripe.thanks')}</Alert>;
  if (result === 'cancelled') return <Alert severity="info">{t('support.stripe.cancelled')}</Alert>;
  return null;
}

export default function SupportContent({ configuration, initialStatus, initialUserId, locale }: SupportContentProps) {
  const { t } = useTranslation('marketing');
  const { data: session, status: sessionStatus } = useSession();
  const sessionUserId = session?.user?.id ?? null;
  const priorSessionUserId = useRef<string | null>(initialUserId);
  const sessionIdentity =
    sessionStatus === 'loading' ? 'loading' : `${sessionUserId ?? 'anonymous'}:${session?.authSessionId ?? 'legacy'}`;
  const currentSessionIdentity = useRef(sessionIdentity);
  const hasUserChanged = sessionStatus !== 'loading' && priorSessionUserId.current !== sessionUserId;
  const {
    token: authToken,
    isAuthenticated,
    isLoading: isAuthLoading,
    error: authError,
    refetch: refetchAuth,
  } = useWsAuthToken();
  const isAuthUnresolved = isAuthLoading || Boolean(authError) || (isAuthenticated && !authToken);
  const canManageSupport = isAuthenticated && Boolean(authToken) && !isAuthUnresolved;
  const [amount, setAmount] = useState('5');
  const [cadence, setCadence] = useState<'MONTHLY' | 'ONE_TIME'>('MONTHLY');
  const [publicCredit, setPublicCredit] = useState(initialStatus.showPublicly);
  const [storedStatus, setStatus] = useState(initialStatus);
  const status = hasUserChanged ? EMPTY_SUPPORT_STATUS : storedStatus;
  const [existingSubscriptionDetected, setExistingSubscriptionDetected] = useState(false);
  const shouldManageSubscription = status.hasActiveSubscription || (!hasUserChanged && existingSubscriptionDetected);
  const [busy, setBusy] = useState(false);
  const [isRetryingAuth, setIsRetryingAuth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useIdentityLayoutEffect(() => {
    if (currentSessionIdentity.current !== sessionIdentity) setBusy(false);
    currentSessionIdentity.current = sessionIdentity;
  }, [sessionIdentity]);

  useEffect(() => {
    if (sessionStatus === 'loading') return;
    const previousUserId = priorSessionUserId.current;
    priorSessionUserId.current = sessionUserId;
    if (previousUserId === sessionUserId) return;
    setStatus(EMPTY_SUPPORT_STATUS);
    setPublicCredit(false);
    setExistingSubscriptionDetected(false);
    setError(null);
  }, [sessionStatus, sessionUserId]);

  const showSupportError = (requestError: unknown) => {
    switch (supportErrorCode(requestError)) {
      case 'PENDING_CHECKOUT_EXISTS':
        setError(t('support.stripe.pendingCheckout'));
        break;
      case 'ACTIVE_SUBSCRIPTION_EXISTS':
        setExistingSubscriptionDetected(true);
        setError(t('support.stripe.activeSubscription'));
        break;
      case 'SUPPORT_OPERATION_PENDING':
        setError(t('support.stripe.operationPending'));
        break;
      case 'SUPPORT_OPERATION_STALE':
        setError(t('support.stripe.operationStale'));
        break;
      default:
        setError(t('support.stripe.error'));
    }
  };

  const retryAuth = async () => {
    if (isAuthLoading || isRetryingAuth) return;
    setIsRetryingAuth(true);
    try {
      await refetchAuth();
    } finally {
      setIsRetryingAuth(false);
    }
  };

  const startCheckout = async () => {
    if (busy || isAuthUnresolved) return;
    const amountInMinorUnits = Math.round(Number(amount) * 100);
    if (
      !Number.isFinite(amountInMinorUnits) ||
      amountInMinorUnits < configuration.minimumAmount ||
      amountInMinorUnits > configuration.maximumAmount
    ) {
      setError(t('support.stripe.amountError'));
      return;
    }
    const requestIdentity = sessionIdentity;
    setBusy(true);
    setError(null);
    try {
      const response = await createGraphQLHttpClient(authToken).request<{
        createSupportCheckoutSession: { url: string };
      }>(CREATE_SUPPORT_CHECKOUT, {
        input: {
          amount: amountInMinorUnits,
          cadence,
          publicCredit: isAuthenticated && !hasUserChanged ? publicCredit : false,
          locale,
        },
      });
      if (currentSessionIdentity.current !== requestIdentity) return;
      window.location.assign(response.createSupportCheckoutSession.url);
    } catch (requestError) {
      if (currentSessionIdentity.current !== requestIdentity) return;
      showSupportError(requestError);
    } finally {
      if (currentSessionIdentity.current === requestIdentity) setBusy(false);
    }
  };

  const updateVisibility = async (showPublicly: boolean) => {
    if (busy || !canManageSupport) return;
    const requestIdentity = sessionIdentity;
    setBusy(true);
    setError(null);
    try {
      const response = await createGraphQLHttpClient(authToken).request<{
        updateSupporterVisibility: SupporterStatus;
      }>(UPDATE_SUPPORTER_VISIBILITY, { showPublicly });
      if (currentSessionIdentity.current !== requestIdentity) return;
      setStatus(response.updateSupporterVisibility);
      setPublicCredit(response.updateSupporterVisibility.showPublicly);
    } catch (requestError) {
      if (currentSessionIdentity.current !== requestIdentity) return;
      showSupportError(requestError);
    } finally {
      if (currentSessionIdentity.current === requestIdentity) setBusy(false);
    }
  };

  const openBillingPortal = async () => {
    if (busy || !canManageSupport) return;
    const requestIdentity = sessionIdentity;
    setBusy(true);
    setError(null);
    try {
      const response = await createGraphQLHttpClient(authToken).request<{
        createSupportBillingPortalSession: { url: string };
      }>(CREATE_SUPPORT_BILLING_PORTAL, { locale });
      if (currentSessionIdentity.current !== requestIdentity) return;
      window.location.assign(response.createSupportBillingPortalSession.url);
    } catch (requestError) {
      if (currentSessionIdentity.current !== requestIdentity) return;
      showSupportError(requestError);
    } finally {
      if (currentSessionIdentity.current === requestIdentity) setBusy(false);
    }
  };
  return (
    <PageShell
      title={t('support.hero.title')}
      lead={t('support.hero.subtitle')}
      width="wide"
      headerAlign="center"
      headerClassName={styles.hero}
      eyebrow={<Image src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.webp')} width={52} height={52} alt="" />}
      headerActions={
        <Box className={styles.heroActions}>
          <Button
            variant="contained"
            color="primaryFill"
            size="large"
            href="#stripe-support"
            startIcon={<CreditCardOutlined />}
            sx={DONATION_CTA_SX}
          >
            {t('support.stripe.cta')}
          </Button>
        </Box>
      }
    >
      {/* The promise belongs next to the ask, not buried in the small print. */}
      <Suspense fallback={null}>
        <SupportResultAlert />
      </Suspense>
      <Box className={styles.promise}>
        <Typography variant="h5" component="p">
          {t('support.promise')}
        </Typography>
      </Box>

      <Box className={styles.contributionGrid}>
        <PageSection title={t('support.why.title')} icon={<FavoriteBorderOutlined />}>
          <Prose>{t('support.why.p1')}</Prose>
          <Prose>{t('support.why.p2')}</Prose>
        </PageSection>

        <PageSection title={t('support.rails.title')} className={styles.contributionOptions}>
          {/* The rails are the only cards on the page — that is what makes them
            findable. Everything else is prose on the page ground. */}
          <Box className={styles.rails}>
            <PageCard variant="elevated" className={styles.rail} id="stripe-support" data-testid="stripe-support-rail">
              <Typography variant="h4" component="h3" className={styles.railTitle}>
                <CreditCardOutlined fontSize="small" />
                {t('support.stripe.title')}
              </Typography>
              <Typography variant="body1" component="p" color="text.secondary">
                {t('support.stripe.body')}
              </Typography>
              {configuration.enabled ? (
                <Box className={styles.stripeForm}>
                  <TextField
                    label={t('support.stripe.amount')}
                    type="number"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    slotProps={{ htmlInput: { min: 1, max: 500, step: 1 } }}
                    fullWidth
                  />
                  <ToggleButtonGroup
                    exclusive
                    value={cadence}
                    onChange={(_, next: 'MONTHLY' | 'ONE_TIME' | null) => next && setCadence(next)}
                    fullWidth
                  >
                    <ToggleButton value="MONTHLY">{t('support.stripe.monthly')}</ToggleButton>
                    <ToggleButton value="ONE_TIME">{t('support.stripe.oneTime')}</ToggleButton>
                  </ToggleButtonGroup>
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={!hasUserChanged && publicCredit}
                        disabled={busy || !canManageSupport}
                        onChange={(event) => setPublicCredit(event.target.checked)}
                      />
                    }
                    label={isAuthenticated ? t('support.stripe.publicCredit') : t('support.stripe.publicCreditSignIn')}
                  />
                  <Typography variant="body2" component="p" color="text.secondary">
                    {t('support.stripe.publicCreditHint')}
                  </Typography>
                  <Button
                    variant="contained"
                    color="primaryFill"
                    disabled={
                      busy ||
                      isAuthUnresolved ||
                      (shouldManageSubscription && cadence === 'MONTHLY' && !canManageSupport)
                    }
                    onClick={shouldManageSubscription && cadence === 'MONTHLY' ? openBillingPortal : startCheckout}
                    sx={DONATION_CTA_SX}
                  >
                    {busy
                      ? t('support.stripe.processing')
                      : shouldManageSubscription && cadence === 'MONTHLY'
                        ? t('support.manage.billing')
                        : t('support.stripe.cta')}
                  </Button>
                </Box>
              ) : configuration.legacyDonateUrl ? (
                <Button
                  variant="contained"
                  color="primaryFill"
                  href={configuration.legacyDonateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={DONATION_CTA_SX}
                >
                  {t('support.stripe.cta')}
                </Button>
              ) : (
                <Typography variant="body2" component="p" color="text.secondary">
                  {t('support.stripe.unavailable')}
                </Typography>
              )}
            </PageCard>

            {status.hasSupported ? (
              <PageCard variant="elevated" className={styles.rail}>
                <Typography variant="h4" component="h3">
                  {t('support.manage.title')}
                </Typography>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={status.showPublicly}
                      disabled={busy || !canManageSupport}
                      onChange={(event) => void updateVisibility(event.target.checked)}
                    />
                  }
                  label={t('support.manage.publicCredit')}
                />
                {status.hasActiveSubscription ? (
                  <Button variant="outlined" disabled={busy || !canManageSupport} onClick={openBillingPortal}>
                    {t('support.manage.billing')}
                  </Button>
                ) : null}
              </PageCard>
            ) : null}

            <PageCard variant="elevated" className={styles.rail}>
              <Typography variant="h4" component="h3" className={styles.railTitle}>
                <GitHub fontSize="small" />
                {t('support.sponsors.title')}
              </Typography>
              <Typography variant="body1" component="p" color="text.secondary">
                {t('support.sponsors.body')}
              </Typography>
              <Box className={styles.railCta}>
                <Button variant="outlined" href={GITHUB_SPONSORS_URL} target="_blank" rel="noopener noreferrer">
                  {t('support.sponsors.cta')}
                </Button>
              </Box>
            </PageCard>
            {(configuration.enabled || status.hasSupported) &&
            (authError || (isAuthenticated && !authToken && !isAuthLoading)) ? (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" disabled={isAuthLoading || isRetryingAuth} onClick={() => void retryAuth()}>
                    {t('common:actions.retry')}
                  </Button>
                }
              >
                {t('support.stripe.authError')}
              </Alert>
            ) : null}
            {error && !hasUserChanged ? <Alert severity="error">{error}</Alert> : null}
          </Box>
        </PageSection>
      </Box>

      <PageSection
        className={styles.disclosure}
        title={t('support.honesty.title')}
        icon={<InfoOutlined />}
        tone="neutral"
      >
        <Prose>{t('support.honesty.p1')}</Prose>
        <Prose>{t('support.honesty.p2')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/docs" className={styles.standaloneLink}>
            {t('support.docsLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      {/* The page's second column of substance. Without it, an environment with
          no Stripe link is one card and a lot of prose. */}
      <PageSection
        title={t('support.otherWays.title')}
        lead={t('support.otherWays.body')}
        icon={<VolunteerActivismOutlined />}
        tone="neutral"
        className={styles.communitySection}
      >
        <Box className={styles.helpGrid}>
          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.bug.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.bug.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.bug.cta')}
              </MuiLink>
            </Typography>
          </Box>

          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.translate.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.translate.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={LOCALE_CATALOGS_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.translate.cta')}
              </MuiLink>
            </Typography>
          </Box>

          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.patch.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.patch.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.patch.cta')}
              </MuiLink>
            </Typography>
          </Box>

          <Box className={styles.helpItem}>
            <Typography variant="h5" component="h3">
              {t('support.otherWays.discord.title')}
            </Typography>
            <Typography variant="body2" component="p" color="text.secondary">
              {t('support.otherWays.discord.body')}
            </Typography>
            <Typography variant="body2" component="p" className={styles.helpCta}>
              <MuiLink href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
                {t('support.otherWays.discord.cta')}
              </MuiLink>
            </Typography>
          </Box>
        </Box>
      </PageSection>

      <PageSection title={t('support.thanks.title')} icon={<GroupOutlined />} tone="neutral">
        <Prose>{t('support.thanks.body')}</Prose>
        <Prose>
          <MuiLink component={LocaleLink} href="/about" className={styles.standaloneLink}>
            {t('support.aboutLink')}
          </MuiLink>
        </Prose>
      </PageSection>

      <PageSection>
        <Typography variant="body1" component="p" color="text.secondary">
          {t('support.footer')}
        </Typography>
      </PageSection>
    </PageShell>
  );
}
