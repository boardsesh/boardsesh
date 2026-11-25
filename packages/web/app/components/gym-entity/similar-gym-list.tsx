'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import MuiButton from '@mui/material/Button';
import MuiTypography from '@mui/material/Typography';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import VerifiedOutlined from '@mui/icons-material/VerifiedOutlined';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { SimilarGym } from '@boardsesh/shared-schema';
import { gymClaimCtaClicked, type GymClaimPlacement } from '@boardsesh/analytics';
import { trackGymFunnelEvent, viewerStateFrom } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';
import ClaimGymDialog from './claim-gym-dialog';

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Gyms already listed that look like the one being added: name, address,
 * distance, provider badge, a link to the gym and Claim where the viewer may.
 * Shared by the as-you-type suggestions and createGym's GYM_SIMILAR_EXISTS
 * refusal, so both name a gym the same way.
 */
export default function SimilarGymList({
  gyms,
  claimPlacement,
}: {
  gyms: readonly SimilarGym[];
  /** Where a Claim click is counted from: the live suggestions or the refusal dialog. */
  claimPlacement: Extract<GymClaimPlacement, 'similar-gyms' | 'similar-gyms-refusal'>;
}) {
  const { t } = useTranslation('boards');
  // `isAuthenticated` rather than useSession().status: both lists only exist
  // once a signed-in request returned them, so the session has settled.
  const { isAuthenticated } = useWsAuthToken();
  const [claimTarget, setClaimTarget] = useState<SimilarGym | null>(null);

  const formatDistance = (distanceMeters: number | null | undefined): string | null => {
    if (distanceMeters == null) return null;
    if (distanceMeters < 1000) {
      return t('similarGyms.distanceMeters', { meters: Math.round(distanceMeters) });
    }
    return t('similarGyms.distanceKm', { km: (distanceMeters / 1000).toFixed(1) });
  };

  return (
    <>
      <Stack spacing={1}>
        {gyms.map((gym) => {
          const distanceLabel = formatDistance(gym.distanceMeters);
          // /gym/[slug] resolves via gymBySlug, which can't resolve a uuid — so
          // only offer the link when there's a real slug.
          const gymHref = gym.slug ? `/gym/${gym.slug}` : null;
          return (
            <Card key={gym.uuid} variant="outlined" sx={{ borderRadius: `${themeTokens.borderRadius.md}px` }}>
              <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                <MuiTypography
                  variant="subtitle2"
                  sx={{
                    fontWeight: themeTokens.typography.fontWeight.semibold,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {gym.name}
                </MuiTypography>

                {gym.address && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                    <LocationOnOutlined sx={{ fontSize: 14, color: 'var(--neutral-400)' }} />
                    <MuiTypography
                      variant="body2"
                      color="text.secondary"
                      sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {gym.address}
                    </MuiTypography>
                  </Box>
                )}

                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, mt: 1 }}>
                  {distanceLabel && <Chip size="small" variant="outlined" label={distanceLabel} />}
                  {gym.providerOrigins.map((origin) => (
                    <Chip
                      key={origin}
                      size="small"
                      color="primary"
                      variant="outlined"
                      icon={<VerifiedOutlined sx={{ fontSize: 14 }} />}
                      label={t('similarGyms.providerBadge', { provider: capitalize(origin) })}
                    />
                  ))}
                </Box>

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
                  {gymHref && (
                    <MuiButton
                      component={LocaleLink}
                      href={gymHref}
                      size="small"
                      variant="text"
                      startIcon={<OpenInNewOutlined />}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('similarGyms.viewGym')}
                    </MuiButton>
                  )}
                  {gym.isClaimable && (
                    <MuiButton
                      size="small"
                      variant="contained"
                      onClick={() => {
                        trackGymFunnelEvent(
                          gymClaimCtaClicked({
                            placement: claimPlacement,
                            viewerState: viewerStateFrom(isAuthenticated),
                            gymUuid: gym.uuid,
                          }),
                        );
                        setClaimTarget(gym);
                      }}
                      sx={{ textTransform: 'none' }}
                    >
                      {t('similarGyms.claim')}
                    </MuiButton>
                  )}
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Stack>

      {claimTarget && (
        <ClaimGymDialog
          gymUuid={claimTarget.uuid}
          gymName={claimTarget.name}
          website={claimTarget.website}
          canClaimByDomain={claimTarget.canClaimByDomain}
          open={claimTarget !== null}
          onClose={() => setClaimTarget(null)}
        />
      )}
    </>
  );
}
