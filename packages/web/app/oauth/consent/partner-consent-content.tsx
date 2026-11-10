'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MuiDivider from '@mui/material/Divider';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import ReplayOutlined from '@mui/icons-material/ReplayOutlined';
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined';
import { visuallyHidden } from '@mui/utils';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import {
  fetchConsentDetails,
  safeAppLink,
  sendConsentDecision,
  type ConsentDetails,
  type ConsentProblem,
  type ConsentRedirect,
} from '@/app/lib/partner-oauth/consent-api';
import type { PartnerConsentView } from '@/app/lib/partner-oauth/page-views';
import { themeTokens } from '@/app/theme/theme-config';
import { PartnerOAuthMessage, PartnerOAuthTitle } from '../partner-oauth-layout';

type ConsentFormView = Extract<PartnerConsentView, { kind: 'consent' }>;

/** Scopes that only read. The "can't change anything" line shows only when every requested scope is one. */
const READ_ONLY_SCOPES: ReadonlySet<string> = new Set(['profile:read', 'logbook:read', 'offline_access']);

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; details: ConsentDetails; sending: 'allow' | 'deny' | null }
  | { kind: 'answered'; redirect: ConsentRedirect; appName: string }
  | { kind: 'problem'; problem: ConsentProblem; appName: string | null; retry: RetryAction | null };

type RetryAction = { kind: 'details' } | { kind: 'decision'; accept: boolean; details: ConsentDetails };

/** Problems a second try can fix. The rest need a new link, a sign-in or the app. */
const RETRYABLE_PROBLEMS: ReadonlySet<ConsentProblem> = new Set(['busy', 'failed']);

/** The app's registered name, or the screen's word for an app without one. */
function appDisplayName(details: ConsentDetails, unnamed: string): string {
  return details.client.name?.trim() || unnamed;
}

/** The publisher the developer registered. Nothing stands in for a missing one, least of all their account name. */
function publisherDisplayName(details: ConsentDetails): string | null {
  return details.client.publisherName?.trim() || null;
}

function ScopeLine({ scope, includesOnlyMeTicks }: ConsentDetails['scopes'][number]) {
  const { t } = useTranslation('oauth');
  const label = (() => {
    switch (scope) {
      case 'profile:read':
        return t('consent.scopes.profileRead');
      case 'logbook:read':
        return t('consent.scopes.logbookRead');
      case 'offline_access':
        return t('consent.scopes.offlineAccess');
      default:
        return t('consent.scopes.other', { scope });
    }
  })();
  return (
    <Box component="li" sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
      <CheckCircleOutlined aria-hidden sx={{ color: themeTokens.colors.primary, fontSize: 22, mt: '1px' }} />
      <Box>
        <Typography variant="body1">{label}</Typography>
        {/* Decision 21: approving logbook:read shares the ticks the climber keeps to "Only me". */}
        {includesOnlyMeTicks ? (
          <Typography
            variant="body2"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mt: 0.5,
              fontWeight: themeTokens.typography.fontWeight.medium,
            }}
          >
            <LockOutlined aria-hidden sx={{ fontSize: 16 }} />
            {t('consent.scopes.logbookOnlyMe')}
          </Typography>
        ) : null}
        {/* #7387: the full climb behind every tick, unlisted climbs and drafts set by others included. */}
        {scope === 'logbook:read' ? (
          <Typography
            variant="body2"
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 0.5,
              mt: 0.5,
              fontWeight: themeTokens.typography.fontWeight.medium,
            }}
          >
            <VisibilityOffOutlined aria-hidden sx={{ fontSize: 16, mt: '2px' }} />
            {t('consent.scopes.logbookUnlisted')}
          </Typography>
        ) : null}
        {/* The serializer's one exception: someone else's non-public Spraywall keeps its climbs' names. */}
        {scope === 'logbook:read' ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, pl: 2.5 }}>
            {t('consent.scopes.logbookSpraywall')}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

