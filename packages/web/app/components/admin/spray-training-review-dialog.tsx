'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type {
  SprayTrainingQueueItemData,
  SprayTrainingRejectReason,
  SprayTrainingReviewStatus,
  SprayTrainingWallVisibility,
} from '@boardsesh/graphql/operations';
import { themeTokens } from '@/app/theme/theme-config';
import { buildOverlayMarks, summariseStats, type SprayOverlayKind } from '@/app/lib/admin/spray-training-overlay';
import SprayHoldOverlay, { SPRAY_OVERLAY_STYLES } from './spray-hold-overlay';

const SPRAY_REJECT_REASONS: readonly SprayTrainingRejectReason[] = [
  'BAD_HOLDS',
  'MISSING_HOLDS',
  'PHOTO_QUALITY',
  'NOT_A_WALL',
  'PEOPLE_OR_PERSONAL_INFO',
  'DUPLICATE',
  'OTHER',
];

const SPRAY_REVIEW_NOTES_MAX = 500;

/**
 * Viewport height the photo cannot use: the header bar plus the photo pane's
 * own padding. A layout measure, well past the end of the spacing scale (64).
 */
const PHOTO_VERTICAL_CHROME_PX = 140;
/** Width of the verdict column from `md` up. Also past the spacing scale. */
const VERDICT_COLUMN_WIDTH_PX = 360;

const LEGEND_KINDS: readonly SprayOverlayKind[] = [
  'manual',
  'auto',
  'accepted',
  'confirmed',
  'edited',
  'deleted',
  'notShown',
];

/** Suggestions the climber never saw stay off until the reviewer asks. */
const DEFAULT_HIDDEN_KINDS: readonly SprayOverlayKind[] = ['notShown'];

export type SprayTrainingDecision = {
  status: SprayTrainingReviewStatus;
  reason?: SprayTrainingRejectReason;
  notes?: string;
};

type SprayTrainingReviewDialogProps = {
  item: SprayTrainingQueueItemData | null;
  /** 1-based position in the loaded list, for "3 of 24". */
  position: number;
  total: number;
  busy: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onDecide: (item: SprayTrainingQueueItemData, decision: SprayTrainingDecision) => void;
};

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password']);

/**
 * Keys typed into a text field, or inside an open picker, are not shortcuts.
 * A checkbox (the MUI Switch input) is not text, so shortcuts keep working
 * after the reviewer toggles a legend row. The closed reason picker is not
 * blocked either: MUI hands focus back to its `role=combobox` trigger when the
 * menu shuts, so blocking it left every shortcut dead after a mouse pick.
 */
export function isShortcutBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return true;
  return target.closest('[role=listbox],[role=option]') !== null;
}

