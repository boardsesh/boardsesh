'use client';

import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MuiSelect, { SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import CollapsibleSection from '@/app/components/collapsible-section/collapsible-section';
import type { CollapsibleSectionConfig } from '@/app/components/collapsible-section/collapsible-section';
import { useRouter } from 'next/navigation';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import BoardScrollSection from '../board-scroll/board-scroll-section';
import BoardScrollCard from '../board-scroll/board-scroll-card';
import CreateBoardCard from '../board-scroll/create-board-card';
import { BoardConfigData } from '@/app/lib/server-board-configs';
import { BoardName } from '@/app/lib/types';
import { BOARD_NAME_PREFIX_REGEX } from '@/app/lib/board-constants';
import { SUPPORTED_BOARDS, ANGLES } from '@/app/lib/board-data';
import { getDefaultSizeForLayout } from '@/app/lib/__generated__/product-sizes-data';
import { constructClimbListWithSlugs, constructBoardSlugListUrl } from '@/app/lib/url-utils';
import { loadSavedBoards, saveBoardConfig, StoredBoardConfig } from '@/app/lib/saved-boards-db';
import { setLastUsedBoard } from '@/app/lib/last-used-board-db';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import type { UserBoard } from '@boardsesh/shared-schema';
import NearbyBoardsSection from './nearby-boards-section';

const BoardMapView = lazy(() => import('./board-map-view'));
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
  selectedBoard, selectedLayout, selectedSize, selectedSets, selectedAngle,
  layouts, sizes, sets,
  onBoardChange, onLayoutChange, onSizeChange, onSetsChange, onAngleChange,
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
          onChange={(e: SelectChangeEvent<number | string>) => onLayoutChange(Number(e.target.value))}
          disabled={!selectedBoard}
        >
          {layouts.map(({ id, name }) => (
            <MenuItem key={id} value={id}>{name}</MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      {selectedBoard !== 'moonboard' && (
        <FormControl fullWidth size="small">
          <InputLabel>Size</InputLabel>
          <MuiSelect
            value={selectedSize ?? ''}
            label="Size"
            onChange={(e: SelectChangeEvent<number | string>) => onSizeChange(Number(e.target.value))}
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
          onChange={(e) => onSetsChange((e.target.value as number[]).map(Number))}
          disabled={!selectedSize}
        >
          {sets.map(({ id, name }) => (
            <MenuItem key={id} value={id}>{name}</MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      <FormControl fullWidth size="small">
        <InputLabel>Angle</InputLabel>
        <MuiSelect
          value={selectedAngle}
          label="Angle"
          onChange={(e: SelectChangeEvent<number>) => onAngleChange(Number(e.target.value))}
          disabled={!selectedBoard}
        >
          {selectedBoard &&
            ANGLES[selectedBoard].map((angle) => (
              <MenuItem key={angle} value={angle}>{angle}</MenuItem>
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
  /** Hide the "Found Nearby" GPS-based section */
  hideNearby?: boolean;
  /** Show a "Create board" button alongside "Quick session" in the new board form */
  showCreateBoard?: boolean;
  /** Skip the boards list and show the config form directly */
  startWithForm?: boolean;
}

export default function BoardSelectorDrawer({
  open,
  onClose,
  onTransitionEnd,
  boardConfigs,
  placement = 'bottom',
  onBoardSelected,
  hideNearby,
  showCreateBoard,
  startWithForm,
}: BoardSelectorDrawerProps) {
  const router = useRouter();
  const [savedConfigurations, setSavedConfigurations] = useState<StoredBoardConfig[]>([]);
  const [showNewBoardForm, setShowNewBoardForm] = useState(false);
  const [showCreateBoardForm, setShowCreateBoardForm] = useState(false);
  const [newBoardTab, setNewBoardTab] = useState(0);
  const { boards: serverBoards, isLoading: isLoadingServerBoards } = useMyBoards(open);

  // New board form state
  const [selectedBoard, setSelectedBoard] = useState<BoardName | undefined>(undefined);
  const [selectedLayout, setSelectedLayout] = useState<number>();
  const [selectedSize, setSelectedSize] = useState<number>();
  const [selectedSets, setSelectedSets] = useState<number[]>([]);
  const [selectedAngle, setSelectedAngle] = useState<number>(40);
  const [configName, setConfigName] = useState('');

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

  // Load saved boards on open
  useEffect(() => {
    if (open) {
      loadSavedBoards().then((configs) => {
        setSavedConfigurations(configs);
      });
      // Auto-select first board when starting with config form
      if (startWithForm && !selectedBoard && SUPPORTED_BOARDS.length > 0) {
        setSelectedBoard(SUPPORTED_BOARDS[0] as BoardName);
      }
    }
  // selectedBoard intentionally excluded: we only auto-select on open, not on every board change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startWithForm]);

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
      return constructClimbListWithSlugs(selectedBoard, layout.name, size.name, size.description, selectedSetNames, selectedAngle);
    }
    return null;
  }, [selectedBoard, selectedLayout, selectedSize, selectedSets, selectedAngle, layouts, sizes, sets]);

  const suggestedName = useMemo(() => {
    if (!selectedBoard || !selectedLayout || !selectedSize) return '';
    const layout = layouts.find((l) => l.id === selectedLayout);
    const size = sizes.find((s) => s.id === selectedSize);
    return `${layout?.name || ''} ${size?.name || ''}`.trim();
  }, [selectedBoard, selectedLayout, selectedSize, layouts, sizes]);

  const handleSelectBoard = useCallback(
    async (url: string, boardName: string, layoutName: string, sizeName: string, sizeDescription: string | undefined, setNames: string[], angle: number, config?: StoredBoardConfig) => {
      await setLastUsedBoard({
        url,
        boardName,
        layoutName,
        sizeName,
        sizeDescription,
        setNames,
        angle,
      });
      if (onBoardSelected) {
        onBoardSelected(url, config);
        onClose();
      } else {
        router.push(url);
        onClose();
      }
    },
    [router, onClose, onBoardSelected],
  );

  const handleServerBoardSelect = useCallback(
    (board: (typeof serverBoards)[number]) => {
      const url = constructBoardSlugListUrl(board.slug, board.angle);
      const config: StoredBoardConfig = {
        name: board.name,
        board: board.boardType as BoardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds.split(',').map(Number),
        angle: board.angle,
        createdAt: board.createdAt,
      };
      if (onBoardSelected) {
        onBoardSelected(url, config);
        onClose();
      } else {
        router.push(url);
        onClose();
      }
    },
    [router, onClose, onBoardSelected],
  );

  const handleSavedConfigSelect = useCallback(
    (config: StoredBoardConfig) => {
      const angle = config.angle || 40;
      const layouts = boardConfigs.layouts[config.board] || [];
      const sizes = boardConfigs.sizes[`${config.board}-${config.layoutId}`] || [];
      const configSets = boardConfigs.sets[`${config.board}-${config.layoutId}-${config.sizeId}`] || [];
      const layout = layouts.find((l) => l.id === config.layoutId);
      const size = sizes.find((s) => s.id === config.sizeId);
      const setNames = configSets.filter((s) => config.setIds.includes(s.id)).map((s) => s.name);

      // Check if this saved config matches a server board with a slug
      const configSetIdsSorted = [...config.setIds].sort().join(',');
      const matchingServerBoard = serverBoards.find(
        (b) =>
          b.boardType === config.board &&
          b.layoutId === config.layoutId &&
          b.sizeId === config.sizeId &&
          b.setIds.split(',').map(Number).sort().join(',') === configSetIdsSorted,
      );

      if (matchingServerBoard) {
        const url = constructBoardSlugListUrl(matchingServerBoard.slug, angle);
        handleSelectBoard(url, config.board, layout?.name ?? '', size?.name ?? '', size?.description, setNames, angle, config);
        return;
      }

      if (layout && size && setNames.length > 0) {
        const url = constructClimbListWithSlugs(config.board, layout.name, size.name, size.description, setNames, angle);
        handleSelectBoard(url, config.board, layout.name, size.name, size.description, setNames, angle, config);
      }
    },
    [boardConfigs, handleSelectBoard, serverBoards],
  );

  const handleOpenNewBoardForm = useCallback(() => {
    if (!selectedBoard && SUPPORTED_BOARDS.length > 0) {
      setSelectedBoard(SUPPORTED_BOARDS[0] as BoardName);
    }
    setShowNewBoardForm(true);
  }, [selectedBoard]);

  const handleStartClimbing = async () => {
    if (!selectedBoard || !selectedLayout || !selectedSize || selectedSets.length === 0 || !targetUrl) {
      return;
    }

    let name = configName.trim();
    if (!name) {
      name = suggestedName || `${selectedBoard} board`;
    }

    const layout = layouts.find((l) => l.id === selectedLayout);
    const size = sizes.find((s) => s.id === selectedSize);
    const selectedSetNames = sets.filter((s) => selectedSets.includes(s.id)).map((s) => s.name);

    const config: StoredBoardConfig = {
      name,
      board: selectedBoard,
      layoutId: selectedLayout,
      sizeId: selectedSize,
      setIds: selectedSets,
      angle: selectedAngle,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };

    await saveBoardConfig(config);
    setShowNewBoardForm(false);
    await handleSelectBoard(
      targetUrl,
      selectedBoard,
      layout?.name || '',
      size?.name || '',
      size?.description,
      selectedSetNames,
      selectedAngle,
      config,
    );
  };

  const isFormComplete = selectedBoard && selectedLayout && selectedSize && selectedSets.length > 0;
  const hasServerBoards = serverBoards.length > 0;
  const hasSavedConfigs = savedConfigurations.length > 0;
  const isEmpty = !isLoadingServerBoards && !hasServerBoards && !hasSavedConfigs;

  return (
    <>
      <SwipeableDrawer
        title={startWithForm ? 'Custom Board' : 'Select Board'}
        placement={placement}
        open={open}
        onClose={onClose}
        onTransitionEnd={onTransitionEnd}
        height="85dvh"
      >
        {startWithForm ? (
          /* Direct config form - skip boards list */
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
              {showCreateBoard && (
                <Button
                  variant="outlined"
                  size="large"
                  fullWidth
                  onClick={() => setShowCreateBoardForm(true)}
                  disabled={!isFormComplete}
                >
                  Create board
                </Button>
              )}
              <Button
                variant="contained"
                size="large"
                fullWidth
                onClick={handleStartClimbing}
                disabled={!isFormComplete}
              >
                Quick session
              </Button>
            </Box>
          </Box>
        ) : (
          <>
            {/* My Boards (server-side) */}
            {(hasServerBoards || isLoadingServerBoards) && (
              <BoardScrollSection title="My Boards" loading={isLoadingServerBoards}>
                <CreateBoardCard onClick={handleOpenNewBoardForm} />
                {serverBoards.map((board) => (
                  <BoardScrollCard
                    key={board.uuid}
                    userBoard={board}
                    onClick={() => handleServerBoardSelect(board)}
                  />
                ))}
              </BoardScrollSection>
            )}

            {/* Recently Used (local configs) */}
            {hasSavedConfigs && (
              <BoardScrollSection title="Recently Used">
                {!hasServerBoards && (
                  <CreateBoardCard onClick={handleOpenNewBoardForm} />
                )}
                {savedConfigurations.map((config) => (
                  <BoardScrollCard
                    key={config.name}
                    storedConfig={config}
                    boardConfigs={boardConfigs}
                    onClick={() => handleSavedConfigSelect(config)}
                  />
                ))}
              </BoardScrollSection>
            )}

            {/* Found Nearby (GPS-based) */}
            {!hideNearby && (
              <NearbyBoardsSection
                open={open}
                onBoardSelect={handleServerBoardSelect}
              />
            )}

            {/* Empty state */}
            {isEmpty && (
              <Box sx={{ textAlign: 'center', py: 4, px: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  No saved boards yet. Create a new board to get started.
                </Typography>
                <Button variant="contained" onClick={handleOpenNewBoardForm}>
                  Create New Board
                </Button>
              </Box>
            )}
          </>
        )}
      </SwipeableDrawer>

      {/* Nested New Board form drawer */}
      <SwipeableDrawer
        title="New Board"
        placement={placement}
        open={showNewBoardForm}
        onClose={() => setShowNewBoardForm(false)}
        height="85dvh"
      >
        <Tabs
          value={newBoardTab}
          onChange={(_, v: number) => setNewBoardTab(v)}
          sx={{ mb: 1, minHeight: 36 }}
        >
          <Tab label="Configure" sx={{ minHeight: 36, py: 0 }} />
          <Tab label="Map" sx={{ minHeight: 36, py: 0 }} />
        </Tabs>

        {newBoardTab === 0 && (
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

            <TextField
              value={configName}
              onChange={(e) => setConfigName(e.target.value)}
              placeholder={suggestedName || 'Board name (optional)'}
              variant="outlined"
              size="small"
              fullWidth
              inputProps={{ maxLength: 50 }}
            />

            {showCreateBoard ? (
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  variant="contained"
                  size="large"
                  fullWidth
                  onClick={handleStartClimbing}
                  disabled={!isFormComplete}
                >
                  Quick session
                </Button>
                <Button
                  variant="outlined"
                  size="large"
                  fullWidth
                  onClick={() => setShowCreateBoardForm(true)}
                  disabled={!isFormComplete}
                >
                  Create board
                </Button>
              </Box>
            ) : (
              <Button
                variant="contained"
                size="large"
                fullWidth
                onClick={handleStartClimbing}
                disabled={!isFormComplete}
              >
                Save & Select
              </Button>
            )}
          </Box>
        )}

        {newBoardTab === 1 && (
          <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={32} /></Box>}>
            <BoardMapView onBoardSelect={handleServerBoardSelect} />
          </Suspense>
        )}
      </SwipeableDrawer>

      {/* Create Board form drawer */}
      {showCreateBoard && selectedBoard && selectedLayout && selectedSize && (
        <SwipeableDrawer
          title="Create Board"
          placement={placement}
          open={showCreateBoardForm}
          onClose={() => setShowCreateBoardForm(false)}
          height="85dvh"
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <CollapsibleSection
              sections={[{
                key: 'config',
                label: 'Board config',
                title: 'Board config',
                defaultSummary: 'Select a board',
                getSummary: () => {
                  const parts: string[] = [];
                  if (selectedBoard) parts.push(selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1));
                  const layout = layouts.find((l) => l.id === selectedLayout);
                  if (layout) {
                    // Strip board name prefix (e.g. "Kilter Board Original" → "Original")
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
              } satisfies CollapsibleSectionConfig]}
            />
            <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={32} /></Box>}>
              <CreateBoardForm
                boardType={selectedBoard}
                layoutId={selectedLayout}
                sizeId={selectedSize}
                setIds={selectedSets.join(',')}
                defaultAngle={selectedAngle}
                onSuccess={(board: UserBoard) => {
                  setShowCreateBoardForm(false);
                  setShowNewBoardForm(false);
                  const url = constructBoardSlugListUrl(board.slug, board.angle);
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
