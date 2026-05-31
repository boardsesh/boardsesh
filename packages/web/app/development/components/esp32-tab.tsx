'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import RefreshOutlined from '@mui/icons-material/RefreshOutlined';

import BoardRenderer from '@/app/components/board-renderer/board-renderer';
import { getBoardDetails } from '@/app/lib/board-constants';
import { getMoonBoardDetails } from '@/app/lib/moonboard-config';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import type { BoardDetails } from '@/app/lib/types';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import type { Esp32Connection } from '@/app/lib/user-preferences-db';

import { PayloadDecoder, type DecodedFrame } from './payload-decoder';
import { useEsp32Socket } from './use-esp32-socket';

type Esp32TabProps = {
  connection: Esp32Connection;
  active: boolean;
  onEdit: () => void;
  onRemove: () => void;
};

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' {
  if (status === 'connected') return 'success';
  if (status === 'connecting' || status === 'reconnecting') return 'warning';
  if (status === 'error') return 'error';
  return 'default';
}

export default function Esp32Tab({ connection, active, onEdit, onRemove }: Esp32TabProps) {
  // The decoder is stateful (multi-frame Aurora payloads), so we keep one per
  // tab and reset it when the configured board geometry changes.
  const decoderRef = useRef<PayloadDecoder>(
    new PayloadDecoder({
      board: connection.board,
      layoutId: connection.layoutId,
      sizeId: connection.sizeId,
    }),
  );

  useEffect(() => {
    decoderRef.current.setConfig({
      board: connection.board,
      layoutId: connection.layoutId,
      sizeId: connection.sizeId,
    });
    decoderRef.current.reset();
  }, [connection.board, connection.layoutId, connection.sizeId]);

  const [latest, setLatest] = useState<DecodedFrame | null>(null);
  const [latestAt, setLatestAt] = useState<number | null>(null);

  const handleBleWrite = (hex: string): void => {
    const bytes = hexToBytes(hex);
    const frames = decoderRef.current.push(bytes);
    if (frames.length > 0) {
      setLatest(frames[frames.length - 1]);
      setLatestAt(Date.now());
    }
  };

  const socket = useEsp32Socket({ ip: connection.ip, onBleWrite: handleBleWrite });

  // Push current config to ESP32 once connected so it advertises the right
  // name even if it booted with a stale NVS-saved config.
  useEffect(() => {
    if (socket.status === 'connected') {
      socket.sendConfig({
        board: connection.board,
        serial: connection.serial,
        apiLevel: connection.apiLevel,
      });
    }
    // socket.sendConfig is stable (useCallback in the hook); only push on connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket.status, connection.board, connection.serial, connection.apiLevel]);

  const boardDetails: BoardDetails | null = useMemo(() => {
    try {
      if (connection.board === 'moonboard') {
        return getMoonBoardDetails({
          layout_id: connection.layoutId,
          set_ids: connection.setIds,
        }) as unknown as BoardDetails;
      }
      return getBoardDetails({
        board_name: connection.board,
        layout_id: connection.layoutId,
        size_id: connection.sizeId,
        set_ids: connection.setIds,
      });
    } catch (e) {
      console.error('[development] Failed to build board details', e);
      return null;
    }
  }, [connection.board, connection.layoutId, connection.sizeId, connection.setIds]);

  const litUpHoldsMap: LitUpHoldsMap | undefined = useMemo(() => {
    if (!latest) return undefined;
    if (latest.framesString.length === 0) return {};
    const map = convertLitUpHoldsStringToMap(latest.framesString, connection.board);
    return map[0] ?? {};
  }, [latest, connection.board]);

  return (
    <Box
      role="tabpanel"
      sx={{
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        gap: 2,
        p: 2,
        height: '100%',
        overflow: 'auto',
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Chip label={`WS: ${socket.status}`} color={statusColor(socket.status)} size="small" />
        <Chip
          label={socket.bleConnected ? 'Phone connected' : 'Phone idle'}
          color={socket.bleConnected ? 'success' : 'default'}
          size="small"
        />
        {socket.hello && (
          <Chip
            label={`${socket.hello.board} #${socket.hello.serial} @${socket.hello.apiLevel}`}
            size="small"
            variant="outlined"
          />
        )}
        {socket.hello?.mdnsHost && <Chip label={socket.hello.mdnsHost} size="small" variant="outlined" />}
        <Box flexGrow={1} />
        {/* i18n-ignore-next-line -- internal dev tool, English only */}
        <Tooltip title="Reconnect">
          <IconButton size="small" onClick={socket.reconnect}>
            <RefreshOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
        {/* i18n-ignore-next-line -- internal dev tool, English only */}
        <Tooltip title="Edit">
          <IconButton size="small" onClick={onEdit}>
            <EditOutlined fontSize="small" />
          </IconButton>
        </Tooltip>
        {/* i18n-ignore-next-line -- internal dev tool, English only */}
        <Tooltip title="Remove">
          <IconButton size="small" onClick={onRemove}>
            <DeleteOutline fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {socket.errorMessage && (
        <Typography variant="caption" color="error">
          {socket.errorMessage}
        </Typography>
      )}

      <Stack direction="row" spacing={2} alignItems="baseline" flexWrap="wrap">
        <Typography variant="body2" color="text.secondary">
          {/* i18n-ignore-next-line -- internal dev tool, English only */}
          ws://{connection.ip}:81/
        </Typography>
        {latestAt && (
          <Typography variant="caption" color="text.secondary">
            {/* i18n-ignore-next-line -- internal dev tool, English only */}
            last frame: {new Date(latestAt).toLocaleTimeString()}
          </Typography>
        )}
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center' }}>
        {boardDetails ? (
          <BoardRenderer boardDetails={boardDetails} litUpHoldsMap={litUpHoldsMap} mirrored={false} fillHeight />
        ) : (
          // i18n-ignore-next-line -- internal dev tool, English only
          <Typography color="error">Could not load board details for this configuration.</Typography>
        )}
      </Box>

      {latest && (
        <Typography
          variant="caption"
          component="div"
          color="text.secondary"
          sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
        >
          {/* i18n-ignore-next-line -- internal dev tool, English only */}
          frames: {latest.framesString || '(empty)'}
        </Typography>
      )}
    </Box>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
