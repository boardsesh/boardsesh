'use client';

// TODO(board-history): when we ship a dedicated "Recent on this board" feed
// (separate route or drawer surface), surface the next ~10 board-history
// entries here as a collapsible secondary view. MVP intentionally renders
// only the latest entry — see Phase 4 of the federated-locket plan.

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import BluetoothDisabledOutlined from '@mui/icons-material/BluetoothDisabledOutlined';
import HistoryToggleOffOutlined from '@mui/icons-material/HistoryToggleOffOutlined';
import SendOutlined from '@mui/icons-material/SendOutlined';
import GridViewOutlined from '@mui/icons-material/GridViewOutlined';
import type { BoardHistoryEntry } from '@boardsesh/shared-schema';
import { themeTokens } from '@/app/theme/theme-config';
import { formatTickRelativeTime } from '@/app/lib/format-tick-time';
import { useBluetoothConnectedStatus } from '../board-bluetooth-control/bluetooth-status-store';
import { useBoardHistory } from './use-board-history';
import { useBoardVsLocalDivergence } from './use-board-vs-local-divergence';
import { useSendLocalPick } from './use-send-local-pick';

/**
 * Read-only header card pinned at the top of the play-view drawer. Renders
 * the latest entry in the per-board history log so every climber paired to
 * the wall can see "what's actually on it right now" — independent of their
 * own local queue.
 *
 * States:
 * 1. No board (`boardSerial === null`): translucent "pair a board" empty state.
 * 2. Board known but no history yet: translucent "nothing's been on the wall yet" state.
 * 3. Latest entry exists and matches local pick: single-row card with attribution.
 * 4. Latest entry exists and diverges from local pick: two-line layout. When
 *    BLE-connected, a "Send your pick" CTA is rendered so the user can flip
 *    the wall back to their pick with one tap. When not BLE-connected, the
 *    divergence is shown but no CTA is offered (nothing to send to).
 */
export default function CurrentlyOnBoardHeader() {
  const { t } = useTranslation('session');
  const { boardSerial, latestEntry } = useBoardHistory();
  const { divergent, localPick } = useBoardVsLocalDivergence();
  const isBluetoothConnected = useBluetoothConnectedStatus();
  const { sendLocalPick } = useSendLocalPick();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;

  const handleSend = useCallback(() => {
    void sendLocalPick();
  }, [sendLocalPick]);

  if (!boardSerial) {
    return (
      <EmptyState
        icon={<BluetoothDisabledOutlined sx={{ fontSize: 20, opacity: 0.7 }} />}
        title={t('queueDrawer.currentlyOnBoard.noBoardTitle')}
      />
    );
  }

  if (!latestEntry) {
    return (
      <EmptyState
        icon={<HistoryToggleOffOutlined sx={{ fontSize: 20, opacity: 0.7 }} />}
        title={t('queueDrawer.currentlyOnBoard.empty')}
      />
    );
  }

  const attribution = renderAttribution(t, latestEntry, currentUserId);

  if (!divergent) {
    return (
      <HeaderShell>
        <SingleLineEntry attribution={attribution} />
      </HeaderShell>
    );
  }

  return (
    <HeaderShell emphasis>
      <DivergentEntry
        attribution={attribution}
        localPickName={localPick?.climb.name}
        showSendCta={isBluetoothConnected}
        sendCtaLabel={t('queueDrawer.currentlyOnBoard.sendYourPick')}
        yourPickLabel={t('queueDrawer.currentlyOnBoard.yourPickLabel')}
        onSend={handleSend}
      />
    </HeaderShell>
  );
}

function renderAttribution(
  t: (key: string, opts?: Record<string, unknown>) => string,
  entry: BoardHistoryEntry,
  currentUserId: string | null,
): string {
  const relativeTime = formatTickRelativeTime(entry.sentAt);
  if (currentUserId && entry.userId === currentUserId) {
    return t('queueDrawer.currentlyOnBoard.sentByYou', { relativeTime });
  }
  const displayName = entry.username ?? t('queueDrawer.currentlyOnBoard.anonymous');
  return t('queueDrawer.currentlyOnBoard.sentBy', { name: displayName, relativeTime });
}

/**
 * Shared shell used by all states. Background switches to the elevated
 * surface token when `emphasis` is true so the divergent state visually
 * stands out from the queue list below.
 */
function HeaderShell({ children, emphasis = false }: { children: React.ReactNode; emphasis?: boolean }) {
  const { t } = useTranslation('session');
  return (
    <Box
      sx={{
        px: `${themeTokens.spacing[3]}px`,
        py: `${themeTokens.spacing[2]}px`,
        backgroundColor: emphasis ? 'background.paper' : 'background.default',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography
        variant="overline"
        component="div"
        sx={{
          display: 'block',
          color: 'text.secondary',
          fontWeight: themeTokens.typography.fontWeight.medium,
          lineHeight: themeTokens.typography.lineHeight.tight,
          mb: 0.5,
        }}
      >
        {t('queueDrawer.currentlyOnBoard.label')}
      </Typography>
      {children}
    </Box>
  );
}

function EmptyState({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <Box
      sx={{
        px: `${themeTokens.spacing[3]}px`,
        py: `${themeTokens.spacing[2]}px`,
        backgroundColor: 'background.default',
        borderBottom: '1px solid',
        borderColor: 'divider',
        opacity: themeTokens.opacity.subtle,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center">
        {icon}
        <Typography variant="body2" color="text.secondary">
          {title}
        </Typography>
      </Stack>
    </Box>
  );
}

function SingleLineEntry({ attribution }: { attribution: string }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      <GridViewOutlined sx={{ fontSize: 22, color: 'text.secondary', flexShrink: 0 }} />
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 0, flex: 1 }} noWrap>
        {attribution}
      </Typography>
    </Stack>
  );
}

function DivergentEntry({
  attribution,
  localPickName,
  showSendCta,
  sendCtaLabel,
  yourPickLabel,
  onSend,
}: {
  attribution: string;
  localPickName: string | undefined;
  showSendCta: boolean;
  sendCtaLabel: string;
  yourPickLabel: string;
  onSend: () => void;
}) {
  const pickChip = useMemo(() => {
    if (!localPickName) return null;
    return (
      <Chip
        size="small"
        label={localPickName}
        sx={{
          maxWidth: 180,
          backgroundColor: 'action.selected',
          color: 'text.primary',
          '& .MuiChip-label': {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        }}
      />
    );
  }, [localPickName]);

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <GridViewOutlined sx={{ fontSize: 22, color: 'text.primary', flexShrink: 0 }} />
        <Typography variant="body2" color="text.primary" sx={{ minWidth: 0, flex: 1 }} noWrap>
          {attribution}
        </Typography>
      </Stack>
      {showSendCta && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{
            // Stack vertically on narrow viewports so the CTA always has room
            // for its full label without truncating the climb name chip.
            '@media (max-width: 360px)': {
              flexDirection: 'column',
              alignItems: 'stretch',
            },
          }}
        >
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {yourPickLabel}
            </Typography>
            {pickChip}
          </Stack>
          <Button
            size="small"
            variant="contained"
            color="primary"
            startIcon={<SendOutlined sx={{ fontSize: 16 }} />}
            onClick={onSend}
            sx={{ flexShrink: 0 }}
          >
            {sendCtaLabel}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
