'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';

import BoardConfigSelects from '@/app/components/board-selector-drawer/board-config-selects';
import { getDefaultSizeForLayout } from '@/app/lib/board-constants';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { BoardName } from '@/app/lib/types';
import type { Esp32Connection } from '@/app/lib/user-preferences-db';

type AddEsp32DialogProps = {
  open: boolean;
  boardConfigs: BoardConfigData;
  initial?: Esp32Connection;
  onClose: () => void;
  onSubmit: (conn: Esp32Connection) => void;
};

const DEFAULTS: Esp32Connection = {
  id: '',
  label: 'Desk ESP32',
  ip: '192.168.1.100',
  board: 'kilter',
  serial: '751737',
  apiLevel: 3,
  layoutId: 1,
  sizeId: 10,
  setIds: [1, 20],
  angle: 40,
};

export default function AddEsp32Dialog({ open, boardConfigs, initial, onClose, onSubmit }: AddEsp32DialogProps) {
  const [form, setForm] = useState<Esp32Connection>(initial ?? DEFAULTS);

  useEffect(() => {
    setForm(initial ?? DEFAULTS);
  }, [initial, open]);

  const isEdit = Boolean(initial);

  // Mirror the cascade logic from BoardSelectorDrawer (board → layout → default
  // size → all sets) so the user only has to pick a board to get a working
  // config. Without this the form ships with stale numeric defaults that don't
  // match a freshly-picked board.
  const layouts = useMemo(() => boardConfigs.layouts[form.board] ?? [], [boardConfigs.layouts, form.board]);
  const sizes = useMemo(
    () => boardConfigs.sizes[`${form.board}-${form.layoutId}`] ?? [],
    [boardConfigs.sizes, form.board, form.layoutId],
  );
  const sets = useMemo(
    () => boardConfigs.sets[`${form.board}-${form.layoutId}-${form.sizeId}`] ?? [],
    [boardConfigs.sets, form.board, form.layoutId, form.sizeId],
  );

  const handleBoardChange = (board: BoardName): void => {
    const nextLayouts = boardConfigs.layouts[board] ?? [];
    const nextLayoutId = nextLayouts[0]?.id ?? 0;
    const defaultSize = nextLayoutId ? getDefaultSizeForLayout(board, nextLayoutId) : null;
    const nextSizes = nextLayoutId ? (boardConfigs.sizes[`${board}-${nextLayoutId}`] ?? []) : [];
    const nextSizeId = defaultSize ?? nextSizes[0]?.id ?? 0;
    const nextSets = nextSizeId ? (boardConfigs.sets[`${board}-${nextLayoutId}-${nextSizeId}`] ?? []) : [];
    setForm((f) => ({
      ...f,
      board,
      layoutId: nextLayoutId,
      sizeId: nextSizeId,
      setIds: nextSets.map((s) => s.id),
    }));
  };

  const handleLayoutChange = (layoutId: number): void => {
    const defaultSize = getDefaultSizeForLayout(form.board, layoutId);
    const nextSizes = boardConfigs.sizes[`${form.board}-${layoutId}`] ?? [];
    const nextSizeId = defaultSize ?? nextSizes[0]?.id ?? 0;
    const nextSets = nextSizeId ? (boardConfigs.sets[`${form.board}-${layoutId}-${nextSizeId}`] ?? []) : [];
    setForm((f) => ({ ...f, layoutId, sizeId: nextSizeId, setIds: nextSets.map((s) => s.id) }));
  };

  const handleSizeChange = (sizeId: number): void => {
    const nextSets = boardConfigs.sets[`${form.board}-${form.layoutId}-${sizeId}`] ?? [];
    setForm((f) => ({ ...f, sizeId, setIds: nextSets.map((s) => s.id) }));
  };

  const handleSubmit = (): void => {
    const id =
      form.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    onSubmit({
      ...form,
      id,
      // Strip any scheme, port, or path the user might have pasted.
      ip: form.ip.replace(/^(?:https?|wss?):\/\//, '').replace(/[/:].*$/, ''),
    });
  };

  const isComplete =
    form.label.trim().length > 0 &&
    form.ip.trim().length > 0 &&
    form.layoutId > 0 &&
    (form.board === 'moonboard' || form.sizeId > 0) &&
    form.setIds.length > 0;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isEdit ? 'Edit ESP32' : 'Add ESP32'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            // i18n-ignore-next-line -- internal dev tool, English only
            label="Label"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            fullWidth
            size="small"
          />
          <TextField
            // i18n-ignore-next-line -- internal dev tool, English only
            label="Host or IP address"
            value={form.ip}
            onChange={(e) => setForm({ ...form, ip: e.target.value })}
            // i18n-ignore-next-line -- internal dev tool, English only
            placeholder="kilter-board-751737-3-db2a80.local"
            fullWidth
            size="small"
          />
          <TextField
            // i18n-ignore-next-line -- internal dev tool, English only
            label="Serial"
            value={form.serial}
            onChange={(e) => setForm({ ...form, serial: e.target.value })}
            // i18n-ignore-next-line -- internal dev tool, English only
            helperText="Used in the BLE advertised name (e.g. Kilter Board#751737@3)"
            fullWidth
            size="small"
          />
          <TextField
            // i18n-ignore-next-line -- internal dev tool, English only
            label="API level"
            value={form.apiLevel}
            onChange={(e) => setForm({ ...form, apiLevel: e.target.value === '2' ? 2 : 3 })}
            select
            fullWidth
            size="small"
            disabled={form.board === 'moonboard'}
            helperText={form.board === 'moonboard' ? 'Ignored for MoonBoard.' : '2 = legacy, 3 = current'}
          >
            <MenuItem value={3}>3</MenuItem>
            <MenuItem value={2}>2</MenuItem>
          </TextField>

          <BoardConfigSelects
            selectedBoard={form.board}
            selectedLayout={form.layoutId || undefined}
            selectedSize={form.sizeId || undefined}
            selectedSets={form.setIds}
            selectedAngle={form.angle}
            layouts={layouts}
            sizes={sizes}
            sets={sets}
            onBoardChange={handleBoardChange}
            onLayoutChange={handleLayoutChange}
            onSizeChange={handleSizeChange}
            onSetsChange={(setIds) => setForm((f) => ({ ...f, setIds }))}
            onAngleChange={(angle) => setForm((f) => ({ ...f, angle }))}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        {/* i18n-ignore-next-line -- internal dev tool, English only */}
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!isComplete}>
          {isEdit ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
