'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import { gymPageCtaClicked } from '@boardsesh/analytics';
import ReportProblemDialog from '@/app/components/directory-reports/report-problem-dialog';
import type {
  ReportBoardSetup,
  ReportGymSubject,
  ReportProblemTarget,
} from '@/app/components/directory-reports/report-problem-logic';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import { GYM_REPORT_KEY } from '@/app/components/directory-reports/report-return-param';
import { useReportRequest } from '@/app/components/directory-reports/use-report-request';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';

/** One board row as the report dialog needs it. Built on the server from the listing it renders. */
export type GymReportBoard = {
  uuid: string;
  /** The row's name, gym prefix stripped. */
  name: string;
  /** Name plus the row's subtitle, so two boards that share a name can be told apart in the duplicate picker. */
  label: string;
  ownerId: string | null;
  /** The setup the listing shows, for "Set up wrong"'s setup fields; null for a spray wall. */
  setup: ReportBoardSetup | null;
};

/**
 * The buttons and the one dialog are separate islands, so the page can drop a
 * flag into each server-rendered board row without wrapping the page in a
 * provider. A button names its gym and what to report; the host for that gym
 * opens the dialog. Taps only happen in the browser, after the host has mounted.
 */
type ReportRequestListener = (gymUuid: string, key: string) => void;
const reportRequestListeners = new Set<ReportRequestListener>();

function requestGymReport(gymUuid: string, key: string): void {
  for (const listener of reportRequestListeners) listener(gymUuid, key);
}

/**
 * Report a problem for one gym and its boards: the dialog, and the board list
 * handed to the browser once rather than once per row. The gym page renders it
 * only while the `directory-reports` flag is on and only for viewers who can't
 * edit the gym (staff have Manage gym).
 *
 * The buttons render the same markup for every visitor; who is signed in is
 * settled in the browser when the climber taps (`useReportRequest`).
 */
export function GymReportProblemHost({
  gym,
  boards,
  countAsGymPageCta = true,
  setupSuggestionsEnabled = false,
  storeLabels = null,
}: {
  gym: ReportGymSubject;
  boards: GymReportBoard[];
  /** Count taps as `Gym Page CTA Clicked`. Off outside the public gym page (the manage lock state). */
  countAsGymPageCta?: boolean;
  /** The `directory-setup-suggestions` flag: "Set up wrong" offers the setup fields. */
  setupSuggestionsEnabled?: boolean;
  /** The store badges' words, for the app link after a suggestion changed a board. */
  storeLabels?: StoreButtonLabels | null;
}) {
  const [open, setOpen] = useState(false);
  const router = useLocaleRouter();
  // Kept after close so the dialog doesn't empty itself while it fades out.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const boardsByUuid = useMemo(() => new Map(boards.map((board) => [board.uuid, board])), [boards]);

  const isKnownKey = useCallback((key: string) => key === GYM_REPORT_KEY || boardsByUuid.has(key), [boardsByUuid]);
  const openReport = useCallback((key: string) => {
    setActiveKey(key);
    setOpen(true);
  }, []);
  const requestReport = useReportRequest({ onOpen: openReport, isKnownKey });

  useEffect(() => {
    const listener: ReportRequestListener = (gymUuid, key) => {
      if (gymUuid !== gym.uuid || !isKnownKey(key)) return;
      if (countAsGymPageCta) trackGymFunnelEvent(gymPageCtaClicked({ cta: 'report-problem', gymUuid }));
      requestReport(key);
    };
    reportRequestListeners.add(listener);
    return () => {
      reportRequestListeners.delete(listener);
    };
  }, [countAsGymPageCta, gym.uuid, isKnownKey, requestReport]);

  const target = useMemo((): ReportProblemTarget | null => {
    if (activeKey === null) return null;
    if (activeKey === GYM_REPORT_KEY) return { kind: 'gym', gym };
    const board = boardsByUuid.get(activeKey);
    if (!board) return null;
    return {
      kind: 'board',
      // The public listing carries no creator name (the anonymous leaderboard
      // embed shares its fields), so the routing line says "the climber who
      // added this board".
      board: {
        uuid: board.uuid,
        name: board.name,
        ownerId: board.ownerId,
        ownerDisplayName: null,
        setup: board.setup,
      },
      gym,
      otherBoards: boards
        .filter((other) => other.uuid !== board.uuid)
        .map((other) => ({ uuid: other.uuid, label: other.label })),
    };
  }, [activeKey, boards, boardsByUuid, gym]);

  return (
    <ReportProblemDialog
      open={open && target !== null}
      onClose={() => setOpen(false)}
      target={target}
      setupSuggestionsEnabled={setupSuggestionsEnabled}
      storeLabels={storeLabels}
      // The page renders per request, so a refresh puts the new setup on the board's row.
      onSetupApplied={router.refresh}
    />
  );
}

/** The 44px flag at the end of a board row. */
export function ReportBoardButton({
  gymUuid,
  boardUuid,
  boardName,
}: {
  gymUuid: string;
  boardUuid: string;
  boardName: string;
}) {
  const { t } = useTranslation('boards');
  return (
    <Tooltip title={t('report.action')}>
      <IconButton
        aria-label={t('report.actionAria', { name: boardName })}
        onClick={() => requestGymReport(gymUuid, boardUuid)}
        sx={{ width: 44, height: 44, color: 'var(--neutral-500)' }}
      >
        <FlagOutlined fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

/**
 * "Report a problem" for the gym listing itself: a quiet text button in the gym
 * page's details column (shown signed out too), an outlined one beside Claim
 * on the manage lock state.
 */
export function ReportGymButton({ gymUuid, variant = 'text' }: { gymUuid: string; variant?: 'text' | 'outlined' }) {
  const { t } = useTranslation('boards');
  const button = (
    <Button
      variant={variant}
      size={variant === 'text' ? 'small' : 'medium'}
      startIcon={<FlagOutlined sx={{ fontSize: variant === 'text' ? 16 : undefined }} />}
      onClick={() => requestGymReport(gymUuid, GYM_REPORT_KEY)}
      sx={{ textTransform: 'none', minHeight: 44, ...(variant === 'text' ? { color: 'text.secondary' } : {}) }}
    >
      {t('report.action')}
    </Button>
  );
  return variant === 'text' ? <Box sx={{ mb: 3 }}>{button}</Box> : button;
}
