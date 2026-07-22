import React, { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import LanguageOutlined from '@mui/icons-material/LanguageOutlined';
import TvOutlined from '@mui/icons-material/TvOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import ChatBubbleOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import {
  GET_GYM_BY_SLUG,
  GET_GYM_BOARDS,
  GET_GYM_KIOSK,
  type GetGymBySlugQueryResponse,
  type GetGymBoardsQueryResponse,
  type GetGymKioskQueryResponse,
  type GymKioskOperationResult,
} from '@boardsesh/graphql/operations';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata, createNoIndexMetadata, absoluteUrl } from '@/app/lib/seo/metadata';
import { safeExternalHref } from '@/app/lib/safe-external-url';
import { themeTokens } from '@/app/theme/theme-config';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import GymStatChip from '@/app/components/gym-entity/gym-stat-chip';
import CommentSection from '@/app/components/social/comment-section';
import GymPageManageButton from './gym-page-manage-button';
import GymFollowButton from './gym-follow-button';
import GymClaimCta from './gym-claim-cta';
import GymOwnerPrompts from './gym-owner-prompts';
import GymReportDuplicateCta from './gym-report-duplicate-cta';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymLogoDisplayUrl } from '@/app/lib/gym-logo-display-url';

type GymRouteProps = {
  params: Promise<{ gym_slug: string }>;
};

const fetchGymBySlug = cache(async (slug: string, token: string | undefined): Promise<Gym | null> => {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymBySlugQueryResponse>(GET_GYM_BY_SLUG, { slug }, token);
    return response.gymBySlug ?? null;
  } catch (error) {
    console.error('fetchGymBySlug failed:', error);
    return null;
  }
});

async function fetchDefaultKiosk(gymSlug: string, token: string | undefined): Promise<GymKioskOperationResult | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymKioskQueryResponse>(
      GET_GYM_KIOSK,
      { gymSlug, kioskSlug: null },
      token,
    );
    return response.gymKiosk ?? null;
  } catch (error) {
    console.error('fetchDefaultKiosk failed:', error);
    return null;
  }
}

async function fetchGymBoards(gymUuid: string, token: string | undefined): Promise<UserBoard[]> {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymBoardsQueryResponse>(GET_GYM_BOARDS, { gymUuid }, token);
    return response.gymBoards ?? [];
  } catch (error) {
    console.error('fetchGymBoards failed:', error);
    return [];
  }
}

/** A gym is viewable when it's public, or the viewer can edit it (private preview). */
function isGymViewable(gym: Gym | null): gym is Gym {
  return gym !== null && (gym.isPublic || gym.canEdit);
}

export async function generateMetadata(props: GymRouteProps): Promise<Metadata> {
  const { gym_slug } = await props.params;
  const token = await getServerAuthToken();
  const [gym, { t, locale }] = await Promise.all([fetchGymBySlug(gym_slug, token), getServerTranslation('kiosk')]);

  if (!isGymViewable(gym)) {
    return createNoIndexMetadata({
      title: t('metadata.fallbackTitle'),
      description: t('metadata.fallbackDescription'),
      locale,
    });
  }

  const title = t('gymPage.metaTitle', { gymName: gym.name });
  const description = gym.description?.trim() || t('gymPage.metaDescription', { gymName: gym.name });
  const options = { title, description, path: `/gym/${gym_slug}`, locale };
  return gym.isPublic ? createPageMetadata(options) : createNoIndexMetadata(options);
}

