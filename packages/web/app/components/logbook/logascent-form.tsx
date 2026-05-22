'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MuiRating from '@mui/material/Rating';
import Chip from '@mui/material/Chip';
import MuiTooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import MuiAlert from '@mui/material/Alert';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import { track } from '@/app/lib/analytics';
import type { Climb, BoardDetails } from '@/app/lib/types';
import { type TickStatus, useBoardProvider } from '../board-provider/board-provider-context';
import { getGradesForBoard, ANGLES } from '@/app/lib/board-data';
import { isBetaVideoUrl, BETA_VIDEO_URL_VALIDATION_MESSAGE } from '@/app/lib/beta-video-url';
import { useEffectiveAngle } from '@/app/lib/hooks/use-effective-angle';
import { useOptionalCurrentClimb } from '../graphql-queue/QueueContext';

import dayjs from 'dayjs';

type LogType = 'ascent' | 'attempt';

type LogAscentFormValues = {
  date: dayjs.Dayjs;
  angle: number;
  attempts: number;
  quality: number;
  // `undefined` means "no personal grade override; use the climb's consensus".
  // See docs/ascents-and-attempts.md — never coerce to 0, that's a real grade_id.
  difficulty: number | undefined;
  notes?: string;
  videoUrl?: string;
};

// Helper to determine tick status from attempt count (for ascents)
const getAscentStatus = (attempts: number): TickStatus => {
  return attempts === 1 ? 'flash' : 'send';
};

// Helper to determine tick status based on log type
const getTickStatus = (logType: LogType, attempts: number): TickStatus => {
  if (logType === 'attempt') {
    return 'attempt';
  }
  return getAscentStatus(attempts);
};

type LogAscentFormProps = {
  currentClimb: Climb;
  boardDetails: BoardDetails;
  onClose: () => void;
  /**
   * Called when the user accepts the "wall moved" banner's offer to switch
   * to logging the new wall climb. The drawer re-snapshots and re-keys this
   * form, which remounts with the new climb's initial values.
   */
  onSwitchClimb?: (climb: Climb) => void;
};

