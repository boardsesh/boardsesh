'use client';

/**
 * Lifted out of `components/settings/aurora-credentials-section.tsx` by W-21
 * (#4440). `/settings` no longer renders the Aurora credentials section — board
 * accounts live in the app now — but `board-import-prompt.tsx` still renders the
 * credential card and the import progress list, and that prompt is on two
 * indexable surfaces the epic keeps: `/aurora-migration` and `/profile/{id}`.
 * Co-located with its only consumer so the lift removes a cross-directory edge
 * instead of relocating one.
 *
 * Moved verbatim. Two branches are unreachable from the surviving consumer (the
 * `kilterNew` variant and the `totalUnsynced > 0` alert, which
 * `board-import-prompt` never triggers); trimming them would cascade into the
 * `settings:aurora.card.*` / `settings:aurora.unsynced.*` catalog keys, so they
 * stay for W-26 (#4442) to judge.
 */

import React from 'react';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import AccessTimeOutlined from '@mui/icons-material/AccessTimeOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import EmailOutlined from '@mui/icons-material/EmailOutlined';
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import LinkOutlined from '@mui/icons-material/LinkOutlined';
import RadioButtonUncheckedOutlined from '@mui/icons-material/RadioButtonUncheckedOutlined';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import WarningOutlined from '@mui/icons-material/WarningOutlined';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import type { AuroraCredentialStatus } from '@/app/lib/aurora-credentials/client';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import styles from './board-credential-card.module.css';

type BoardUnsyncedCounts = {
  ascents: number;
  climbs: number;
};

export type ImportPhase = 'preview' | 'importing' | 'complete' | 'error';

export type ImportStep = 'climbs' | 'resolving' | 'dedup' | 'ascents' | 'attempts' | 'circuits';

export type ImportProgress = {
  step: ImportStep;
  message?: string;
  current?: number;
  total?: number;
};

export const STEP_ORDER: ImportStep[] = ['climbs', 'resolving', 'dedup', 'ascents', 'attempts', 'circuits'];

/**
 * Untranslated fallback labels, kept alongside `getStepLabels(t)` because the
 * moved `import-progress-steps` test asserts against them. No production caller
 * reads this map — that was already true before the lift; flagged for W-26
 * (#4442) rather than changed here.
 */
export const STEP_LABELS: Record<ImportStep, string> = {
  climbs: 'Importing draft climbs',
  resolving: 'Resolving climb names',
  dedup: 'Checking for duplicates',
  ascents: 'Importing ascents',
  attempts: 'Importing attempts',
  circuits: 'Importing circuits',
};

function getStepLabels(t: TFunction<'settings'>): Record<ImportStep, string> {
  return {
    climbs: t('aurora.import.steps.climbs'),
    resolving: t('aurora.import.steps.resolving'),
    dedup: t('aurora.import.steps.dedup'),
    ascents: t('aurora.import.steps.ascents'),
    attempts: t('aurora.import.steps.attempts'),
    circuits: t('aurora.import.steps.circuits'),
  };
}