export default async function GymPage(props: GymRouteProps) {
  const { gym_slug } = await props.params;
  const token = await getServerAuthToken();
  const gym = await fetchGymBySlug(gym_slug, token);

  if (!isGymViewable(gym)) {
    notFound();
  }

  // The requested slug belonged to a merged twin: the backend resolved it to the
  // canonical gym, whose slug differs. Send the old URL (e.g. a printed kiosk QR)
  // to the canonical one with a 308 rather than serving the gym under a dead slug.
  if (gym.slug && gym.slug !== gym_slug) {
    permanentRedirect(`/gym/${gym.slug}`);
  }

  const locale = await getLocale();
  const [{ t }, { t: tBoards }] = await Promise.all([getServerTranslation('kiosk'), getServerTranslation('boards')]);
  const [kiosk, boards] = await Promise.all([fetchDefaultKiosk(gym_slug, token), fetchGymBoards(gym.uuid, token)]);

  // Stored logo paths are backend-relative; resolve for the browser (also
  // keeps the JSON-LD image absolute, as schema.org expects).
  const logoSrc = resolveGymLogoDisplayUrl(gym.logoUrl ?? null, getPublicBackendHttpUrl()) ?? gym.imageUrl ?? null;
  // Render-side XSS guard: only http(s) URLs become clickable (legacy rows may
  // predate the backend's GymWebsiteSchema scheme check).
  const websiteHref = safeExternalHref(gym.website);

  const jsonLd = gym.isPublic
    ? {
        '@context': 'https://schema.org',
        '@type': 'SportsActivityLocation',
        name: gym.name,
        url: absoluteUrl(`/gym/${gym_slug}`),
        ...(gym.description ? { description: gym.description } : {}),
        ...(gym.address ? { address: gym.address } : {}),
        ...(websiteHref ? { sameAs: websiteHref } : {}),
        ...(logoSrc ? { image: logoSrc } : {}),
      }
    : null;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards', 'kiosk']}>
      {jsonLd && (
        <script
          type="application/ld+json"
          // JSON.stringify escapes quotes; guard the one XSS vector for inline JSON-LD.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
        />
      )}
      <Container
        maxWidth="md"
        sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)', pb: 'var(--bottom-bar-height)' }}
      >
        <Box sx={{ mb: 2 }}>
          <MuiLink component={LocaleLink} href="/" underline="hover" sx={{ color: 'var(--color-primary)' }}>
            {t('gymPage.breadcrumbHome')}
          </MuiLink>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 2 }}>
          {logoSrc && (
            <Box
              component="img"
              src={logoSrc}
              alt={gym.name}
              sx={{ width: 72, height: 72, borderRadius: 2, objectFit: 'contain', flexShrink: 0 }}
            />
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h3" component="h1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
              {gym.name}
            </Typography>
            {gym.address && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                <LocationOnOutlined sx={{ fontSize: 18, color: themeTokens.neutral[400] }} />
                <Typography variant="body1" color="text.secondary">
                  {gym.address}
                </Typography>
              </Box>
            )}
          </Box>
        </Box>

        {gym.description && (
          <Typography variant="body1" sx={{ mb: 3, color: themeTokens.neutral[700] }}>
            {gym.description}
          </Typography>
        )}

        <Box sx={{ display: 'flex', gap: 2.5, flexWrap: 'wrap', mb: 3 }}>
          <GymStatChip
            icon={<FitnessCenterOutlined sx={{ fontSize: 18 }} />}
            value={gym.boardCount}
            label={tBoards('gymEntity.stats.boards')}
          />
          <GymStatChip
            icon={<PersonOutlined sx={{ fontSize: 18 }} />}
            value={gym.memberCount}
            label={tBoards('gymEntity.stats.members')}
          />
          <GymStatChip
            icon={<PeopleOutlined sx={{ fontSize: 18 }} />}
            value={gym.followerCount}
            label={tBoards('gymEntity.stats.followers')}
          />
          <GymStatChip
            icon={<ChatBubbleOutlined sx={{ fontSize: 18 }} />}
            value={gym.commentCount}
            label={tBoards('gymEntity.stats.comments')}
          />
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 3 }}>
          <GymFollowButton gymUuid={gym.uuid} ownerId={gym.ownerId} isFollowedByMe={gym.isFollowedByMe} />
          {kiosk && (
            <Button
              component={LocaleLink}
              href={`/kiosk/${gym_slug}`}
              variant="contained"
              startIcon={<TvOutlined />}
              sx={{ textTransform: 'none' }}
            >
              {t('gymPage.seeOnTheWall')}
            </Button>
          )}
          {websiteHref && (
            <MuiLink
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'var(--color-primary)' }}
            >
              <LanguageOutlined sx={{ fontSize: 18 }} />
              {t('gymPage.visitWebsite')}
            </MuiLink>
          )}
          {gym.canEdit && <GymPageManageButton gymSlug={gym_slug} />}
        </Box>

        {/* Self-gating: GymOwnerPrompts renders nothing for a non-editor (or a
            fully set-up gym), so the canEdit prop stays honest instead of being
            shadowed by an always-true outer guard. */}
        <GymOwnerPrompts
          gymSlug={gym_slug}
          canEdit={gym.canEdit}
          hasBoards={boards.length > 0}
          hasKiosk={kiosk !== null}
          hasBranding={Boolean(
            gym.logoUrl || gym.brandPrimaryColor || gym.brandAccentColor || gym.brandBackgroundColor,
          )}
        />

        {gym.canClaim && <GymClaimCta gymUuid={gym.uuid} gymName={gym.name} website={gym.website} />}

        <GymReportDuplicateCta
          gymUuid={gym.uuid}
          gymName={gym.name}
          latitude={gym.latitude}
          longitude={gym.longitude}
        />

        <Divider sx={{ mb: 3 }} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <FitnessCenterOutlined sx={{ fontSize: 20, color: themeTokens.neutral[400] }} />
          <Typography variant="h5" component="h2" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
            {t('gymPage.boardsHeading')}
          </Typography>
          {boards.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              {t('gymPage.boardCount', { count: boards.length })}
            </Typography>
          )}
        </Box>

        {/* Together with the breadcrumb above, this keeps the page at ≥2
            crawlable internal links even for a gym with no boards or kiosk. */}
        {boards.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t('gymPage.noBoardsYet')}
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {boards.map((board) => (
              <Box component="li" key={board.uuid}>
                <MuiLink
                  component={LocaleLink}
                  href={`/b/${board.slug}`}
                  underline="hover"
                  sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 1, color: 'var(--color-primary)' }}
                >
                  <Typography component="span" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                    {board.name}
                  </Typography>
                  <Typography component="span" variant="body2" color="text.secondary">
                    {`${boardTypeLabel(board.boardType)} · ${board.angle}°`}
                  </Typography>
                </MuiLink>
              </Box>
            ))}
          </Box>
        )}

        <Divider sx={{ my: 4 }} />

        <CommentSection entityType="gym" entityId={gym.uuid} title={tBoards('gymEntity.comments.title')} />

        <Box sx={{ mt: 4 }}>
          <MuiLink component={LocaleLink} href="/feed" underline="hover" sx={{ color: 'var(--color-primary)' }}>
            {t('gymPage.exploreFeed')}
          </MuiLink>
        </Box>
      </Container>
    </I18nProvider>
  );
}