export default function SprayTrainingReviewDialog({
  item,
  position,
  total,
  busy,
  onClose,
  onPrevious,
  onNext,
  onDecide,
}: SprayTrainingReviewDialogProps) {
  const { t } = useTranslation('admin');
  const versionId = item?.versionId ?? null;
  const [marksVisible, setMarksVisible] = useState(true);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<SprayOverlayKind>>(() => new Set(DEFAULT_HIDDEN_KINDS));
  const [reason, setReason] = useState<SprayTrainingRejectReason | ''>('');
  const [notes, setNotes] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [photoOnScreen, setPhotoOnScreen] = useState(false);
  const [photoOnScreenFor, setPhotoOnScreenFor] = useState(versionId);
  const [failedPhotoUrl, setFailedPhotoUrl] = useState<string | null>(null);

  // Reset while rendering, not in an effect: a wall starts unloaded before its
  // own <img> exists, so that image's load event can only come afterwards. A
  // re-signed link for the same wall keeps the element and stays loaded. Coming
  // back to a wall also gives a failed download another try.
  if (photoOnScreenFor !== versionId) {
    setPhotoOnScreenFor(versionId);
    setPhotoOnScreen(false);
    setFailedPhotoUrl(null);
  }

  // A new wall starts from its saved verdict, not the last one typed.
  useEffect(() => {
    setReason(item?.review.reason ?? '');
    setNotes(item?.review.notes ?? '');
    setReasonOpen(false);
    // Keyed on the version, not the item: a background refetch hands back a new object.
  }, [versionId]);

  const marks = useMemo(
    () => (item ? buildOverlayMarks({ holds: item.holds, candidates: item.candidates }) : []),
    [item],
  );
  const kindCounts = useMemo(() => {
    const counts = new Map<SprayOverlayKind, number>();
    for (const mark of marks) counts.set(mark.kind, (counts.get(mark.kind) ?? 0) + 1);
    return counts;
  }, [marks]);
  const effectiveHidden = useMemo<ReadonlySet<SprayOverlayKind>>(
    () => (marksVisible ? hiddenKinds : new Set(LEGEND_KINDS)),
    [marksVisible, hiddenKinds],
  );

  const toggleKind = useCallback((kind: SprayOverlayKind) => {
    setHiddenKinds((previous) => {
      const next = new Set(previous);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const photoWidth = item?.photoWidth ?? null;
  const photoHeight = item?.photoHeight ?? null;
  const photoUrl = item?.photo?.url ?? null;
  const hasGeometry = photoWidth !== null && photoHeight !== null && photoWidth > 0 && photoHeight > 0;
  // A photo the browser could not fetch is as unavailable as one the backend could not sign.
  const photoAvailable = photoUrl !== null && hasGeometry && failedPhotoUrl !== photoUrl;
  const photoLoaded = photoAvailable && photoOnScreen;
  const photoLoading = photoAvailable && !photoLoaded;
  const trimmedNotes = notes.trim();
  const decisionNotes = trimmedNotes === '' ? undefined : trimmedNotes;

  const approve = useCallback(() => {
    // Approving means the reviewer saw the photo, so it has to be on screen.
    if (!item || busy || !photoLoaded || item.review.status === 'APPROVED') return;
    onDecide(item, { status: 'APPROVED', notes: decisionNotes });
  }, [item, busy, photoLoaded, decisionNotes, onDecide]);

  const reject = useCallback(() => {
    // A photo that is gone is a reason to reject; one still loading is not ready for a verdict.
    if (!item || busy || photoLoading) return;
    if (reason === '') {
      // R with no reason yet opens the picker instead of failing silently.
      setReasonOpen(true);
      return;
    }
    onDecide(item, { status: 'REJECTED', reason, notes: decisionNotes });
  }, [item, busy, photoLoading, reason, decisionNotes, onDecide]);

  const backToUnreviewed = useCallback(() => {
    if (!item || busy || item.review.status === 'UNREVIEWED') return;
    onDecide(item, { status: 'UNREVIEWED' });
  }, [item, busy, onDecide]);

  useEffect(() => {
    if (!item) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (reasonOpen || event.metaKey || event.ctrlKey || event.altKey || isShortcutBlockedTarget(event.target)) return;
      switch (event.key) {
        // A verdict is one deliberate press. A held key auto-repeats, and the
        // repeat would decide the wall that slides in once the first one saves.
        case 'a':
        case 'A':
          if (event.repeat) return;
          approve();
          break;
        case 'r':
        case 'R':
          if (event.repeat) return;
          reject();
          break;
        case 'h':
        case 'H':
          setMarksVisible((visible) => !visible);
          break;
        case 'ArrowLeft':
          onPrevious();
          break;
        case 'ArrowRight':
          onNext();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [item, reasonOpen, approve, reject, onPrevious, onNext]);

  const kindLabel = (kind: SprayOverlayKind): string => {
    switch (kind) {
      case 'manual':
        return t('sprayTraining.kind.manual');
      case 'auto':
        return t('sprayTraining.kind.auto');
      case 'accepted':
        return t('sprayTraining.kind.accepted');
      case 'confirmed':
        return t('sprayTraining.kind.confirmed');
      case 'edited':
        return t('sprayTraining.kind.edited');
      case 'deleted':
        return t('sprayTraining.kind.deleted');
      case 'notShown':
        return t('sprayTraining.kind.notShown');
    }
  };

  const reasonLabel = (rejectReason: SprayTrainingRejectReason): string => {
    switch (rejectReason) {
      case 'BAD_HOLDS':
        return t('sprayTraining.reason.BAD_HOLDS');
      case 'MISSING_HOLDS':
        return t('sprayTraining.reason.MISSING_HOLDS');
      case 'PHOTO_QUALITY':
        return t('sprayTraining.reason.PHOTO_QUALITY');
      case 'NOT_A_WALL':
        return t('sprayTraining.reason.NOT_A_WALL');
      case 'PEOPLE_OR_PERSONAL_INFO':
        return t('sprayTraining.reason.PEOPLE_OR_PERSONAL_INFO');
      case 'DUPLICATE':
        return t('sprayTraining.reason.DUPLICATE');
      case 'OTHER':
        return t('sprayTraining.reason.OTHER');
    }
  };

  const visibilityLabel = (visibility: SprayTrainingWallVisibility): string => {
    switch (visibility) {
      case 'PRIVATE':
        return t('sprayTraining.visibility.PRIVATE');
      case 'UNLISTED':
        return t('sprayTraining.visibility.UNLISTED');
      case 'PUBLIC':
        return t('sprayTraining.visibility.PUBLIC');
    }
  };

  const stats = item ? summariseStats(item.stats) : null;

  return (
    <Dialog fullScreen open={item !== null} onClose={onClose} aria-labelledby="spray-training-review-title">
      {item && stats && (
        <Box
          sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: themeTokens.semantic.background }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 2,
              py: 1,
              borderBottom: 1,
              borderColor: themeTokens.semantic.separator,
            }}
          >
            <IconButton onClick={onClose} aria-label={t('sprayTraining.review.close')}>
              <CloseIcon />
            </IconButton>
            <Typography id="spray-training-review-title" variant="h6" sx={{ flex: 1, fontWeight: 600 }}>
              {t('sprayTraining.review.title', { version: item.versionNumber })}
            </Typography>
            <IconButton onClick={onPrevious} aria-label={t('sprayTraining.review.previous')} disabled={position <= 1}>
              <ChevronLeftIcon />
            </IconButton>
            <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
              {t('sprayTraining.review.position', { current: position, total })}
            </Typography>
            <IconButton onClick={onNext} aria-label={t('sprayTraining.review.next')} disabled={position >= total}>
              <ChevronRightIcon />
            </IconButton>
          </Box>

          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: { xs: 'column', md: 'row' },
              overflow: 'auto',
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', p: 2 }}>
              {photoAvailable ? (
                <Box
                  sx={{
                    position: 'relative',
                    width: `min(100%, calc((100vh - ${PHOTO_VERTICAL_CHROME_PX}px) * ${photoWidth / photoHeight}))`,
                    aspectRatio: `${photoWidth} / ${photoHeight}`,
                  }}
                >
                  <Box
                    // One element per wall: the last wall's photo cannot stay painted under this one's marks.
                    key={item.versionId}
                    component="img"
                    src={photoUrl}
                    alt={t('sprayTraining.review.photoAlt')}
                    onLoad={() => setPhotoOnScreen(true)}
                    onError={() => {
                      setFailedPhotoUrl(photoUrl);
                      setPhotoOnScreen(false);
                    }}
                    sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                  />
                  {photoLoaded ? (
                    <SprayHoldOverlay
                      marks={marks}
                      photoWidth={photoWidth}
                      photoHeight={photoHeight}
                      hiddenKinds={effectiveHidden}
                    />
                  ) : (
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <CircularProgress size={20} aria-label={t('sprayTraining.review.photoLoading')} />
                    </Box>
                  )}
                </Box>
              ) : (
                <Typography sx={{ color: themeTokens.neutral[500] }}>{t('sprayTraining.review.noPhoto')}</Typography>
              )}
            </Box>

            <Box
              sx={{
                width: { xs: '100%', md: VERDICT_COLUMN_WIDTH_PX },
                flexShrink: 0,
                p: 2,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                borderLeft: { md: 1 },
                borderColor: themeTokens.semantic.separator,
              }}
            >
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                <Chip
                  size="small"
                  variant="outlined"
                  // Nobody but its owner was meant to see a private wall, so it stands out.
                  color={item.visibility === 'PRIVATE' ? 'warning' : 'default'}
                  label={visibilityLabel(item.visibility)}
                />
                <Chip size="small" label={t('sprayTraining.card.holds', { total: stats.holdCount })} />
                <Chip size="small" label={t('sprayTraining.card.edited', { percent: stats.editedPercent })} />
                <Chip size="small" label={t('sprayTraining.card.accepted', { percent: stats.acceptedPercent })} />
                <Chip size="small" label={t('sprayTraining.card.deleted', { total: stats.deletedSuggestions })} />
              </Box>
              {item.unmappableHoldCount > 0 && (
                <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
                  {t('sprayTraining.review.unmappable', { total: item.unmappableHoldCount })}
                </Typography>
              )}
              {item.detectionModelVersion && (
                <Typography variant="body2" sx={{ color: themeTokens.neutral[500] }}>
                  {t('sprayTraining.review.model', { version: item.detectionModelVersion })}
                </Typography>
              )}

              <Box>
                <FormControlLabel
                  control={<Switch checked={marksVisible} onChange={() => setMarksVisible((visible) => !visible)} />}
                  label={t('sprayTraining.review.showMarks')}
                />
                <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5 }}>
                  {t('sprayTraining.review.legend')}
                </Typography>
                {LEGEND_KINDS.filter((kind) => (kindCounts.get(kind) ?? 0) > 0).map((kind) => {
                  const look = SPRAY_OVERLAY_STYLES[kind];
                  return (
                    <Box key={kind} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box
                        aria-hidden="true"
                        sx={{
                          width: themeTokens.spacing[5],
                          height: themeTokens.spacing[5],
                          borderRadius: '50%',
                          border: `${Math.max(2, look.strokeWidth)}px ${look.dashed ? 'dashed' : 'solid'} ${look.stroke}`,
                        }}
                      />
                      <FormControlLabel
                        sx={{ flex: 1, m: 0 }}
                        control={
                          <Switch size="small" checked={!hiddenKinds.has(kind)} onChange={() => toggleKind(kind)} />
                        }
                        label={`${kindLabel(kind)} (${kindCounts.get(kind)})`}
                      />
                    </Box>
                  );
                })}
              </Box>

              <FormControl size="small" fullWidth>
                <InputLabel id="spray-training-reason-label">{t('sprayTraining.review.reason')}</InputLabel>
                <Select
                  labelId="spray-training-reason-label"
                  label={t('sprayTraining.review.reason')}
                  value={reason}
                  open={reasonOpen}
                  onOpen={() => setReasonOpen(true)}
                  onClose={() => setReasonOpen(false)}
                  onChange={(event) => setReason(event.target.value as SprayTrainingRejectReason | '')}
                >
                  {SPRAY_REJECT_REASONS.map((rejectReason) => (
                    <MenuItem key={rejectReason} value={rejectReason}>
                      {reasonLabel(rejectReason)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                size="small"
                multiline
                minRows={2}
                label={t('sprayTraining.review.notes')}
                value={notes}
                onChange={(event) => setNotes(event.target.value.slice(0, SPRAY_REVIEW_NOTES_MAX))}
                helperText={`${notes.length}/${SPRAY_REVIEW_NOTES_MAX}`}
              />

              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                <Button
                  variant="contained"
                  onClick={approve}
                  disabled={busy || !photoLoaded || item.review.status === 'APPROVED'}
                  sx={{ textTransform: 'none' }}
                >
                  {t('sprayTraining.review.approve')}
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={reject}
                  disabled={busy || photoLoading || reason === ''}
                  sx={{ textTransform: 'none' }}
                >
                  {t('sprayTraining.review.reject')}
                </Button>
                {item.review.status !== 'UNREVIEWED' && (
                  <Button onClick={backToUnreviewed} disabled={busy} sx={{ textTransform: 'none' }}>
                    {t('sprayTraining.review.backToUnreviewed')}
                  </Button>
                )}
              </Box>
              <Typography variant="caption" sx={{ color: themeTokens.neutral[500] }}>
                {t('sprayTraining.review.shortcuts')}
              </Typography>
            </Box>
          </Box>
        </Box>
      )}
    </Dialog>
  );
}
