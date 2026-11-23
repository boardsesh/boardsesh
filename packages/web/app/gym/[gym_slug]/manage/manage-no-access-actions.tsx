'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import { gymClaimCtaClicked } from '@boardsesh/analytics';
import ClaimGymDialog from '@/app/components/gym-entity/claim-gym-dialog';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import type { ReportGymSubject } from '@/app/components/directory-reports/report-problem-logic';
import { GymReportProblemHost, ReportGymButton, type GymReportBoard } from '../gym-report-problem';

const NO_BOARDS: GymReportBoard[] = [];

type ManageNoAccessActionsProps = {
  gym: ReportGymSubject & { website: string | null; canClaimByDomain: boolean };
  /** The `directory-reports` flag: Report a problem renders only while the server takes reports. */
  reportsEnabled: boolean;
};

/**
 * The lock state's two actions that need the browser: Claim this gym (when
 * the viewer can) and Report a problem. The viewer is signed in here (the
 * manage route sends anyone else to log in), so both open straight away.
 */
export default function ManageNoAccessActions({ gym, reportsEnabled }: ManageNoAccessActionsProps) {
  const { t } = useTranslation('kiosk');
  const [claimOpen, setClaimOpen] = useState(false);
  // Claim this gym sits right beside the report, so the dialog doesn't offer it a second time.
  const reportGym = useMemo(() => ({ ...gym, canClaim: false }), [gym]);

  return (
    <>
      {gym.canClaim && (
        <>
          <Button
            variant="contained"
            startIcon={<VerifiedUserOutlined />}
            onClick={() => {
              // Signed in: the manage route sends everyone else to log in first.
              trackGymFunnelEvent(
                gymClaimCtaClicked({ placement: 'manage-lock', viewerState: 'signed-in', gymUuid: gym.uuid }),
              );
              setClaimOpen(true);
            }}
            sx={{ textTransform: 'none', minHeight: 44 }}
          >
            {t('gymPage.claimCta')}
          </Button>
          <ClaimGymDialog
            gymUuid={gym.uuid}
            gymName={gym.name}
            website={gym.website}
            canClaimByDomain={gym.canClaimByDomain}
            open={claimOpen}
            onClose={() => setClaimOpen(false)}
          />
        </>
      )}
      {reportsEnabled && (
        <>
          <ReportGymButton gymUuid={gym.uuid} variant="outlined" />
          <GymReportProblemHost gym={reportGym} boards={NO_BOARDS} countAsGymPageCta={false} />
        </>
      )}
    </>
  );
}