function AppLinks({ details, appName }: { details: ConsentDetails; appName: string }) {
  const { t } = useTranslation('oauth');
  const links = [
    { href: safeAppLink(details.client.homepageUrl), label: t('consent.links.homepage') },
    { href: safeAppLink(details.client.privacyPolicyUrl), label: t('consent.links.privacy') },
    { href: safeAppLink(details.client.termsUrl), label: t('consent.links.terms') },
  ].filter((link): link is { href: string; label: string } => link.href !== null);
  if (links.length === 0) return null;
  return (
    <Box component="nav" aria-label={t('consent.links.label', { app: appName })}>
      <Box
        component="ul"
        sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5 }}
      >
        {links.map((link) => (
          <li key={link.label}>
            <MuiLink href={link.href} target="_blank" rel="noopener noreferrer" variant="body2">
              {link.label}
              <Box component="span" sx={visuallyHidden}>
                {` ${t('consent.links.newTab')}`}
              </Box>
            </MuiLink>
          </li>
        ))}
      </Box>
    </Box>
  );
}

type ConsentFormProps = {
  view: ConsentFormView;
  details: ConsentDetails;
  sending: 'allow' | 'deny' | null;
  focusTitle: boolean;
  onAnswer: (accept: boolean) => void;
};

function ConsentForm({ view, details, sending, focusTitle, onAnswer }: ConsentFormProps) {
  const { t } = useTranslation('oauth');
  const appName = appDisplayName(details, t('consent.unnamedApp'));
  const publisher = publisherDisplayName(details);
  const readOnly = details.scopes.length > 0 && details.scopes.every(({ scope }) => READ_ONLY_SCOPES.has(scope));
  const headingId = useId();

  return (
    <Stack spacing={3}>
      <Stack spacing={1.5}>
        <PartnerOAuthTitle focusOnMount={focusTitle}>
          {details.reconnect ? t('consent.titleReconnect', { app: appName }) : t('consent.title', { app: appName })}
        </PartnerOAuthTitle>
        {publisher ? (
          <Typography
            variant="body1"
            sx={{ overflowWrap: 'anywhere', fontWeight: themeTokens.typography.fontWeight.medium }}
          >
            {t('consent.publisher', { publisher })}
          </Typography>
        ) : null}
        {view.account ? (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {t('consent.signedInAs', { account: view.account })}{' '}
            <MuiLink component={LocaleLink} href={view.signOutPath}>
              {t('consent.signOut')}
            </MuiLink>
          </Typography>
        ) : null}
      </Stack>

      {details.reconnect ? (
        <Typography variant="body2" color="text.secondary">
          {t('consent.reconnect', { app: appName })}
        </Typography>
      ) : null}

      <Box component="section" aria-labelledby={headingId}>
        <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 1.5 }}>
          {t('consent.canHeading', { app: appName })}
        </Typography>
        <Stack component="ul" spacing={1.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {details.scopes.map((scope) => (
            <ScopeLine key={scope.scope} {...scope} />
          ))}
        </Stack>
        {readOnly ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {t('consent.cannot')}
          </Typography>
        ) : null}
      </Box>

      <MuiDivider />

      <Stack spacing={1.5}>
        {details.reviewed ? null : (
          <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <InfoOutlined aria-hidden sx={{ fontSize: 18, mt: '1px' }} />
            {t('consent.notReviewed')}
          </Typography>
        )}
        <AppLinks details={details} appName={appName} />
        {details.client.redirectHost ? (
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {t('consent.redirect', { host: details.client.redirectHost })}
          </Typography>
        ) : null}
      </Stack>

      <Stack spacing={1.5} aria-busy={sending !== null}>
        <Button
          variant="contained"
          size="large"
          fullWidth
          disabled={sending !== null}
          onClick={() => onAnswer(true)}
          startIcon={sending === 'allow' ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
        >
          {t('consent.allow')}
        </Button>
        <Button
          variant="outlined"
          size="large"
          fullWidth
          disabled={sending !== null}
          onClick={() => onAnswer(false)}
          startIcon={sending === 'deny' ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
        >
          {t('consent.deny')}
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary">
        {t('consent.disconnect')}
      </Typography>
    </Stack>
  );
}

