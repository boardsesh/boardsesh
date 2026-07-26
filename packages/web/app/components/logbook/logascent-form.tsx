'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MuiRating from '@mui/material/Rating';
import Chip from '@mui/material/Chip';
import MuiTooltip from '@mui/material/Tooltip';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import MuiAlert from '@mui/material/Alert';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import { track } from '@/app/lib/analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { Climb, BoardDetails } from '@/app/lib/types';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { useBoardPresenceControls } from '../board-presence/board-presence-context';
import type { TickStatus } from '@boardsesh/board-react';
import { getGradesForBoard, ANGLES } from '@/app/lib/board-data';
import { isBetaVideoUrl, BETA_VIDEO_URL_VALIDATION_MESSAGE } from '@/app/lib/beta-video-url';
import { useEffectiveAngle } from '@/app/hooks/use-effective-angle';
import { useOptionalCurrentClimb } from '../graphql-queue/QueueContext';
import { FormShell, FormSection, FormField, FormRow, FormActions, FormDateTimePicker } from '@/app/components/form';

import dayjs from 'dayjs';

type LogType = 'ascent' | 'attempt';

type LogAscentFormValues = {
  date: dayjs.Dayjs;
  // `null` means "user hasn't picked an angle yet" — distinct from 0°, which
  // is a real selectable angle on vertical-board configs (see `ANGLES` in
  // board-data.ts). Truthy checks on this field would block legitimate 0°
  // logs; always compare against `null`/`undefined` explicitly.
  angle: number | null;
  attempts: number;
  quality: number;
  // `undefined` means "no personal grade override; use the climb's consensus".
  // See docs/ascents-and-attempts.md — never coerce to 0, that's a real grade_id.
  difficulty: number | undefined;
  notes?: string;
  videoUrl?: string;
};

/** Submit-affordance state the form reports up so a drawer header can host the action. */
export type LogAscentSubmitState = {
  submitLabel: string;
  submitting: boolean;
  canSubmit: boolean;
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
  /**
   * When hosted in a drawer, the id wired onto the form so a header-hosted
   * submit button can target it via `form={formId}`.
   */
  formId?: string;
  /**
   * When provided, the form reports its submit affordance here (for a header
   * action bar) instead of rendering inline submit/cancel buttons. Bottom
   * drawers carry actions in the header because the iOS keyboard buries a
   * footer — see docs/mobile-sheets-vs-routes.md.
   *
   * Must be referentially stable (a setState or `useCallback`) — it sits in the
   * report effect's deps, so a per-render identity re-fires the effect every render.
   */
  onSubmitStateChange?: (state: LogAscentSubmitState) => void;
};