function buildKilterDataRequestMailto(
  t: TFunction<'settings'>,
  userName?: string | null,
  userEmail?: string | null,
): string {
  const name = userName || t('aurora.kilterEmail.namePlaceholder');
  const email = userEmail || t('aurora.kilterEmail.emailPlaceholder');
  const subject = t('aurora.kilterEmail.subject');
  const body = t('aurora.kilterEmail.body', { name, email });

  return `mailto:peter@auroraclimbing.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Kilter renders two cards: `kilterAurora` for the legacy Aurora-built app (JSON
// import + data request) and `kilterNew` for the new Kilter Grips account, which
// links via username/password (ROPC). Every other board is a single `aurora` card.
export type BoardCredentialCardVariant = 'aurora' | 'kilterAurora' | 'kilterNew';

export type BoardCredentialCardProps = {
  boardType: AuroraBoardName;
  variant: BoardCredentialCardVariant;
  credential: AuroraCredentialStatus | null;
  unsyncedCounts: BoardUnsyncedCounts;
  onAdd: () => void;
  onRemove: () => void;
  onImportJson: () => void;
  isRemoving: boolean;
  isImporting: boolean;
  userName?: string | null;
  userEmail?: string | null;
};

export function BoardCredentialCard({
  boardType,
  variant,
  credential,
  unsyncedCounts,
  onAdd,
  onRemove,
  onImportJson,
  isRemoving,
  isImporting,
  userName,
  userEmail,
}: BoardCredentialCardProps) {
  const { t } = useTranslation('settings');
  const boardName = boardType.charAt(0).toUpperCase() + boardType.slice(1);
  const totalUnsynced = unsyncedCounts.ascents + unsyncedCounts.climbs;
  const isExpired = credential?.syncStatus === 'expired';
  const cardTitle =
    variant === 'kilterAurora'
      ? t('aurora.card.kilterAuroraTitle')
      : variant === 'kilterNew'
        ? t('aurora.card.kilterNewTitle')
        : `${boardName} ${t('aurora.card.boardSuffix')}`;

  const getSyncStatusTag = () => {
    if (!credential) return null;

    switch (credential.syncStatus) {
      case 'active':
        return (
          <Chip icon={<CheckCircleOutlined />} label={t('aurora.status.connected')} size="small" color="success" />
        );
      case 'error':
        return <Chip icon={<WarningAmberOutlined />} label={t('aurora.status.error')} size="small" color="error" />;
      case 'expired':
        return <Chip icon={<AccessTimeOutlined />} label={t('aurora.status.expired')} size="small" color="warning" />;
      default:
        return <Chip icon={<SyncOutlined />} label={t('aurora.status.syncing')} size="small" color="primary" />;
    }
  };

  const formatLastSync = (dateString: string | null) => {
    if (!dateString) return t('aurora.card.never');
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  if (!credential) {
    return (
      <Card className={styles.credentialCard}>
        <CardContent>
          <div className={styles.cardHeader}>
            <Typography variant="h5" sx={{ margin: 0 }}>
              {cardTitle}
            </Typography>
          </div>
          {/* Unreachable from the only consumer: `board-import-prompt` passes
              `kilterAurora` or `aurora`, never `kilterNew`. Kept verbatim by the
              W-21 lift because dropping it cascades into
              `settings:aurora.card.kilterNew*` — W-26 (#4442) decides its fate. */}
          {variant === 'kilterNew' ? (
            <>
              <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
                {t('aurora.card.kilterNewCopy')}
              </Typography>
              <div className={styles.buttonRowStacked}>
                <Button variant="contained" startIcon={<LinkOutlined />} onClick={onAdd}>
                  {t('aurora.card.kilterSignIn')}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
                  onClick={onImportJson}
                  disabled={isImporting}
                >
                  {t('aurora.card.import')}
                </Button>
              </div>
            </>
          ) : variant === 'kilterAurora' ? (
            <>
              <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
                {t('aurora.card.kilterAuroraCopy')}
              </Typography>
              <div className={styles.buttonRowStacked}>
                <Button
                  variant="contained"
                  startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
                  onClick={onImportJson}
                  disabled={isImporting}
                >
                  {t('aurora.card.import')}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<EmailOutlined />}
                  href={buildKilterDataRequestMailto(t, userName, userEmail)}
                >
                  {t('aurora.card.requestData')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
                {t('aurora.card.notConnected', { boardName })}
              </Typography>
              <div className={styles.buttonRow}>
                <Button variant="contained" startIcon={<LinkOutlined />} onClick={onAdd}>
                  {t('aurora.card.link')}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
                  onClick={onImportJson}
                  disabled={isImporting}
                >
                  {t('aurora.card.import')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={styles.credentialCard}>
      <CardContent>
        <div className={styles.cardHeader}>
          <Typography variant="h5" sx={{ margin: 0 }}>
            {cardTitle}
          </Typography>
          {getSyncStatusTag()}
        </div>
        <div className={styles.credentialInfo}>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('aurora.card.username')}
            </Typography>
            <Typography variant="body2" component="span" fontWeight={600}>
              {credential.auroraUsername}
            </Typography>
          </div>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('aurora.card.lastSynced')}
            </Typography>
            <Typography variant="body2" component="span">
              {formatLastSync(credential.lastSyncAt)}
            </Typography>
          </div>
          {credential.syncError && (
            <div className={styles.errorRow}>
              {/* Known codes get localised copy and a warning tone — the account is
                  syncing, only its playlist mirror is paused (#3526). Anything else
                  is legacy free text from an older path: render it verbatim rather
                  than swallow it. */}
              <Typography
                variant="body2"
                component="span"
                color={credential.syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR ? 'warning.main' : 'error'}
              >
                {credential.syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR
                  ? t('aurora.status.duplicateAccountCircuits')
                  : credential.syncError}
              </Typography>
            </div>
          )}
          {/* Also unreachable today: `board-import-prompt` always passes
              `{ ascents: 0, climbs: 0 }`. Same W-26 (#4442) note as `kilterNew`
              above — dropping it would strand `settings:aurora.unsynced.*`. */}
          {totalUnsynced > 0 && (
            <MuiAlert severity="warning" icon={<WarningOutlined />} className={styles.unsyncedAlert}>
              <AlertTitle>{t('aurora.unsynced.title', { count: totalUnsynced })}</AlertTitle>
              <Typography variant="body2" component="span" color="text.secondary">
                {unsyncedCounts.ascents > 0 && t('aurora.unsynced.ascents', { count: unsyncedCounts.ascents })}
                {unsyncedCounts.ascents > 0 && unsyncedCounts.climbs > 0 && ', '}
                {unsyncedCounts.climbs > 0 && t('aurora.unsynced.climbs', { count: unsyncedCounts.climbs })}
              </Typography>
            </MuiAlert>
          )}
        </div>
        <div className={styles.buttonRow}>
          {isExpired && (
            <Button variant="contained" startIcon={<LinkOutlined />} onClick={onAdd}>
              {t('aurora.card.reconnect')}
            </Button>
          )}
          <ConfirmPopover
            title={t('aurora.card.unlinkConfirm.title')}
            description={t('aurora.card.unlinkConfirm.description', { boardName })}
            onConfirm={onRemove}
            okText={t('aurora.card.unlinkConfirm.ok')}
            okButtonProps={{ color: 'error' }}
          >
            <Button
              color="error"
              variant="outlined"
              startIcon={isRemoving ? <CircularProgress size={16} /> : <DeleteOutlined />}
              disabled={isRemoving}
            >
              {t('aurora.card.unlink')}
            </Button>
          </ConfirmPopover>
          <Button
            variant="outlined"
            startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
            onClick={onImportJson}
            disabled={isImporting}
          >
            {t('aurora.card.import')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ImportProgressSteps({ progress }: { progress: ImportProgress | null }) {
  const { t } = useTranslation('settings');
  const stepLabels = getStepLabels(t);
  const currentStepIndex = progress ? STEP_ORDER.indexOf(progress.step) : -1;

  return (
    <div className={styles.progressStepList}>
      {STEP_ORDER.map((step, index) => {
        const isComplete = index < currentStepIndex;
        const isActive = index === currentStepIndex;
        const isPending = index > currentStepIndex;
        const hasCounts = isActive && progress?.current != null && progress?.total != null;
        const progressPercent = hasCounts ? (progress.current! / progress.total!) * 100 : 0;

        return (
          <div key={step} className={styles.progressStep}>
            <div className={styles.progressStepHeader}>
              {isComplete && <CheckCircleOutlined color="success" fontSize="small" />}
              {isActive && <CircularProgress size={20} />}
              {isPending && <RadioButtonUncheckedOutlined color="disabled" fontSize="small" />}
              <Typography
                variant="body2"
                color={isPending ? 'text.disabled' : 'text.primary'}
                fontWeight={isActive ? 600 : 400}
              >
                {stepLabels[step]}
                {hasCounts && ` (${progress.current} / ${progress.total})`}
              </Typography>
            </div>
            {hasCounts && (
              <LinearProgress variant="determinate" value={progressPercent} sx={{ ml: '32px', mr: 1, mt: 0.5 }} />
            )}
            {isActive && !hasCounts && <LinearProgress variant="indeterminate" sx={{ ml: '32px', mr: 1, mt: 0.5 }} />}
          </div>
        );
      })}
    </div>
  );
}