function BackToAppButton({ url, appName }: { url: string; appName: string }) {
  const { t } = useTranslation('oauth');
  return (
    <Button variant="contained" size="large" fullWidth href={url}>
      {t('consent.backToApp', { app: appName })}
    </Button>
  );
}

function AnsweredMessage({ redirect, appName }: { redirect: ConsentRedirect; appName: string }) {
  const { t } = useTranslation('oauth');
  const action = <BackToAppButton url={redirect.url} appName={appName} />;
  switch (redirect.kind) {
    case 'connected':
      return (
        <PartnerOAuthMessage
          tone="done"
          focusOnMount
          title={t('consent.connected.title', { app: appName })}
          body={t('consent.connected.body', { app: appName })}
          actions={action}
        />
      );
    case 'declined':
      return (
        <PartnerOAuthMessage
          tone="info"
          focusOnMount
          title={t('consent.declined.title', { app: appName })}
          body={t('consent.declined.body', { app: appName })}
          actions={action}
        />
      );
    case 'app-full':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount
          title={t('consent.appFull.title', { app: appName })}
          body={t('consent.appFull.body')}
          actions={action}
        />
      );
    case 'app-not-ready':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount
          title={t('consent.appNotReady.title', { app: appName })}
          body={t('consent.appNotReady.body')}
          actions={action}
        />
      );
    case 'app-error':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount
          title={t('consent.appError.title', { app: appName })}
          body={t('consent.appError.body', { app: appName })}
          actions={action}
        />
      );
  }
}

type ProblemMessageProps = {
  problem: ConsentProblem;
  appName: string | null;
  signInPath: string;
  onRetry: (() => void) | null;
  focusTitle: boolean;
};

function ConsentProblemMessage({ problem, appName, signInPath, onRetry, focusTitle }: ProblemMessageProps) {
  const { t } = useTranslation('oauth');
  const retryButton = onRetry ? (
    <Button variant="contained" size="large" fullWidth onClick={onRetry} startIcon={<ReplayOutlined aria-hidden />}>
      {t('consent.tryAgain')}
    </Button>
  ) : null;
  switch (problem) {
    case 'sign-in-again':
      return (
        <PartnerOAuthMessage
          tone="info"
          focusOnMount={focusTitle}
          title={t('consent.signInAgain.title')}
          body={t('consent.signInAgain.body')}
          actions={
            <Button variant="contained" size="large" fullWidth component={LocaleLink} href={signInPath}>
              {t('consent.signInAgain.button')}
            </Button>
          }
        />
      );
    case 'expired':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount={focusTitle}
          title={t('states.expired.title')}
          body={t('states.expired.body')}
        />
      );
    case 'app-unavailable':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount={focusTitle}
          title={t('consent.appUnavailable.title')}
          body={t('consent.appUnavailable.body')}
        />
      );
    case 'app-full':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount={focusTitle}
          title={t('consent.appFull.title', { app: appName ?? t('consent.unnamedApp') })}
          body={t('consent.appFull.body')}
        />
      );
    case 'unavailable':
      return (
        <PartnerOAuthMessage
          tone="info"
          focusOnMount={focusTitle}
          title={t('states.unavailable.title')}
          body={t('states.unavailable.body')}
        />
      );
    case 'busy':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount={focusTitle}
          title={t('consent.busy.title')}
          body={t('consent.busy.body')}
          actions={retryButton}
        />
      );
    case 'failed':
      return (
        <PartnerOAuthMessage
          tone="problem"
          focusOnMount={focusTitle}
          title={t('consent.failed.title')}
          body={t('consent.failed.body')}
          actions={retryButton}
        />
      );
  }
}

function LoadingConsent() {
  const { t } = useTranslation('oauth');
  return (
    <Stack spacing={2} sx={{ alignItems: 'center', py: 4 }}>
      <CircularProgress aria-hidden />
      <Typography variant="body2" color="text.secondary">
        {t('consent.loading')}
      </Typography>
    </Stack>
  );
}

