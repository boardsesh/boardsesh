'use client';

import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MuiSelect, { SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import CircularProgress from '@mui/material/CircularProgress';
import CollapsibleSection from '@/app/components/collapsible-section/collapsible-section';
import type { CollapsibleSectionConfig } from '@/app/components/collapsible-section/collapsible-section';
import { useRouter } from 'next/navigation';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { BoardConfigData } from '@/app/lib/server-board-configs';
import { BoardName } from '@/app/lib/types';
import { BOARD_NAME_PREFIX_REGEX } from '@/app/lib/board-constants';
import { SUPPORTED_BOARDS, ANGLES } from '@/app/lib/board-data';
import { getDefaultSizeForLayout } from '@/app/lib/board-constants';
import { constructClimbListWithSlugs, constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { saveBoardConfig, StoredBoardConfig } from '@/app/lib/saved-boards-db';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoardSwitchGuard } from '@/app/components/board-lock/use-board-switch-guard';
import type { BoardRouteIdentity } from '@/app/lib/types';
import { useViewModePreference } from '@/app/hooks/use-view-mode-preference';

const CreateBoardForm = lazy(() => import('../board-entity/create-board-form'));

interface BoardConfigSelectsProps {
  selectedBoard: BoardName | undefined;
  selectedLayout: number | undefined;
  selectedSize: number | undefined;
  selectedSets: number[];
  selectedAngle: number;
  layouts: Array<{ id: number; name: string }>;
  sizes: Array<{ id: number; name: string; description?: string }>;
  sets: Array<{ id: number; name: string }>;
  onBoardChange: (board: BoardName) => void;
  onLayoutChange: (layoutId: number) => void;
  onSizeChange: (sizeId: number) => void;
  onSetsChange: (setIds: number[]) => void;
  onAngleChange: (angle: number) => void;
}

function BoardConfigSelects({
  selectedBoard,
  selectedLayout,
  selectedSize,
  selectedSets,
  selectedAngle,
  layouts,
  sizes,
  sets,
  onBoardChange,
  onLayoutChange,
  onSizeChange,
  onSetsChange,
  onAngleChange,
}: BoardConfigSelectsProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <FormControl fullWidth size="small">
        <InputLabel>Board</InputLabel>
        <MuiSelect
          value={selectedBoard || ''}
          label="Board"
          onChange={(e: SelectChangeEvent) => onBoardChange(e.target.value as BoardName)}
        >
          {SUPPORTED_BOARDS.map((board) => (
            <MenuItem key={board} value={board}>
              {board.charAt(0).toUpperCase() + board.slice(1)}
            </MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      <FormControl fullWidth size="small">
        <InputLabel>Layout</InputLabel>
        <MuiSelect
          value={selectedLayout ?? ''}
          label="Layout"
          onChange={(e: SelectChangeEvent<number | string>) => onLayoutChange(e.target.value as number)}
          disabled={!selectedBoard}
        >
          {layouts.map(({ id, name }) => (
            <MenuItem key={id} value={id}>
              {name}
            </MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      {selectedBoard !== 'moonboard' && (
        <FormControl fullWidth size="small">
          <InputLabel>Size</InputLabel>
          <MuiSelect
            value={selectedSize ?? ''}
            label="Size"
            onChange={(e: SelectChangeEvent<number | string>) => onSizeChange(e.target.value as number)}
            disabled={!selectedLayout}
          >
            {sizes.map(({ id, name, description }) => (
              <MenuItem key={id} value={id}>{`${name} ${description}`}</MenuItem>
            ))}
          </MuiSelect>
        </FormControl>
      )}

      <FormControl fullWidth size="small">
        <InputLabel>Hold Sets</InputLabel>
        <MuiSelect<number[]>
          multiple
          value={selectedSets}
          label="Hold Sets"
          onChange={(e) => onSetsChange(e.target.value as number[])}
          disabled={!selectedSize}
        >
          {sets.map(({ id, name }) => (
            <MenuItem key={id} value={id}>
              {name}
            </MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      <FormControl fullWidth size="small">
        <InputLabel>Angle</InputLabel>
        <MuiSelect
          value={selectedAngle}
          label="Angle"
          onChange={(e: SelectChangeEvent<number>) => onAngleChange(e.target.value as number)}
          disabled={!selectedBoard}
        >
          {selectedBoard &&
            ANGLES[selectedBoard].map((angle) => (
              <MenuItem key={angle} value={angle}>
                {angle}
              </MenuItem>
            ))}
        </MuiSelect>
      </FormControl>
    </Box>
  );
}

interface BoardSelectorDrawerProps {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  boardConfigs: BoardConfigData;
  placement?: 'top' | 'bottom';
  onBoardSelected?: (url: string, config?: StoredBoardConfig) => void;
}

export default function BoardSelectorDrawer({
  open,
  onClose,
  onTransitionEnd,
  boardConfigs,
  placement = 'bottom',
  onBoardSelected,
}: BoardSelectorDrawerProps) {
  const router = useRouter();
  const guardBoardSwitch = useBoardSwitchGuard();
  const viewMode = useViewModePreference();
  const [showCreateBoardForm, setShowCreateBoardForm] = useState(false);

  // Board config form state
  const [selectedBoard, setSelectedBoard] = useState<BoardName | undefined>(undefined);
  const [selectedLayout, setSelectedLayout] = useState<number>();
  const [selectedSize, setSelectedSize] = useState<number>();
  const [selectedSets, setSelectedSets] = useState<number[]>([]);
  const [selectedAngle, setSelectedAngle] = useState<number>(40);

  // Derived data
  const layouts = useMemo(
    () => (selectedBoard ? boardConfigs.layouts[selectedBoard] || [] : []),
    [selectedBoard, boardConfigs.layouts],
  );
  const sizes = useMemo(
    () => (selectedBoard && selectedLayout ? boardConfigs.sizes[`${selectedBoard}-${selectedLayout}`] || [] : []),
    [selectedBoard, selectedLayout, boardConfigs.sizes],
  );
  const sets = useMemo(
    () =>
      selectedBoard && selectedLayout && selectedSize
        ? boardConfigs.sets[`${selectedBoard}-${selectedLayout}-${selectedSize}`] || []
        : [],
    [selectedBoard, selectedLayout, selectedSize, boardConfigs.sets],
  );

  // Auto-select first board on open
  useEffect(() => {
    if (open && !selectedBoard && SUPPORTED_BOARDS.length > 0) {
      setSelectedBoard(SUPPORTED_BOARDS[0] as BoardName);
    }
    // selectedBoard intentionally excluded: we only auto-select on open, not on every board change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-cascade: layout when board changes
  useEffect(() => {
    if (!selectedBoard) {
      setSelectedLayout(undefined);
      setSelectedSize(undefined);
      setSelectedSets([]);
      return;
    }
    const availableLayouts = boardConfigs.layouts[selectedBoard] || [];
    if (availableLayouts.length > 0) {
      setSelectedLayout(availableLayouts[0].id);
    } else {
      setSelectedLayout(undefined);
    }
    setSelectedSize(undefined);
    setSelectedSets([]);
  }, [selectedBoard, boardConfigs]);

  // Auto-cascade: size when layout changes
  useEffect(() => {
    if (!selectedBoard || !selectedLayout) {
      setSelectedSize(undefined);
      setSelectedSets([]);
      return;
    }
    const defaultSizeId = getDefaultSizeForLayout(selectedBoard, selectedLayout);
    if (defaultSizeId !== null) {
      setSelectedSize(defaultSizeId);
    } else {
      const availableSizes = boardConfigs.sizes[`${selectedBoard}-${selectedLayout}`] || [];
      setSelectedSize(availableSizes.length > 0 ? availableSizes[0].id : undefined);
    }
    setSelectedSets([]);
  }, [selectedBoard, selectedLayout, boardConfigs]);

  // Auto-cascade: sets when size changes
  useEffect(() => {
    if (!selectedBoard || !selectedLayout || !selectedSize) {
      setSelectedSets([]);
      return;
    }
    const availableSets = boardConfigs.sets[`${selectedBoard}-${selectedLayout}-${selectedSize}`] || [];
    setSelectedSets(availableSets.map((s) => s.id));
  }, [selectedBoard, selectedLayout, selectedSize, boardConfigs]);

  // Compute target URL
  const targetUrl = useMemo(() => {
    if (!selectedBoard || !selectedLayout || !selectedSize || selectedSets.length === 0) {
      return null;
    }
    const layout = layouts.find((l) => l.id === selectedLayout);
    const size = sizes.find((s) => s.id === selectedSize);
    const selectedSetNames = sets.filter((s) => selectedSets.includes(s.id)).map((s) => s.name);
    if (layout && size && selectedSetNames.length > 0) {
      return constructClimbListWithSlugs(
        selectedBoard,
        layout.name,
        size.name,
        size.description,
        selectedSetNames,
        selectedAngle,
        viewMode,
      );
    }
    return null;
  }, [selectedBoard, selectedLayout, selectedSize, selectedSets, selectedAngle, viewMode, layouts, sizes, sets]);

  const handleStartClimbing = useCallback(async () => {
    if (!selectedBoard || !selectedLayout || !selectedSize || selectedSets.length === 0 || !targetUrl) {
      return;
    }

    const layout = layouts.find((l) => l.id === selectedLayout);
    const size = sizes.find((s) => s.id === selectedSize);
    const suggestedName = `${layout?.name || ''} ${size?.name || ''}`.trim();

    const config: StoredBoardConfig = {
      name: suggestedName || `${selectedBoard} board`,
      board: selectedBoard,
      layoutId: selectedLayout,
      sizeId: selectedSize,
      setIds: selectedSets,
      angle: selectedAngle,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };

    const target: BoardRouteIdentity = {
      board_name: selectedBoard,
      layout_id: selectedLayout,
      size_id: selectedSize,
      set_ids: selectedSets,
      layout_name: layout?.name,
      size_name: size?.name,
      size_description: size?.description,
    };

    guardBoardSwitch(target, async () => {
      await saveBoardConfig(config);
      if (onBoardSelected) {
        onBoardSelected(targetUrl, config);
        onClose();
      } else {
        router.push(targetUrl);
        onClose();
      }
    });
  }, [
    selectedBoard,
    selectedLayout,
    selectedSize,
    selectedSets,
    selectedAngle,
    targetUrl,
    layouts,
    sizes,
    onBoardSelected,
    onClose,
    router,
    guardBoardSwitch,
  ]);

  const isFormComplete = selectedBoard && selectedLayout && selectedSize && selectedSets.length > 0;

  // Top-anchored drawers place the shared close button at top-right, which
  // would float over the title bar's empty right edge. These drawers already
  // have swipe-to-dismiss and a backdrop click, so suppress the close button
  // for top placement only. Pass swipeEnabled explicitly so the showCloseButton
  // linkage doesn't also disable swipe (see swipeable-drawer.tsx:77).
  const topDrawerDismissProps =
    placement === 'top' ? ({ showCloseButton: false as const, swipeEnabled: true } as const) : {};

  return (
    <>
      <SwipeableDrawer
        title="Custom Board"
        placement={placement}
        {...topDrawerDismissProps}
        open={open}
        onClose={onClose}
        onTransitionEnd={onTransitionEnd}
        height="85dvh"
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <BoardConfigSelects
            selectedBoard={selectedBoard}
            selectedLayout={selectedLayout}
            selectedSize={selectedSize}
            selectedSets={selectedSets}
            selectedAngle={selectedAngle}
            layouts={layouts}
            sizes={sizes}
            sets={sets}
            onBoardChange={setSelectedBoard}
            onLayoutChange={setSelectedLayout}
            onSizeChange={setSelectedSize}
            onSetsChange={setSelectedSets}
            onAngleChange={setSelectedAngle}
          />

          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              size="large"
              fullWidth
              onClick={() => setShowCreateBoardForm(true)}
              disabled={!isFormComplete}
            >
              Create board
            </Button>
            <Button variant="contained" size="large" fullWidth onClick={handleStartClimbing} disabled={!isFormComplete}>
              Quick session
            </Button>
          </Box>
        </Box>
      </SwipeableDrawer>

      {/* Create Board form drawer */}
      {selectedBoard && selectedLayout && selectedSize && (
        <SwipeableDrawer
          title="Create Board"
          placement={placement}
          {...topDrawerDismissProps}
          open={showCreateBoardForm}
          onClose={() => setShowCreateBoardForm(false)}
          height="85dvh"
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <CollapsibleSection
              sections={[
                {
                  key: 'config',
                  label: 'Board config',
                  title: 'Board config',
                  defaultSummary: 'Select a board',
                  getSummary: () => {
                    const parts: string[] = [];
                    if (selectedBoard) parts.push(selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1));
                    const layout = layouts.find((l) => l.id === selectedLayout);
                    if (layout) {
                      const cleanName = layout.name.replace(BOARD_NAME_PREFIX_REGEX, '').trim();
                      if (cleanName) parts.push(cleanName);
                    }
                    const size = sizes.find((s) => s.id === selectedSize);
                    if (size) parts.push(size.name);
                    parts.push(`${selectedAngle}\u00B0`);
                    return parts;
                  },
                  content: (
                    <BoardConfigSelects
                      selectedBoard={selectedBoard}
                      selectedLayout={selectedLayout}
                      selectedSize={selectedSize}
                      selectedSets={selectedSets}
                      selectedAngle={selectedAngle}
                      layouts={layouts}
                      sizes={sizes}
                      sets={sets}
                      onBoardChange={setSelectedBoard}
                      onLayoutChange={setSelectedLayout}
                      onSizeChange={setSelectedSize}
                      onSetsChange={setSelectedSets}
                      onAngleChange={setSelectedAngle}
                    />
                  ),
                } satisfies CollapsibleSectionConfig,
              ]}
            />
            <Suspense
              fallback={
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                  <CircularProgress size={32} />
                </Box>
              }
            >
              <CreateBoardForm
                boardType={selectedBoard}
                layoutId={selectedLayout}
                sizeId={selectedSize}
                setIds={selectedSets.join(',')}
                defaultAngle={selectedAngle}
                onSuccess={(board: UserBoard) => {
                  setShowCreateBoardForm(false);
                  const url = constructBoardSlugListUrl(board.slug, board.angle, viewMode);
                  if (onBoardSelected) {
                    onBoardSelected(url);
                    onClose();
                  } else {
                    router.push(url);
                    onClose();
                  }
                }}
                onCancel={() => setShowCreateBoardForm(false)}
              />
            </Suspense>
          </Box>
        </SwipeableDrawer>
      )}
    </>
  );
}
