'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useOptionalBrowserSession } from '@/app/components/providers/session-provider';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import { stripGymNamePrefix } from '@boardsesh/board-config';
import { boardTypeLabel } from '@boardsesh/board-constants';
import {
  GET_BOARD,
  GET_GYM,
  GET_GYM_BOARDS,
  type GetBoardQueryResponse,
  type GetBoardQueryVariables,
  type GetGymBoardsQueryResponse,
  type GetGymBoardsQueryVariables,
  type GetGymQueryResponse,
  type GetGymQueryVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import ReportProblemDialog from './report-problem-dialog';
import type { ReportProblemTarget } from './report-problem-logic';
import { useReportRequest } from './use-report-request';

/**
 * "Something wrong with this board? Report a problem" on the board's climb list
 * (`/b/{slug}/{angle}/list`).
 *
 * That page sits in a shared CDN cache for a day, so this renders the same
 * plain markup for every reader and knows nothing about them. Who is signed
 * in, who added the board and whether its gym is run by the gym are read in the
 * browser once the climber opens the dialog, with their own session. So is the
 * board's setup, which "Set up wrong"'s setup fields start on: `GET_BOARD`
 * already returns it.
 */
export default function BoardReportLink({
  boardUuid,
  setupSuggestionsEnabled = false,
  storeLabels = null,
}: {
  boardUuid: string;
  /** The `directory-setup-suggestions` flag, one answer for every reader like the page's own. */
  setupSuggestionsEnabled?: boolean;
  /** The store badges' words, for the app link after a suggestion changed the board. */
  storeLabels?: StoreButtonLabels | null;
}) {
  const { t } = useTranslation('boards');
  const { token, error: tokenError } = useWsAuthToken();
  const session = useOptionalBrowserSession()?.data;
  // Keyed on who is signed in, not the token: a rotation keeps the loaded board.
  const viewerUserId = session?.user?.id ?? null;
  const [open, setOpen] = useState(false);

  const isKnownKey = useCallback((key: string) => key === boardUuid, [boardUuid]);
  const openDialog = useCallback(() => setOpen(true), []);
  const request = useReportRequest({ onOpen: openDialog, isKnownKey });

  const readsEnabled = open && Boolean(token);
  const boardQuery = useQuery({
    queryKey: ['reportProblemBoard', boardUuid, viewerUserId],
    enabled: readsEnabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const response = await createGraphQLHttpClient(token).request<GetBoardQueryResponse, GetBoardQueryVariables>(
        GET_BOARD,
        { boardUuid },
      );
      return response.board ?? null;
    },
  });
  const gymUuid = boardQuery.data?.gymUuid ?? null;
  const gymQuery = useQuery({
    queryKey: ['reportProblemGym', gymUuid, viewerUserId],
    enabled: readsEnabled && gymUuid !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const response = await createGraphQLHttpClient(token).request<GetGymQueryResponse, GetGymQueryVariables>(
        GET_GYM,
        {
          gymUuid: gymUuid ?? '',
        },
      );
      return response.gym ?? null;
    },
  });
  const gymBoardsQuery = useQuery({
    queryKey: ['reportProblemGymBoards', gymUuid, viewerUserId],
    enabled: readsEnabled && gymUuid !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const response = await createGraphQLHttpClient(token).request<
        GetGymBoardsQueryResponse,
        GetGymBoardsQueryVariables
      >(GET_GYM_BOARDS, { gymUuid: gymUuid ?? '' });
      return response.gymBoards ?? [];
    },
  });

  // The gym's own reads are a nicety: without them the routing line assumes
  // nobody runs the gym, the setup fields show no line above Send (the
  // listing state stays null), and the duplicate picker offers only "Not sure".
  const gymSettled = gymUuid === null || (!gymQuery.isPending && !gymBoardsQuery.isPending);
  const target = useMemo((): ReportProblemTarget | null => {
    const board = boardQuery.data;
    if (!board || !gymSettled) return null;
    const gym = gymQuery.data ?? null;
    const gymName = gym?.name ?? board.gymName ?? null;
    return {
      kind: 'board',
      board: {
        uuid: board.uuid,
        name: stripGymNamePrefix(board.name, gymName),
        ownerId: board.ownerId ?? null,
        ownerDisplayName: board.ownerDisplayName ?? null,
        setup:
          board.boardType === 'spray'
            ? null
            : {
                boardType: board.boardType,
                layoutId: board.layoutId,
                sizeId: board.sizeId,
                setIds: board.setIds,
                angle: board.angle,
                isAngleAdjustable: board.isAngleAdjustable,
              },
      },
      gym:
        gymUuid !== null && gymName !== null
          ? {
              uuid: gymUuid,
              name: gymName,
              slug: gym?.slug ?? null,
              listingState: gym?.listingState ?? null,
              canClaim: gym?.canClaim ?? false,
              latitude: gym?.latitude,
              longitude: gym?.longitude,
            }
          : null,
      otherBoards: (gymBoardsQuery.data ?? [])
        .filter((other) => other.uuid !== board.uuid && other.boardType !== 'spray')
        .map((other) => ({
          uuid: other.uuid,
          label: `${stripGymNamePrefix(other.name, gymName)} · ${boardTypeLabel(other.boardType)} · ${other.angle}°`,
        })),
    };
  }, [boardQuery.data, gymSettled, gymQuery.data, gymBoardsQuery.data, gymUuid]);

  const loadFailed = Boolean(tokenError) || boardQuery.isError || (boardQuery.isSuccess && boardQuery.data === null);

  return (
    <Box component="p" sx={{ m: 0, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 0.5 }}>
      <Typography component="span" variant="body2" sx={{ color: 'var(--neutral-700)' }}>
        {t('report.boardListLink')}
      </Typography>
      <Button
        variant="text"
        size="small"
        startIcon={<FlagOutlined sx={{ fontSize: 16 }} />}
        onClick={() => request(boardUuid)}
        sx={{ textTransform: 'none', minHeight: 44, minWidth: 44 }}
      >
        {t('report.action')}
      </Button>
      <ReportProblemDialog
        open={open}
        onClose={() => setOpen(false)}
        target={target}
        loadFailed={loadFailed}
        onRetryLoad={() => void boardQuery.refetch()}
        setupSuggestionsEnabled={setupSuggestionsEnabled}
        storeLabels={storeLabels}
        // The list's HTML is cached for everyone; read the board again so a reopened dialog starts on its new setup.
        onSetupApplied={() => void boardQuery.refetch()}
      />
    </Box>
  );
}
