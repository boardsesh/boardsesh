'use client';

import React, { useEffect, useState } from 'react';
import MuiRating from '@mui/material/Rating';
import Chip from '@mui/material/Chip';
import MuiTooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import { track } from '@/app/lib/analytics';
import type { Climb, BoardDetails } from '@/app/lib/types';
import { type TickStatus, useBoardProvider } from '../board-provider/board-provider-context';
import { TENSION_KILTER_GRADES, ANGLES } from '@/app/lib/board-data';
import { isBetaVideoUrl, BETA_VIDEO_URL_VALIDATION_MESSAGE } from '@/app/lib/beta-video-url';

import dayjs from 'dayjs';

type LogType = 'ascent' | 'attempt';

type LogAscentFormValues = {
  date: dayjs.Dayjs;
  angle: number;
  attempts: number;
  quality: number;
  difficulty: number;
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
};

export const LogAscentForm: React.FC<LogAscentFormProps> = ({ currentClimb, boardDetails, onClose }) => {
  const { saveTick, isAuthenticated } = useBoardProvider();
  const grades = TENSION_KILTER_GRADES;
  const angleOptions = ANGLES[boardDetails.board_name];

  const getInitialValues = (): LogAscentFormValues => ({
    date: dayjs(),
    angle: currentClimb?.angle || 0,
    attempts: 1,
    quality: 0,
    difficulty: grades.find((grade) => grade.difficulty_name === currentClimb?.difficulty)?.difficulty_id || 0,
  });

  const [formValues, setFormValues] = useState<LogAscentFormValues>(getInitialValues);
  const [isMirrored, setIsMirrored] = useState(!!currentClimb?.mirrored);
  const [isSaving, setIsSaving] = useState(false);
  const [logType, setLogType] = useState<LogType>('ascent');

  // TODO: Tension spray doesnt support mirroring
  const showMirrorTag = boardDetails.supportsMirroring;

  useEffect(() => {
    setFormValues((prev) => ({
      ...prev,
      date: dayjs(),
      angle: currentClimb?.angle || prev.angle,
      difficulty:
        grades.find((grade) => grade.difficulty_name === currentClimb?.difficulty)?.difficulty_id || prev.difficulty,
      attempts: 1,
    }));
    setIsMirrored(!!currentClimb?.mirrored);
  }, [currentClimb, grades]);

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
      <Box sx={{ mb: 2 }}>
        <ToggleButtonGroup exclusive fullWidth value={logType} onChange={(_, val) => val && setLogType(val as LogType)}>
          <ToggleButton value="ascent">Ascent</ToggleButton>
          <ToggleButton value="attempt">Attempt</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>Boulder</Typography>
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" spacing={1}>
            <strong>{currentClimb?.name || 'N/A'}</strong>
            {showMirrorTag && (
              <Stack direction="row" spacing={0.5}>
                <Chip
                  label="Mirrored"
                  size="small"
                  color={isMirrored ? 'secondary' : undefined}
                  sx={{ cursor: 'pointer', margin: 0 }}
                  onClick={handleMirrorToggle}
                />
                <MuiTooltip title="Click the tag to toggle whether you completed this climb on the mirrored side">
                  <InfoOutlined sx={{ color: 'var(--neutral-400)', cursor: 'pointer' }} />
                </MuiTooltip>
              </Stack>
            )}
          </Stack>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>Date and Time</Typography>
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
        <Typography sx={{ width: 120, flexShrink: 0 }}>Angle</Typography>
        <Box sx={{ flex: 1 }}>
          <MuiSelect
            value={formValues.angle}
            onChange={(e) => setFormValues((prev) => ({ ...prev, angle: Number(e.target.value) }))}
            size="small"
            sx={{ width: 80 }}
          >
            {angleOptions.map((angle) => (
              <MenuItem key={angle} value={angle}>
                {angle}
              </MenuItem>
            ))}
          </MuiSelect>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography sx={{ width: 120, flexShrink: 0 }}>Attempts</Typography>
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
          <Typography sx={{ width: 120, flexShrink: 0 }}>Quality</Typography>
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
          <Typography sx={{ width: 120, flexShrink: 0 }}>Difficulty</Typography>
          <Box sx={{ flex: 1 }}>
            <MuiSelect
              value={formValues.difficulty}
              onChange={(e) => setFormValues((prev) => ({ ...prev, difficulty: Number(e.target.value) }))}
              size="small"
              sx={{ width: 120 }}
            >
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
        <Typography sx={{ width: 120, flexShrink: 0 }}>Notes</Typography>
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
          <Typography sx={{ width: 120, flexShrink: 0, pt: 1 }}>Video</Typography>
          <Box sx={{ flex: 1 }}>
            <TextField
              placeholder="Instagram or TikTok URL"
              variant="outlined"
              size="small"
              fullWidth
              value={formValues.videoUrl || ''}
              onChange={(e) => setFormValues((prev) => ({ ...prev, videoUrl: e.target.value }))}
              error={!!videoUrlError}
              helperText={videoUrlError ?? 'Paste an Instagram or TikTok link so others can see your beta. (Optional)'}
            />
          </Box>
        </Box>
      )}

      <Box sx={{ mb: 1 }}>
        <Button
          variant="contained"
          type="submit"
          disabled={isSaving || !!videoUrlError}
          startIcon={isSaving ? <CircularProgress size={16} /> : undefined}
          fullWidth
          size="large"
        >
          Submit
        </Button>
      </Box>

      <Box>
        <Button variant="outlined" fullWidth size="large" onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
      </Box>
    </Box>
  );
};
