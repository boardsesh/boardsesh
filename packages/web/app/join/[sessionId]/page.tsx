import React from 'react';
import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { buildVersionedOgImagePath, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '@/app/lib/seo/og';
import { getSessionOgSummary } from '@/app/lib/seo/dynamic-og-data';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageShell } from '@/app/components/ui/page-shell';
import { fetchSessionInvite } from './session-invite';
import SessionInviteInstallCta from './session-invite-install-cta';
import SessionInviteLandingTracker from './session-invite-landing-tracker';
import SessionInviteOpenApp from './session-invite-open-app';

type Props = {
  params: Promise<{ sessionId: string }>;
};

// A session invite is a utility page for one crew, on every branch: live,
// ended, missing, or when the lookup itself failed.
const NO_INDEX_FOLLOW = { index: false, follow: true } as const;

const DIFFICULTY_TO_GRADE: Record<number, string> = Object.fromEntries(
  BOULDER_GRADES.map((g) => [g.difficulty_id, g.font_grade]),
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);
  const { t } = await getServerTranslation('session');

  const buildJoinHeadline = (leaderName: string | null): string =>
    leaderName ? t('metadata.join.headlineWithLeader', { name: leaderName }) : t('metadata.join.headlineDefault');

  const buildGradeSummary = (grades: string[]): string => {
    if (grades.length === 0) {
      return '';
    }
    if (grades.length === 1) {
      return t('metadata.join.gradeOn', { grade: grades[0] });
    }
    return t('metadata.join.gradeRange', { first: grades[0], last: grades[grades.length - 1] });
  };

  try {
    const summary = await getSessionOgSummary(sessionId);

    if (!summary.found) {
      return { title: `${t('metadata.detail.notFoundTitle')} | Boardsesh`, robots: NO_INDEX_FOLLOW };
    }

    const sessionName = summary.sessionName;
    const grades = summary.gradeRows.map((r) => DIFFICULTY_TO_GRADE[r.difficulty]).filter(Boolean);
    const gradeSummary = buildGradeSummary(grades);
    const joinHeadline = buildJoinHeadline(summary.leaderName);
    let boardInfo: string | null;
    if (summary.boardLabel) {
      boardInfo =
        summary.boardAngle != null
          ? t('metadata.join.boardAtAngle', { boardLabel: summary.boardLabel, angle: summary.boardAngle })
          : summary.boardLabel;
    } else {
      boardInfo = null;
    }

    const title = `${joinHeadline} | Boardsesh`;
    let description: string;
    if (boardInfo) {
      if (summary.totalSends > 0) {
        description = t('metadata.join.descriptionBoardWithSends', {
          count: summary.totalSends,
          boardInfo,
          gradeSummary,
        });
      } else {
        description = t('metadata.join.descriptionBoardNoSends', { boardInfo });
      }
    } else if (sessionName && sessionName !== 'Climbing Session') {
      description = t('metadata.join.descriptionLive', { sessionName });
    } else {
      description = t('metadata.join.descriptionDefault');
    }

    const ogImagePath = buildVersionedOgImagePath('/api/og/session', { sessionId, variant: 'join' }, summary.version);

    return {
      title,
      description,
      robots: NO_INDEX_FOLLOW,
      openGraph: {
        title,
        description,
        type: 'website',
        url: `/join/${sessionId}`,
        images: [
          {
            url: ogImagePath,
            width: OG_IMAGE_WIDTH,
            height: OG_IMAGE_HEIGHT,
            alt: joinHeadline,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [ogImagePath],
      },
    };
  } catch {
    return {
      title: `${t('metadata.join.title')} | Boardsesh`,
      description: t('metadata.join.description'),
      robots: NO_INDEX_FOLLOW,
    };
  }
}

/**
 * The session invite page (#6004).
 *
 * It used to render a spinner and redirect, in JavaScript, to a board list with
 * no way to get the app. Someone sent an invite who had no app saw nothing
 * about the invite at all. Now the server renders who is hosting, on which
 * board and at which gym, with both store buttons, and says plainly when a
 * session has ended or the link names nothing.
 *
 * A phone WITH the app normally never gets here: the universal link (iOS) and
 * the `/join` App Link (Android) open the app's own join screen first. The
 * exception is a link tapped inside another app's built-in browser, which
 * skips both; `SessionInviteOpenApp` is for that visitor.
 *
 * Always a 200, including for a missing session. The page still has something
 * to offer that visitor (the app), which a 404 page would not, and every branch
 * is `noindex`.
 */
export default async function JoinSessionPage({ params }: Props) {
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId);
  const { t } = await getServerTranslation('session');

  const invite = await fetchSessionInvite(sessionId);
  const isJoinable = invite.state === 'live' || invite.state === 'dormant';
  // `unavailable` means the lookup failed, not that the session is gone: keep
  // the invite framing and the id, and drop only the details we could not read.
  const isInviteOpen = isJoinable || invite.state === 'unavailable';
  // A missing session has no id worth carrying into install data or analytics:
  // it is whatever text sat in the URL.
  const linkSessionId = invite.state === 'not_found' ? undefined : sessionId;

  let title: string;
  let lead: string;
  if (invite.state === 'ended') {
    title = t('invitePage.ended.title');
    lead = t('invitePage.ended.lead');
  } else if (invite.state === 'not_found') {
    title = t('invitePage.notFound.title');
    lead = t('invitePage.notFound.lead');
  } else {
    title = invite.hostName
      ? t('invitePage.headingWithHost', { name: invite.hostName })
      : t('invitePage.headingDefault');
    if (invite.state === 'live') lead = t('invitePage.leadLive');
    else if (invite.state === 'dormant') lead = t('invitePage.leadDormant');
    else lead = t('invitePage.unavailable.lead');
  }

  let boardValue: string | null = null;
  if (invite.boardLabel) {
    boardValue =
      invite.boardAngle != null
        ? t('metadata.join.boardAtAngle', { boardLabel: invite.boardLabel, angle: invite.boardAngle })
        : invite.boardLabel;
  }
  const details = [
    { label: t('invitePage.hostLabel'), value: invite.hostName },
    { label: t('invitePage.boardLabel'), value: boardValue },
    { label: t('invitePage.gymLabel'), value: invite.gymName },
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail.value));

  return (
    <PageShell title={title} lead={lead} eyebrow={t('invitePage.eyebrow')}>
      <SessionInviteLandingTracker
        sessionId={linkSessionId}
        state={invite.state}
        hasHost={invite.hostName !== null}
        hasGym={invite.gymName !== null}
      />

      {details.length > 0 && (
        <Box component="section" sx={{ mb: 4 }}>
          <Typography
            variant="subtitle1"
            component="h2"
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 1 }}
          >
            {t('invitePage.detailsHeading')}
          </Typography>
          <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2 }}>
            {details.map((detail) => (
              <React.Fragment key={detail.label}>
                <Typography component="dt" variant="body2" color="text.secondary">
                  {detail.label}
                </Typography>
                <Typography component="dd" variant="body1" sx={{ m: 0 }}>
                  {detail.value}
                </Typography>
              </React.Fragment>
            ))}
          </Box>
        </Box>
      )}

      <Box component="section" sx={{ mb: 4 }}>
        <Typography
          variant="subtitle1"
          component="h2"
          sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 0.5 }}
        >
          {isInviteOpen ? t('invitePage.installHeading') : t('invitePage.getAppHeading')}
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
          {isInviteOpen ? t('invitePage.installBody') : t('invitePage.getAppBody')}
        </Typography>
        <SessionInviteInstallCta
          sessionId={linkSessionId}
          googlePlayLabel={t('invitePage.googlePlay')}
          appStoreLabel={t('invitePage.appStore')}
        />
        {isInviteOpen && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2, maxWidth: '68ch' }}>
            {t('invitePage.haveApp')}
          </Typography>
        )}
        {isInviteOpen && <SessionInviteOpenApp sessionId={sessionId} label={t('invitePage.openInApp')} />}
      </Box>

      <MuiLink component={LocaleLink} href="/">
        {t('invitePage.learnMore')}
      </MuiLink>
    </PageShell>
  );
}