export const LogAscentForm: React.FC<LogAscentFormProps> = ({
  currentClimb,
  boardDetails,
  onClose,
  onSwitchClimb,
  formId,
  onSubmitStateChange,
}) => {
  const { t } = useTranslation('climbs');
  const { t: tProfile } = useTranslation('profile');
  const { saveTick, isAuthenticated } = useBoardProvider();
  const { boardId: presenceBoardId } = useBoardPresenceControls();
  const grades = useMemo(() => getGradesForBoard(boardDetails.board_name), [boardDetails.board_name]);
  const angleOptions = ANGLES[boardDetails.board_name];
  // Resolve the wall's current angle (route → party session → climb record).
  // Never `|| 0` here — group-session feedback fix. If nothing resolves the
  // submit action stays disabled until the user picks one in the angle Select.
  const effectiveAngle = useEffectiveAngle(currentClimb);

  const getInitialValues = (): LogAscentFormValues => ({
    date: dayjs(),
    angle: effectiveAngle,
    attempts: 1,
    quality: 0,
    difficulty: grades.find((grade) => grade.difficulty_name === currentClimb?.difficulty)?.difficulty_id,
  });

  const [formValues, setFormValues] = useState<LogAscentFormValues>(getInitialValues);
  const [isMirrored, setIsMirrored] = useState(!!currentClimb?.mirrored);
  const [isSaving, setIsSaving] = useState(false);
  const [logType, setLogType] = useState<LogType>('ascent');
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Surfaced above the fields via FormShell. Covers backend/save failures and
  // the flash/send guard so a failed submit is never silent.
  const [formError, setFormError] = useState<string | null>(null);

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

  // Validation function matching backend rules. Returns a translated,
  // user-facing message (surfaced in the form-level Alert) or null.
  const validateTickInput = (values: LogAscentFormValues): string | null => {
    // Attempts don't need flash/send validation
    if (logType === 'attempt') {
      return null;
    }

    const status = getTickStatus(logType, values.attempts);

    // Flash requires attemptCount === 1
    if (status === 'flash' && values.attempts !== 1) {
      return tProfile('logbook.form.validation.flashOneAttempt');
    }

    // No lower bound on a send's attempt count. `SaveTickInputSchema` floors
    // every status at 1 and constrains only flash: a send is any successful
    // ascent that isn't a flash, so one try is valid (a redpoint logged as a
    // single successful go). Requiring >1 here was the same misreading that
    // silently rewrote mobile tick counts — see #2888 / #3938.

    return null; // Valid
  };

  const handleSubmit = async (values: LogAscentFormValues) => {
    if (!currentClimb?.uuid || !isAuthenticated) {
      return;
    }
    setFormError(null);

    // Guard against a submit slipping past the disabled action — never send
    // `angle: null` (would coerce to 0° on the wire and silently miscredit the
    // climb). The angle FormField already shows an inline error whenever the
    // angle is unset, so returning here surfaces the reason without a toast.
    if (values.angle == null) {
      return;
    }

    // Client-side validation
    const validationError = validateTickInput(values);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setIsSaving(true);

    const status = getTickStatus(logType, values.attempts);

    try {
      const trimmedVideoUrl = values.videoUrl?.trim();
      await saveTick({
        climbUuid: currentClimb.uuid,
        angle: values.angle,
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
        ...(presenceBoardId !== null ? { boardId: presenceBoardId } : {}),
        videoUrl: logType === 'ascent' && trimmedVideoUrl ? trimmedVideoUrl : undefined,
      });

      track(SHARED_EVENTS.TickLogged, {
        climbUuid: currentClimb.uuid,
        boardLayout: boardDetails.layout_name || '',
        status,
        hasDifficulty: logType === 'ascent' && values.difficulty !== undefined,
        difficulty: logType === 'ascent' ? (values.difficulty ?? null) : null,
        platform: 'web',
        surface: 'web_full_form',
      });

      setFormValues(getInitialValues());
      setLogType('ascent');
      onClose();
    } catch (error) {
      // Keep the drawer open and tell the user — a failed save must never be
      // silent (previously this only console.error'd and dropped the tick).
      console.error('Failed to save tick:', error);
      setFormError(tProfile('logbook.form.saveFailed'));
      track('Tick Save Failed', {
        boardLayout: boardDetails.layout_name || '',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const submitDisabled = isSaving || !!videoUrlError || formValues.angle == null;
  const submitLabel =
    formValues.angle != null
      ? tProfile('logbook.form.submitAtAngle', { angle: formValues.angle })
      : tProfile('logbook.form.submit');
  const hostsActionsExternally = onSubmitStateChange != null;

  // Report the submit affordance to a header-hosted action bar. Fires only when
  // the label / saving / enabled state actually changes.
  useEffect(() => {
    if (!onSubmitStateChange) return;
    onSubmitStateChange({ submitLabel, submitting: isSaving, canSubmit: !submitDisabled });
  }, [onSubmitStateChange, submitLabel, isSaving, submitDisabled]);

  return (
    <FormShell
      id={formId}
      error={formError}
      maxWidth={640}
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        void handleSubmit(formValues);
      }}
    >
      {showDriftBanner && wallClimb && (
        // severity="warning" — wall-drift is a decide-what-to-do event,
        // not ambient FYI. The Switch button renders under the body so
        // long climb names (Aurora's "Tortured Soul on Sloping Crystal"
        // shape) don't wrap awkwardly inside MuiAlert's right-aligned
        // action slot on narrow phones (UI review E).
        <MuiAlert severity="warning" onClose={() => setBannerDismissed(true)}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
            <Box component="span">
              {tProfile('logbook.form.wallMoved', {
                wallClimb: wallClimb.name,
                loggingClimb: currentClimb.name,
              })}
            </Box>
            {onSwitchClimb && (
              <Button color="inherit" size="small" variant="outlined" onClick={handleSwitch}>
                {tProfile('logbook.form.switchClimb', { climbName: wallClimb.name })}
              </Button>
            )}
          </Box>
        </MuiAlert>
      )}

      <FormSection title={tProfile('logbook.form.sections.details')}>
        <FormField label={tProfile('logbook.form.logType')}>
          <ToggleButtonGroup
            exclusive
            fullWidth
            value={logType}
            onChange={(_, val) => {
              if (!val) return;
              setLogType(val as LogType);
              // Ascent-only validation errors (the flash/send attempts guard)
              // don't apply across modes — clear the banner so it can't go stale.
              setFormError(null);
            }}
          >
            <ToggleButton value="ascent">{tProfile('logbook.form.ascent')}</ToggleButton>
            <ToggleButton value="attempt">{tProfile('logbook.form.attempt')}</ToggleButton>
          </ToggleButtonGroup>
        </FormField>

        <FormField label={tProfile('logbook.form.boulder')}>
          <Stack direction="row" spacing={1} alignItems="center">
            <strong>{currentClimb?.name || 'N/A'}</strong>
            {showMirrorTag && (
              <Stack direction="row" spacing={0.5} alignItems="center">
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
        </FormField>

        <FormField label={tProfile('logbook.form.dateAndTime')}>
          {(field) => (
            <FormDateTimePicker
              id={field.id}
              describedBy={field.describedBy}
              value={formValues.date}
              onChange={(val) => setFormValues((prev) => ({ ...prev, date: val || dayjs() }))}
              views={['year', 'month', 'day', 'hours', 'minutes']}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
          )}
        </FormField>

        <FormRow>
          <FormField
            label={tProfile('logbook.form.angle')}
            error={formValues.angle == null ? tProfile('logbook.form.pickAngle') : undefined}
          >
            {(field) => (
              <MuiSelect
                labelId={field.labelId}
                id={field.id}
                // `?? ''` not `|| ''` — 0° is a real selectable angle on
                // vertical boards. Truthy fallthrough here would have rendered
                // the "Pick an angle" placeholder over a valid 0° selection.
                value={formValues.angle ?? ''}
                onChange={(event) => setFormValues((prev) => ({ ...prev, angle: Number(event.target.value) }))}
                error={Boolean(field.error)}
                displayEmpty
                size="small"
                fullWidth
              >
                <MenuItem value="" disabled>
                  <em>{tProfile('logbook.form.pickAngle')}</em>
                </MenuItem>
                {angleOptions.map((angleOption) => (
                  <MenuItem key={angleOption} value={angleOption}>
                    {angleOption}°
                  </MenuItem>
                ))}
              </MuiSelect>
            )}
          </FormField>

          <FormField label={tProfile('logbook.form.attempts')}>
            {(field) => (
              <TextField
                id={field.id}
                type="number"
                value={formValues.attempts}
                onChange={(event) => setFormValues((prev) => ({ ...prev, attempts: Number(event.target.value) }))}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { min: 1, max: 999, 'aria-describedby': field.describedBy } }}
              />
            )}
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection title={tProfile('logbook.form.sections.howItFelt')}>
        {logType === 'ascent' && (
          <FormField label={tProfile('logbook.form.quality')}>
            <MuiRating
              value={formValues.quality}
              onChange={(_, val) => setFormValues((prev) => ({ ...prev, quality: val ?? 0 }))}
              max={5}
            />
          </FormField>
        )}

        {logType === 'ascent' && (
          <FormField label={tProfile('logbook.form.difficulty')}>
            {(field) => (
              <MuiSelect<number | ''>
                labelId={field.labelId}
                id={field.id}
                value={formValues.difficulty ?? ''}
                onChange={(event) =>
                  setFormValues((prev) => ({
                    ...prev,
                    difficulty: event.target.value === '' ? undefined : Number(event.target.value),
                  }))
                }
                size="small"
                fullWidth
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
            )}
          </FormField>
        )}

        <FormField label={tProfile('logbook.form.notes')}>
          {(field) => (
            <TextField
              id={field.id}
              multiline
              rows={3}
              variant="outlined"
              size="small"
              fullWidth
              value={formValues.notes || ''}
              onChange={(event) => setFormValues((prev) => ({ ...prev, notes: event.target.value }))}
              slotProps={{ htmlInput: { 'aria-describedby': field.describedBy } }}
            />
          )}
        </FormField>

        {logType === 'ascent' && (
          <FormField
            label={tProfile('logbook.form.video')}
            error={videoUrlError ?? undefined}
            helper={tProfile('logbook.form.videoHelper')}
          >
            {(field) => (
              <TextField
                id={field.id}
                placeholder={tProfile('logbook.form.videoPlaceholder')}
                variant="outlined"
                size="small"
                fullWidth
                value={formValues.videoUrl || ''}
                onChange={(event) => setFormValues((prev) => ({ ...prev, videoUrl: event.target.value }))}
                error={Boolean(field.error)}
                slotProps={{ htmlInput: { 'aria-describedby': field.describedBy } }}
              />
            )}
          </FormField>
        )}
      </FormSection>

      {!hostsActionsExternally && (
        <FormActions
          submitLabel={submitLabel}
          submitting={isSaving}
          disabled={submitDisabled}
          onCancel={onClose}
          cancelLabel={tProfile('logbook.form.cancel')}
          layout="stacked"
        />
      )}
    </FormShell>
  );
};
