import React from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import PeopleOutlined from '@mui/icons-material/PeopleOutlined';
import ChatBubbleOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import type { Gym, MyGymClaim, UserBoard } from '@boardsesh/shared-schema';
import {
  GET_GYM_PENDING_CLAIM,
  GET_GYM_BOARDS,
  GET_GYM_KIOSK,
  type GetGymPendingClaimQueryResponse,
  type GetGymBoardsQueryResponse,
  type GetGymKioskQueryResponse,
  type GymKioskOperationResult,
} from '@boardsesh/graphql/operations';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { parseGymQrLanding } from '@boardsesh/analytics';
import { gymQrAttributionQuery } from '@/app/lib/gym-attribution';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { executeAuthenticatedGraphQL } from '@/app/lib/graphql/server-graphql';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createPageMetadata, createNoIndexMetadata, absoluteUrl } from '@/app/lib/seo/metadata';
import { JsonLd } from '@/app/lib/seo/json-ld';
import { safeExternalHref } from '@/app/lib/safe-external-url';
import { themeTokens } from '@/app/theme/theme-config';
import I18nProvider from '@/app/components/providers/i18n-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import GymStatChip from '@/app/components/gym-entity/gym-stat-chip';
import CommentSection from '@/app/components/social/comment-section';
import GymPageManageButton from './gym-page-manage-button';
import GymFollowButton from './gym-follow-button';
import GymClaimCta from './gym-claim-cta';
import GymClaimParamCleanup from './gym-claim-param-cleanup';
import GymClaimPendingNotice from './gym-claim-pending-notice';
import { CLAIM_PARAM, resolveClaimCtaVariant, resolveClaimSurface } from './gym-claim-cta-logic';
import GymOwnerPrompts from './gym-owner-prompts';
import GymReportDuplicateCta from './gym-report-duplicate-cta';
import { formatHoursConfirmedDate } from './gym-hours-display';
import GymPageCtaLink from './gym-page-cta-link';
import GymInstallCta from './gym-install-cta';
import GymQrLandingTracker from './gym-qr-landing-tracker';
import { fetchGymBySlug, isGymViewable } from './fetch-gym-by-slug';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import { resolveGymLogoDisplayUrl, resolveGymPhotoDisplayUrl } from '@/app/lib/gym-logo-display-url';

