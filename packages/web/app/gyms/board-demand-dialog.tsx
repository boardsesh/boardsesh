'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import { boardDemandReported, needsBoardDemandFollowUp, type BoardDemandReason } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';

/**
 * "Can't find your board?" — the unmet-demand form for the gym directory
 * (issue #6062). Sits in the no-results empty state: the visitor searched for
 * a board at a place and we had nothing for them, which is the demand the
 * spray-wall rollout and the next board-support decisions are made of.
 *
 * Same contract as the mobile sheet: one `Board Demand Reported` event per
 * submitted form, two closed-set fields, and no free text — the climber's
 * words belong to the support page, which this dialog links to for the three
 * reasons that imply a nameable board.
 */
export default function BoardDemandDialog() {
  const { t } = useTranslation('gyms');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<BoardDemandReason | null>(null);
  const [sent, setSent] = useState(false);

  const close = () => {
    setOpen(false);
    setReason(null);
    setSent(false);
  };

  const submit = () => {
    if (!reason) return;
    const payload = boardDemandReported(reason, 'gym_directory');
    track(payload.name, payload.properties);
    setSent(true);
  };

  // Written out, not mapped from the enum: `check:i18n` wants literal keys,
  // and the order is the same as the mobile sheet so the two surfaces read
  // as one product decision.
  const options: { id: BoardDemandReason; label: string }[] = [
    { id: 'gym_board_not_listed', label: t('results.demandGymBoard') },
    { id: 'unsupported_brand', label: t('results.demandBrand') },
    { id: 'spray_wall', label: t('results.demandSpray') },
    { id: 'no_board_yet', label: t('results.demandNoBoard') },
    { id: 'other', label: t('results.demandOther') },
  ];

  return (
    <>
      <Button variant="text" onClick={() => setOpen(true)}>
        {t('results.cantFindBoard')}
      </Button>
      <Dialog open={open} onClose={close}>
        <DialogTitle>{sent ? t('results.demandThanksTitle') : t('results.demandTitle')}</DialogTitle>
        <DialogContent>
          {sent ? (
            <Box sx={{ display: 'grid', gap: 2, pt: 1 }}>
              <DialogContentText>{t('results.demandThanksBody')}</DialogContentText>
              {reason !== null &&
                needsBoardDemandFollowUp(reason) && (
                  // The three nameable-board asks get a door, not a dead end:
                  // the support page is where which-gym/which-brand can be said.
                  <Button variant="outlined" component={LocaleLink} href="/support" sx={{ justifySelf: 'start' }}>
                    {t('results.demandTellMore')}
                  </Button>
                )}
            </Box>
          ) : (
            <>
              <DialogContentText sx={{ mb: 2 }}>{t('results.demandBody')}</DialogContentText>
              <RadioGroup
                value={reason ?? ''}
                onChange={(_event, value) => setReason(value === '' ? null : (value as BoardDemandReason))}
              >
                {options.map((option) => (
                  <FormControlLabel key={option.id} value={option.id} control={<Radio />} label={option.label} />
                ))}
              </RadioGroup>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>{t('results.demandClose')}</Button>
          {!sent && (
            <Button variant="contained" color="primaryFill" disabled={reason === null} onClick={submit}>
              {t('results.demandSend')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
