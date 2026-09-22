'use client';

import React, { useState } from 'react';
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

type SupportContentProps = {
  configuration: SupportConfiguration;
  initialStatus: SupporterStatus;
  locale: string;
};

export default function SupportContent({ configuration, initialStatus, locale }: SupportContentProps) {
  const { t } = useTranslation('marketing');
  const searchParams = useSearchParams();
  const { token: authToken, isAuthenticated, isLoading: isAuthLoading } = useWsAuthToken();
  const [amount, setAmount] = useState('5');
  const [cadence, setCadence] = useState<'MONTHLY' | 'ONE_TIME'>('MONTHLY');
  const [publicCredit, setPublicCredit] = useState(initialStatus.showPublicly);
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = async () => {
    const amountInMinorUnits = Math.round(Number(amount) * 100);
    if (
      !Number.isFinite(amountInMinorUnits) ||
      amountInMinorUnits < configuration.minimumAmount ||
      amountInMinorUnits > configuration.maximumAmount
    ) {
      setError(t('support.stripe.amountError'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await createGraphQLHttpClient(authToken).request<{
        createSupportCheckoutSession: { url: string };
      }>(CREATE_SUPPORT_CHECKOUT, {
        input: { amount: amountInMinorUnits, cadence, publicCredit: isAuthenticated ? publicCredit : false, locale },
      });
      window.location.assign(response.createSupportCheckoutSession.url);
    } catch {
      setError(t('support.stripe.error'));
      setBusy(false);
    }
  };

  const updateVisibility = async (showPublicly: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await createGraphQLHttpClient(authToken).request<{
        updateSupporterVisibility: SupporterStatus;
      }>(UPDATE_SUPPORTER_VISIBILITY, { showPublicly });
      setStatus(response.updateSupporterVisibility);
    } catch {
      setError(t('support.stripe.error'));
    } finally {
      setBusy(false);
    }
  };

  const openBillingPortal = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await createGraphQLHttpClient(authToken).request<{
        createSupportBillingPortalSession: { url: string };
      }>(CREATE_SUPPORT_BILLING_PORTAL, { locale });
      window.location.assign(response.createSupportBillingPortalSession.url);
    } catch {
      setError(t('support.stripe.error'));
      setBusy(false);
    }
  };
  return (
    <PageShell
      title={t('support.hero.title')}
      lead={t('support.hero.subtitle')}
      width="wide"
      headerAlign="center"
      headerClassName={styles.hero}
      eyebrow={<Image src={resolveShellStaticAssetUrl('/brand/boardsesh-mark.png')} width={52} height={52} alt="" />}
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
      {searchParams.get('support') === 'thanks' ? <Alert severity="success">{t('support.stripe.thanks')}</Alert> : null}
      {searchParams.get('support') === 'cancelled' ? (
        <Alert severity="info">{t('support.stripe.cancelled')}</Alert>
      ) : null}
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
                        checked={publicCredit}
                        disabled={!isAuthenticated || isAuthLoading}
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
                    disabled={busy}
                    onClick={status.hasActiveSubscription && cadence === 'MONTHLY' ? openBillingPortal : startCheckout}
                    sx={DONATION_CTA_SX}
                  >
                    {busy
                      ? t('support.stripe.processing')
                      : status.hasActiveSubscription && cadence === 'MONTHLY'
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
                      disabled={busy}
                      onChange={(event) => void updateVisibility(event.target.checked)}
                    />
                  }
                  label={t('support.manage.publicCredit')}
                />
                {status.hasActiveSubscription ? (
                  <Button variant="outlined" disabled={busy} onClick={openBillingPortal}>
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
            {error ? <Alert severity="error">{error}</Alert> : null}
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