type GymRouteProps = {
  params: Promise<{ gym_slug: string }>;
  // Same shape the manage route declares. Read for the QR-landing params a
  // printed poster carries (`?src=qr&medium=poster`); several later PRs of this
  // epic read their own params from it.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * The viewer's own claim in flight, fetched on its own so a failure degrades to
 * "no notice" instead of "no gym". `fetchGymBySlug` returning null means
 * `notFound()`, so folding this selection into that document would 404 the whole
 * page — for every gym at once — if web ever deploys ahead of the backend that
 * answers `myPendingClaim`. Only ever called for a signed-in viewer who could
 * actually hold a claim, so anonymous readers (the page's whole audience) pay
 * nothing.
 */
async function fetchMyPendingClaim(slug: string, token: string): Promise<MyGymClaim | null> {
  try {
    const response = await executeAuthenticatedGraphQL<GetGymPendingClaimQueryResponse>(
      GET_GYM_PENDING_CLAIM,
      { slug },
      token,
    );
    return response.gymBySlug?.myPendingClaim ?? null;
  } catch (error) {
    console.error('fetchMyPendingClaim failed:', error);
    return null;
  }
}

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

/**
 * Absolute, http(s)-only URL for the owner-uploaded gym photo, or null.
 *
 * Two guards, both load-bearing. safeExternalHref keeps a legacy row holding a
 * `javascript:`/`data:` value out of the `<img src>`, the JSON-LD `image` and
 * the share card — `imageUrl` was validated with a bare `z.string().url()`
 * until this feature landed, and that accepted both. And because it only
 * returns absolute URLs, a bare `/static/...` path (which would resolve
 * against www and 404 for a scraper) can never escape into metadata.
 */
function resolveGymPhotoSrc(gym: Gym): string | null {
  return safeExternalHref(resolveGymPhotoDisplayUrl(gym.imageUrl ?? null, getPublicBackendHttpUrl()));
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
  // `path` is the SLUG PATH ONLY — never concatenate anything from
  // `searchParams` into it. Every canonical and every hreflang alternate is
  // built from this string, so a query string here would give
  // `/gym/x?src=qr&medium=poster` its own canonical and split the page's
  // ranking signals across as many URLs as there are param combinations. Filter,
  // sort and attribution params all canonicalise to the clean base URL.
  // An owner-uploaded photo becomes the share card; gyms without one keep the
  // generic Boardsesh card (createPageMetadata's default). No imageWidth /
  // imageHeight for a user photo — we don't know its aspect ratio, and a wrong
  // one makes scrapers crop it.
  const photoSrc = resolveGymPhotoSrc(gym);
  const options = {
    title,
    description,
    path: `/gym/${gym_slug}`,
    locale,
    ...(photoSrc
      ? {
          imagePath: photoSrc,
          imageAlt: t('gymPage.photoAlt', { gymName: gym.name }),
          imageWidth: null,
          imageHeight: null,
        }
      : {}),
  };
  return gym.isPublic ? createPageMetadata(options) : createNoIndexMetadata(options);
}

export default async function GymPage(props: GymRouteProps) {
  const [{ gym_slug }, searchParams] = await Promise.all([props.params, props.searchParams]);
  const token = await getServerAuthToken();
  const gym = await fetchGymBySlug(gym_slug, token);

  if (!isGymViewable(gym)) {
    notFound();
  }

  // The requested slug belonged to a merged twin: the backend resolved it to the
  // canonical gym, whose slug differs. Send the old URL (e.g. a printed kiosk QR)
  // to the canonical one with a 308 rather than serving the gym under a dead slug.
  //
  // The attribution params ride along, the same way the manage route carries
  // `?tab=`. A poster is laminated and stuck to a wall; the gym it names can be
  // merged into another listing a year later, and without this the 308 dropped
  // the query and every scan of that poster landed unattributed and fired no
  // `Gym QR Scanned`. Only `src` and `medium` are re-emitted, and only after the
  // contract's parser has accepted them, so a crafted `?medium=evil` cannot ride
  // through a redirect to a URL we publish.
  //
  // The slug is percent-encoded now that a query rides behind it: a `#` in one
  // would open a fragment and swallow the params, the same case `gymQrUrl`
  // already guards when it builds the printed URL.
  if (gym.slug && gym.slug !== gym_slug) {
    permanentRedirect(`/gym/${encodeURIComponent(gym.slug)}${gymQrAttributionQuery(searchParams)}`);
  }

  const locale = await getLocale();
  const [{ t }, { t: tBoards }] = await Promise.all([getServerTranslation('kiosk'), getServerTranslation('boards')]);
  const [kiosk, boards] = await Promise.all([fetchDefaultKiosk(gym_slug, token), fetchGymBoards(gym.uuid, token)]);

  // Stored logo/photo paths are backend-relative; resolve for the browser (also
  // keeps the JSON-LD image absolute, as schema.org expects). The logo has NO
  // imageUrl fallback: a gym photo squashed into the 72×72 contain-fitted logo
  // slot is not a logo, it's a broken-looking thumbnail — the photo has its own
  // 16:9 hero below.
  const logoSrc = resolveGymLogoDisplayUrl(gym.logoUrl ?? null, getPublicBackendHttpUrl());
  const photoSrc = resolveGymPhotoSrc(gym);
  // Render-side XSS guard: only http(s) URLs become clickable (legacy rows may
  // predate the backend's GymWebsiteSchema scheme check).
  const websiteHref = safeExternalHref(gym.website);

  // Free-text hours, so nothing structured goes into the JSON-LD below —
  // schema.org's openingHoursSpecification wants a machine-readable model and
  // would be invalid fed a hand-typed line.
  const hoursText = gym.hours?.trim() || null;
  const hoursConfirmedDate = formatHoursConfirmedDate(gym.hoursUpdatedAt, locale);

  // A printed code carries `?src=qr&medium=…`. Anything else — a bare visit, a
  // hand-edited param, a crawler-mangled URL — parses to null and mounts nothing.
  const qrLanding = parseGymQrLanding(searchParams);

  // Which arm of the claim call-out to render — `hidden` for a signed-in viewer
  // who already covers this gym (owner, admin/editor, community leader), the
  // anonymous arm for everyone with no session.
  // One derivation, on the server: the island is handed the answer as
  // `viewerState` and never recomputes it.
  const claimCtaVariant = resolveClaimCtaVariant({
    serverCanClaim: gym.canClaim,
    serverHasSession: Boolean(token),
    gymIsClaimed: gym.isClaimed,
  });
  const claimParam = searchParams[CLAIM_PARAM];
  // A viewer with a claim already in flight gets the review notice instead of
  // the call-out — `canClaim` is a permission bit and stays true while their
  // claim sits in the queue. Only the signed-in arm can have one, so this is the
  // only case worth a second round trip.
  const pendingClaim = claimCtaVariant === 'signed-in' && token ? await fetchMyPendingClaim(gym_slug, token) : null;
  const claimSurface = resolveClaimSurface({
    variant: claimCtaVariant,
    gymIsPublic: gym.isPublic,
    hasPendingClaim: pendingClaim !== null,
  });

  // Prefer the real photo for search-result thumbnails; fall back to the logo.
  const structuredDataImage = photoSrc ?? logoSrc;

  const jsonLd = gym.isPublic
    ? {
        '@context': 'https://schema.org',
        '@type': 'SportsActivityLocation',
        name: gym.name,
        url: absoluteUrl(`/gym/${gym_slug}`),
        ...(gym.description ? { description: gym.description } : {}),
        ...(gym.address ? { address: gym.address } : {}),
        ...(websiteHref ? { sameAs: websiteHref } : {}),
        ...(structuredDataImage ? { image: structuredDataImage } : {}),
      }
    : null;

  return (
    <I18nProvider locale={locale} namespaces={['common', 'boards', 'kiosk']}>
      {qrLanding && <GymQrLandingTracker gymSlug={gym_slug} medium={qrLanding.medium} />}
      {jsonLd && <JsonLd data={jsonLd} />}
      <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
        <Box sx={{ mb: 2 }}>
          <MuiLink component={LocaleLink} href="/" underline="hover" sx={{ color: 'var(--color-primary)' }}>
            {t('gymPage.breadcrumbHome')}
          </MuiLink>
        </Box>

        {/* Owner-uploaded wall/board shot. Gyms without one simply don't render
            this — no placeholder art, and no effect on ranking or visibility
            anywhere; most of the long tail will never upload a photo. */}
        {photoSrc && (
          <Box
            component="img"
            src={photoSrc}
            alt={t('gymPage.photoAlt', { gymName: gym.name })}
            sx={{
              width: '100%',
              aspectRatio: '16 / 9',
              objectFit: 'cover',
              borderRadius: 2,
              display: 'block',
              mb: 3,
            }}
          />
        )}

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

        {hoursText && (
          <Box sx={{ mb: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
              <ScheduleOutlined sx={{ fontSize: 18, color: themeTokens.neutral[400] }} />
              <Typography
                variant="subtitle1"
                component="h2"
                sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}
              >
                {t('gymPage.hoursHeading')}
              </Typography>
            </Box>
            {/* The gym types its own line breaks; keep them instead of collapsing
                a week of hours into one run-on paragraph. */}
            <Typography variant="body1" sx={{ whiteSpace: 'pre-line', color: themeTokens.neutral[700] }}>
              {hoursText}
            </Typography>
            {hoursConfirmedDate && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {t('gymPage.hoursConfirmed', { date: hoursConfirmedDate })}
              </Typography>
            )}
          </Box>
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
          {/* Both CTAs render through a client island purely so the click is
              counted. The island keeps the same anchor and the same real href;
              the label is translated here on the server, so no i18n key moves. */}
          {kiosk && (
            <GymPageCtaLink
              cta="kiosk"
              gymUuid={gym.uuid}
              href={`/kiosk/${gym_slug}`}
              label={t('gymPage.seeOnTheWall')}
            />
          )}
          {websiteHref && (
            <GymPageCtaLink cta="website" gymUuid={gym.uuid} href={websiteHref} label={t('gymPage.visitWebsite')} />
          )}
          {gym.canEdit && <GymPageManageButton gymSlug={gym_slug} />}
        </Box>

        {/* The install CTA a poster scan lands on. `gym.slug || gym_slug` is the
            canonical slug: a merged twin's URL 308s onto `gym.slug` above, and a
            slug-less legacy gym has no canonical to fall back to, so the two
            paths have to agree on one campaign string per gym.
            `||`, not `??` — `slug` is nullable AND the redirect guard above is a
            truthiness check, so an empty-string slug reaches here having skipped
            the 308. `??` would pass it straight through and name the campaign
            `gym-`, collecting every such gym's installs in one bucket. */}
        <Box sx={{ mb: 3 }}>
          <Typography
            variant="subtitle1"
            component="h2"
            sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, mb: 0.5 }}
          >
            {t('gymPage.install.heading')}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1.5, color: themeTokens.neutral[700] }}>
            {t('gymPage.install.body', { gymName: gym.name })}
          </Typography>
          <GymInstallCta
            gymSlug={gym.slug || gym_slug}
            googlePlayLabel={t('gymPage.install.googlePlay')}
            appStoreLabel={t('gymPage.install.appStore')}
          />
        </Box>

        {/* Self-gating: GymOwnerPrompts renders nothing for a non-editor (or a
            fully set-up gym), so the canEdit prop stays honest instead of being
            shadowed by an always-true outer guard. */}
        <GymOwnerPrompts
          gymSlug={gym_slug}
          canEdit={gym.canEdit}
          hasBoards={boards.length > 0}
          hasHours={Boolean(hoursText)}
          hasDescription={Boolean(gym.description?.trim())}
          hasKiosk={kiosk !== null}
          hasBranding={Boolean(
            gym.logoUrl || gym.brandPrimaryColor || gym.brandAccentColor || gym.brandBackgroundColor,
          )}
        />

        {/* `viewerState` is the server's answer, taken from the request cookie
            above — reading it in the island with useSession() would report the
            pre-hydration `loading` state as signed-out on exactly the taps this
            event cares about. The `isPublic` clause is spelled out rather than
            leaning on `isGymViewable`: a private gym reaches this line only via
            its own editors, and the anonymous arm has to stay impossible there
            even if the viewability rule is loosened later. */}
        {claimSurface.kind === 'cta' ? (
          <GymClaimCta
            gymUuid={gym.uuid}
            gymName={gym.name}
            gymSlug={gym_slug}
            website={gym.website}
            canClaimByDomain={gym.canClaimByDomain}
            viewerState={claimSurface.viewerState}
            claimParam={claimParam}
          />
        ) : (
          /* No call-out to clear the return-from-auth param, so clear it here:
             an owner or community leader who signed in and turned out to
             already cover this gym — or an anonymous visitor on a gym someone
             already runs — would otherwise sit on a live `?claim=1`. A returning
             claimant whose claim is already queued lands here too: the notice
             replaces the dialog `?claim=1` would have re-opened. */
          <>
            {claimSurface.kind === 'pending' && pendingClaim && <GymClaimPendingNotice method={pendingClaim.method} />}
            <GymClaimParamCleanup claimParam={claimParam} />
          </>
        )}

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
          <MuiLink component={LocaleLink} href="/playlists" underline="hover" sx={{ color: 'var(--color-primary)' }}>
            {t('gymPage.explorePlaylists')}
          </MuiLink>
        </Box>
      </Container>
    </I18nProvider>
  );
}
