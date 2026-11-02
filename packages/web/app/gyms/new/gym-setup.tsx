'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stepper from '@mui/material/Stepper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Typography from '@mui/material/Typography';
import type { Gym } from '@boardsesh/shared-schema';
import CreateGymForm from '@/app/components/gym-entity/create-gym-form';
import EditGymForm from '@/app/components/gym-entity/edit-gym-form';
import { GymBoardAssociation } from '@/app/components/gym-entity/manage/gym-boards-tab';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageCard } from '@/app/components/ui/page-shell';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { refreshGymDirectory } from './actions';

export default function GymSetup({ initialGym }: { initialGym: Gym | null }) {
  const { t } = useTranslation('gyms');
  const router = useLocaleRouter();
  const queryClient = useQueryClient();
  const [gym, setGym] = useState(initialGym);
  const [step, setStep] = useState(initialGym ? 1 : 0);
  const [directoryStale, setDirectoryStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const currentGymUuidRef = useRef(initialGym?.uuid ?? null);

  useEffect(() => {
    const nextGymUuid = initialGym?.uuid ?? null;
    // A server action can refresh the same gym while its editor has unsaved
    // changes. Only navigation to another gym should reset the current step.
    if (nextGymUuid === currentGymUuidRef.current) return;
    currentGymUuidRef.current = nextGymUuid;
    setGym(initialGym);
    setStep(initialGym ? 1 : 0);
  }, [initialGym]);

  const refreshDirectory = useCallback(
    async (gymUuid: string) => {
      setRefreshing(true);
      try {
        const refreshed = await refreshGymDirectory(gymUuid);
        setDirectoryStale(!refreshed);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['myGyms'] }),
          queryClient.invalidateQueries({ queryKey: ['myBoards'] }),
          queryClient.invalidateQueries({ queryKey: ['gym-directory-near-me'] }),
        ]);
      } catch {
        setDirectoryStale(true);
      } finally {
        setRefreshing(false);
      }
    },
    [queryClient],
  );

  const handleSaved = useCallback(
    async (savedGym: Gym) => {
      // Retain the successful create before doing cache work. A cache outage
      // must leave a saved gym ready to resume, never another Create button.
      currentGymUuidRef.current = savedGym.uuid;
      setGym(savedGym);
      setStep(1);
      router.replace(`/gyms/new?gym=${encodeURIComponent(savedGym.uuid)}`, { scroll: false });
      await refreshDirectory(savedGym.uuid);
    },
    [router, refreshDirectory],
  );

  const handleAssociated = useCallback(async () => {
    if (gym) await refreshDirectory(gym.uuid);
  }, [gym, refreshDirectory]);

  const gymHref = gym?.slug ? `/gym/${gym.slug}` : `/gym/${gym?.uuid ?? ''}/manage`;

  return (
    <Box>
      <Stepper activeStep={step} sx={{ mb: 3 }}>
        <Step>
          <StepLabel>{t('create.details')}</StepLabel>
        </Step>
        <Step>
          <StepLabel>{t('create.boards')}</StepLabel>
        </Step>
      </Stepper>

      {directoryStale && gym && (
        <Alert
          severity="warning"
          sx={{ mb: 2 }}
          action={
            <Button disabled={refreshing} onClick={() => void refreshDirectory(gym.uuid)}>
              {t('create.refreshRetry')}
            </Button>
          }
        >
          {t('create.refreshError')}
        </Alert>
      )}

      <PageCard>
        {step === 0 ? (
          gym ? (
            <EditGymForm
              gym={gym}
              submitLabel={t('create.continue')}
              onSuccess={handleSaved}
              onCancel={() => setStep(1)}
            />
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t('create.managerHint')}
              </Typography>
              <CreateGymForm
                submitLabel={t('create.continue')}
                onSuccess={handleSaved}
                onCancel={() => router.push('/gyms')}
              />
            </>
          )
        ) : (
          gym && (
            <>
              <Alert severity="success" sx={{ mb: 3 }}>
                {t('create.saved', { name: gym.name })}
              </Alert>
              <GymBoardAssociation gym={gym} onAssociated={handleAssociated} />
              <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mt: 3 }}>
                <Button onClick={() => setStep(0)}>{t('create.back')}</Button>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  <Button component={LocaleLink} href={gymHref}>
                    {t('create.skip')}
                  </Button>
                  <Button component={LocaleLink} href={gymHref} variant="contained">
                    {t('create.finish')}
                  </Button>
                </Box>
              </Box>
            </>
          )
        )}
      </PageCard>
    </Box>
  );
}