/** The live part of `/oauth/consent`: asks what the link is for, then sends the climber's answer. */
function PartnerConsentFlow({ view }: { view: ConsentFormView }) {
  const { t } = useTranslation('oauth');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // Focus follows a change of state, never the first render.
  const [changedState, setChangedState] = useState(false);

  const moveTo = useCallback((next: Phase) => {
    setPhase(next);
    setChangedState(true);
  }, []);

  const loadDetails = useCallback(async () => {
    const outcome = await fetchConsentDetails(view.signedQuery);
    if (outcome.kind === 'ready') moveTo({ kind: 'ready', details: outcome.details, sending: null });
    else moveTo({ kind: 'problem', problem: outcome.problem, appName: null, retry: { kind: 'details' } });
  }, [view.signedQuery, moveTo]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  const answer = useCallback(
    async (details: ConsentDetails, accept: boolean) => {
      const appName = appDisplayName(details, t('consent.unnamedApp'));
      setPhase({ kind: 'ready', details, sending: accept ? 'allow' : 'deny' });
      const outcome = await sendConsentDecision(view.signedQuery, accept);
      if (outcome.kind === 'problem') {
        moveTo({ kind: 'problem', problem: outcome.problem, appName, retry: { kind: 'decision', accept, details } });
        return;
      }
      moveTo({ kind: 'answered', redirect: outcome.redirect, appName });
      // The app hears a code or a refusal on its own redirect. A full app is
      // explained here first, and the button below carries the same redirect.
      if (outcome.redirect.kind === 'connected' || outcome.redirect.kind === 'declined') {
        window.location.assign(outcome.redirect.url);
      }
    },
    [view.signedQuery, moveTo, t],
  );

  const retryHandler = (action: RetryAction | null, problem: ConsentProblem): (() => void) | null => {
    if (!action || !RETRYABLE_PROBLEMS.has(problem)) return null;
    if (action.kind === 'details') {
      return () => {
        setPhase({ kind: 'loading' });
        void loadDetails();
      };
    }
    return () => void answer(action.details, action.accept);
  };

  const status =
    phase.kind === 'loading'
      ? t('consent.loading')
      : phase.kind === 'ready' && phase.sending !== null
        ? t('consent.sending')
        : '';

  return (
    <>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {status}
      </Box>
      {phase.kind === 'loading' ? <LoadingConsent /> : null}
      {phase.kind === 'ready' ? (
        <ConsentForm
          view={view}
          details={phase.details}
          sending={phase.sending}
          focusTitle={changedState}
          onAnswer={(accept) => void answer(phase.details, accept)}
        />
      ) : null}
      {phase.kind === 'answered' ? <AnsweredMessage redirect={phase.redirect} appName={phase.appName} /> : null}
      {phase.kind === 'problem' ? (
        <ConsentProblemMessage
          problem={phase.problem}
          appName={phase.appName}
          signInPath={view.signInPath}
          focusTitle={changedState}
          onRetry={retryHandler(phase.retry, phase.problem)}
        />
      ) : null}
    </>
  );
}

/** `/oauth/consent`: what an app asks for, and the climber's answer. */
export default function PartnerConsentContent({ view }: { view: PartnerConsentView }) {
  const { t } = useTranslation('oauth');
  switch (view.kind) {
    case 'unavailable':
      return (
        <PartnerOAuthMessage tone="info" title={t('states.unavailable.title')} body={t('states.unavailable.body')} />
      );
    case 'invalid':
      return (
        <PartnerOAuthMessage tone="problem" title={t('states.invalidLink.title')} body={t('states.invalidLink.body')} />
      );
    case 'expired':
      return <PartnerOAuthMessage tone="problem" title={t('states.expired.title')} body={t('states.expired.body')} />;
    case 'sign-in-again':
      return (
        <ConsentProblemMessage
          problem="sign-in-again"
          appName={null}
          signInPath={view.signInPath}
          onRetry={null}
          focusTitle={false}
        />
      );
    case 'consent':
      return <PartnerConsentFlow view={view} />;
  }
}