export const LogAscentForm: React.FC<LogAscentFormProps> = ({ currentClimb, boardDetails, onClose, onSwitchClimb }) => {
  const { t } = useTranslation('climbs');
  const { t: tProfile } = useTranslation('profile');
  const { saveTick, isAuthenticated } = useBoardProvider();
  const grades = useMemo(() => getGradesForBoard(boardDetails.board_name), [boardDetails.board_name]);
  const angleOptions = ANGLES[boardDetails.board_name];
  // Resolve the wall's current angle (route → party session → climb record).
  // Never `|| 0` here — group-session feedback fix. If nothing resolves the
  // submit button is disabled until the user picks one in the angle Select.
  const effectiveAngle = useEffectiveAngle(currentClimb);

  const getInitialValues = (): LogAscentFormValues => ({
    date: dayjs(),
    angle: effectiveAngle ?? 0,
    attempts: 1,
    quality: 0,
    difficulty: grades.find((grade) => grade.difficulty_name === currentClimb?.difficulty)?.difficulty_id,
  });

  const [formValues, setFormValues] = useState<LogAscentFormValues>(getInitialValues);
  const [isMirrored, setIsMirrored] = useState(!!currentClimb?.mirrored);
  const [isSaving, setIsSaving] = useState(false);
  const [logType, setLogType] = useState<LogType>('ascent');
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // TODO: Tension spray doesnt support mirroring
  const showMirrorTag = boardDetails.supportsMirroring;

  // Detect wall drift — the form is locked to the climb the user opened it
  // on (see LogAscentDrawer), but the party's wall may have moved on while
  // they typed. Read the live wall climb from the queue context and show a
  // banner offering to switch when it diverges. Optional context so the form
  // still renders fine outside of a queue provider.
  const liveCurrentClimb = useOptionalCurrentClimb();
  const wallClimb = liveCurrentClimb?.currentClimbQueueItem?.climb ?? null;
  const wallHasMoved = !!wallClimb && wallClimb.uuid !== currentClimb.uuid;
  const showDriftBanner = wallHasMoved && !bannerDismissed;

  const isFormDirty = formValues.notes != null && formValues.notes.length > 0;

  const handleSwitch = () => {
    if (!wallClimb || !onSwitchClimb) return;
    if (isFormDirty) {
      // We intentionally use window.confirm here — the form is inside a
      // SwipeableDrawer and MUI Dialog stacks awkwardly above it; a native
      // confirm gives the user the same "are you sure?" beat without that
      // visual jank. If we add a custom modal stack later this can graduate.
      if (typeof window !== 'undefined' && !window.confirm(tProfile('logbook.form.switchDirtyConfirm'))) {
        return;
      }
    }
    onSwitchClimb(wallClimb);
  };

  const handleMirrorToggle = () => {
    setIsMirrored((prev) => !prev);
  };

  const videoUrlError =
    logType === 'ascent' && formValues.videoUrl && !isBetaVideoUrl(formValues.videoUrl)
      ? BETA_VIDEO_URL_VALIDATION_MESSAGE
      : null;

  // Validation function matching backend rules
  const validateTickInput = (values: LogAscentFormValues): string | null => {
    // Attempts don't need flash/send validation
    if (logType === 'attempt') {
      return null;
    }

    const status = getTickStatus(logType, values.attempts);

    // Flash requires attemptCount === 1
    if (status === 'flash' && values.attempts !== 1) {
      return 'Flash requires exactly 1 attempt';
    }

    // Send requires attemptCount > 1
    if (status === 'send' && values.attempts <= 1) {
      return 'Send requires more than 1 attempt';
    }

    if (values.videoUrl && !isBetaVideoUrl(values.videoUrl)) {
      return BETA_VIDEO_URL_VALIDATION_MESSAGE;
    }

    return null; // Valid
  };

  const handleSubmit = async (values: LogAscentFormValues) => {
    if (!currentClimb?.uuid || !isAuthenticated) {
      return;
    }

    // Client-side validation
    const validationError = validateTickInput(values);
    if (validationError) {
      console.error('Validation error:', validationError);
      return;
    }

    setIsSaving(true);

    const status = getTickStatus(logType, values.attempts);

    try {
      const trimmedVideoUrl = values.videoUrl?.trim();
      await saveTick({
        climbUuid: currentClimb.uuid,
        angle: Number(values.angle),
        isMirror: isMirrored,
        status,
        attemptCount: values.attempts,
        quality: logType === 'ascent' && values.quality ? values.quality : undefined,
        difficulty: logType === 'ascent' ? values.difficulty : undefined,
        isBenchmark: false,
        comment: values.notes || '',
        climbedAt: values.date.toISOString(),
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        setIds: Array.isArray(boardDetails.set_ids) ? boardDetails.set_ids.join(',') : String(boardDetails.set_ids),
        videoUrl: logType === 'ascent' && trimmedVideoUrl ? trimmedVideoUrl : undefined,
      });

      track('Tick Logged', {
        boardLayout: boardDetails.layout_name || '',
        status,
      });

      setFormValues(getInitialValues());
      setLogType('ascent');
      onClose();
    } catch (error) {
      console.error('Failed to save tick:', error);
      track('Tick Save Failed', {
        boardLayout: boardDetails.layout_name || '',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box
      component="form"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        void handleSubmit(formValues);
      }}
    >
      {showDriftBanner && wallClimb && (
        <MuiAlert
          severity="info"
          sx={{ mb: 2 }}
          onClose={() => setBannerDismissed(true)}
          action={
            onSwitchClimb && (
              <Button color="inherit" size="small" onClick={handleSwitch}>
                {tProfile('logbook.form.switchClimb', { climbName: wallClimb.name })}
              </Button>
            )
          }
        >
          {tProfile('logbook.form.wallMoved', {
            wallClimb: wallClimb.name,
            loggingClimb: currentClimb.name,
          })}
        </MuiAlert>
      )}

      <Box sx={{ mb: 2 }}>
        <ToggleButtonGroup exclusive fullWidth value={logType} onChange={(_, val) => val && setLogType(val as LogType)}>
          <ToggleButton value="ascent">{tProfile('logbook.form.ascent')}</ToggleButton>
          <ToggleButton value="attempt">{tProfile('logbook.form.attempt')}</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.boulder')}</Typography>
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1}>
            <strong>{currentClimb?.name || 'N/A'}</strong>
            {showMirrorTag && (
              <Stack direction="row" spacing={0.5}>
                <Chip
                  label={tProfile('logbook.form.mirrored')}
                  size="small"
                  color={isMirrored ? 'secondary' : undefined}
                  sx={{ cursor: 'pointer', margin: 0 }}
                  onClick={handleMirrorToggle}
                />
                <MuiTooltip title={t('actions.tick.drawer.mirroredTooltip')}>
                  <InfoOutlined sx={{ color: 'var(--neutral-400)', cursor: 'pointer' }} />
                </MuiTooltip>
              </Stack>
            )}
          </Stack>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.dateAndTime')}</Typography>
        <Box sx={{ flex: 1 }}>
          <DateTimePicker
            value={formValues.date}
            onChange={(val) => setFormValues((prev) => ({ ...prev, date: val || dayjs() }))}
            views={['year', 'month', 'day', 'hours', 'minutes']}
            slotProps={{ textField: { size: 'small' } }}
          />
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.angle')}</Typography>
        <Box sx={{ flex: 1 }}>
          <MuiSelect
            value={formValues.angle || ''}
            onChange={(e) => setFormValues((prev) => ({ ...prev, angle: Number(e.target.value) }))}
            size="small"
            sx={{ width: 100 }}
            displayEmpty
            error={!formValues.angle}
          >
            <MenuItem value="" disabled>
              <em>{tProfile('logbook.form.pickAngle')}</em>
            </MenuItem>
            {angleOptions.map((angle) => (
              <MenuItem key={angle} value={angle}>
                {angle}°
              </MenuItem>
            ))}
          </MuiSelect>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.attempts')}</Typography>
        <Box sx={{ flex: 1 }}>
          <TextField
            type="number"
            value={formValues.attempts}
            onChange={(e) => setFormValues((prev) => ({ ...prev, attempts: Number(e.target.value) }))}
            slotProps={{ htmlInput: { min: 1, max: 999 } }}
            size="small"
            sx={{ width: 80 }}
          />
        </Box>
      </Box>

      {logType === 'ascent' && (
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
          <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.quality')}</Typography>
          <Box sx={{ flex: 1 }}>
            <MuiRating
              value={formValues.quality}
              onChange={(_, val) => setFormValues((prev) => ({ ...prev, quality: val ?? 0 }))}
              max={5}
            />
          </Box>
        </Box>
      )}

      {logType === 'ascent' && (
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
          <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.difficulty')}</Typography>
          <Box sx={{ flex: 1 }}>
            <MuiSelect<number | ''>
              value={formValues.difficulty ?? ''}
              onChange={(e) =>
                setFormValues((prev) => ({
                  ...prev,
                  difficulty: e.target.value === '' ? undefined : Number(e.target.value),
                }))
              }
              size="small"
              sx={{ width: 120 }}
              displayEmpty
            >
              <MenuItem value="">
                <em>{tProfile('logbook.form.difficultyNoOverride')}</em>
              </MenuItem>
              {grades.map((grade) => (
                <MenuItem key={grade.difficulty_id} value={grade.difficulty_id}>
                  {grade.difficulty_name}
                </MenuItem>
              ))}
            </MuiSelect>
          </Box>
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>{tProfile('logbook.form.notes')}</Typography>
        <Box sx={{ flex: 1 }}>
          <TextField
            multiline
            rows={3}
            variant="outlined"
            size="small"
            fullWidth
            value={formValues.notes || ''}
            onChange={(e) => setFormValues((prev) => ({ ...prev, notes: e.target.value }))}
          />
        </Box>
      </Box>

      {logType === 'ascent' && (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', mb: 1.5 }}>
          <Typography sx={{ width: 120, flexShrink: 0, pt: 1 }}>{tProfile('logbook.form.video')}</Typography>
          <Box sx={{ flex: 1 }}>
            <TextField
              placeholder={tProfile('logbook.form.videoPlaceholder')}
              variant="outlined"
              size="small"
              fullWidth
              value={formValues.videoUrl || ''}
              onChange={(e) => setFormValues((prev) => ({ ...prev, videoUrl: e.target.value }))}
              error={!!videoUrlError}
              helperText={videoUrlError ?? tProfile('logbook.form.videoHelper')}
            />
          </Box>
        </Box>
      )}

      <Box sx={{ mb: 1 }}>
        <Button
          variant="contained"
          type="submit"
          disabled={isSaving || !!videoUrlError || !formValues.angle}
          startIcon={isSaving ? <CircularProgress size={16} /> : undefined}
          fullWidth
          size="large"
        >
          {formValues.angle
            ? tProfile('logbook.form.submitAtAngle', { angle: formValues.angle })
            : tProfile('logbook.form.submit')}
        </Button>
      </Box>

      <Box>
        <Button variant="outlined" fullWidth size="large" onClick={onClose} disabled={isSaving}>
          {tProfile('logbook.form.cancel')}
        </Button>
      </Box>
    </Box>
  );
};
