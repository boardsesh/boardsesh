'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import ReportDuplicateDialog from '@/app/components/gym-entity/report-duplicate-dialog';

type GymReportDuplicateCtaProps = {
  gymUuid: string;
  gymName: string;
  latitude?: number | null;
  longitude?: number | null;
};

/**
 * Client island: a low-key "report a duplicate" flag on the public gym page. Any
 * signed-in climber who spots a second listing of this gym can point us at it; the
 * island renders nothing for logged-out visitors (the page's main SEO audience).
 */
export default function GymReportDuplicateCta({ gymUuid, gymName, latitude, longitude }: GymReportDuplicateCtaProps) {
  const { t } = useTranslation('boards');
  const { status } = useSession();
  const [open, setOpen] = useState(false);

  if (status !== 'authenticated') return null;

  return (
    <Box sx={{ mb: 3 }}>
      <Button
        variant="text"
        size="small"
        startIcon={<FlagOutlined sx={{ fontSize: 16 }} />}
        onClick={() => setOpen(true)}
        sx={{ textTransform: 'none', color: 'text.secondary' }}
      >
        {t('reportDuplicate.cta')}
      </Button>
      <ReportDuplicateDialog
        gymUuid={gymUuid}
        gymName={gymName}
        latitude={latitude}
        longitude={longitude}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}
