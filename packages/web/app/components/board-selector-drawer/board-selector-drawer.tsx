'use client';

import React, { useState, useEffect, useMemo, useCallback, useId, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { FormActions } from '@/app/components/form';
import type { BoardFormSubmitState } from '../board-entity/board-form';
import CollapsibleSection, {
  type CollapsibleSectionConfig,
} from '@/app/components/collapsible-section/collapsible-section';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { BoardName, BoardRouteIdentity } from '@/app/lib/types';
import { BOARD_NAME_PREFIX_REGEX, getDefaultSizeForLayout } from '@/app/lib/board-constants';
import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import { constructClimbListWithSlugs, constructBoardSlugListUrl, tryConstructSlugListUrl } from '@/app/lib/url-utils';
import { type StoredBoardConfig, saveBoardConfig } from '@/app/lib/saved-boards-db';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoardSwitchGuard } from '@/app/components/board-lock/use-board-switch-guard';

import BoardConfigSelects from './board-config-selects';

const CreateBoardForm = lazy(() => import('../board-entity/create-board-form'));

type BoardSelectorDrawerProps = {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  boardConfigs: BoardConfigData;
  placement?: 'top' | 'bottom';
  onBoardSelected?: (url: string, config?: StoredBoardConfig) => void;
};

export default function BoardSelectorDrawer({
  open,
  onClose,
  onTransitionEnd,
  boardConfigs,
  placement = 'bottom',
  onBoardSelected,
}: BoardSelectorDrawerProps) {
  const { t } = useTranslation('boards');
  const router = useLocaleRouter();
  const guardBoardSwitch = useBoardSwitchGuard();
  const [showCreateBoardForm, setShowCreateBoardForm] = useState(false);
  // The create form's Save action lives in the create drawer's header (bottom-
  // drawer ruling — the iOS keyboard buries a footer). The form reports its
  // label / saving / enabled state here and the header button submits by id.
  const createFormId = useId();
  const [createSubmitState, setCreateSubmitState] = useState<BoardFormSubmitState>({
    submitLabel: t('boardForm.create.submit'),
    submitting: false,
    canSubmit: false,
  });

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
      setSelectedBoard(SUPPORTED_BOARDS[0]);
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
      // Id-aware first: the picker holds the numeric ids, and slugging from
      // names collapses a shadowed size (Kilter 12x12 without kickboard) onto
      // the bare slug's first match — making that size unselectable from the
      // very surface that lists it.
      return (
        tryConstructSlugListUrl(selectedBoard, selectedLayout, selectedSize, selectedSets, selectedAngle) ??
        constructClimbListWithSlugs(
          selectedBoard,
          layout.name,
          size.name,
          size.description,
          selectedSetNames,
          selectedAngle,
        )
      );
    }
    return null;
  }, [selectedBoard, selectedLayout, selectedSize, selectedSets, selectedAngle, layouts, sizes, sets]);

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
        title={t('selectorDrawer.customTitle')}
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
              {t('selectorDrawer.createButton')}
            </Button>
            <Button variant="contained" size="large" fullWidth onClick={handleStartClimbing} disabled={!isFormComplete}>
              {t('selectorDrawer.quickSession')}
            </Button>
          </Box>
        </Box>
      </SwipeableDrawer>

      {/* Create Board form drawer */}
      {selectedBoard && selectedLayout && selectedSize && (
        <SwipeableDrawer
          title={t('selectorDrawer.createTitle')}
          placement={placement}
          {...topDrawerDismissProps}
          open={showCreateBoardForm}
          onClose={() => setShowCreateBoardForm(false)}
          height="85dvh"
          extra={
            <FormActions
              formId={createFormId}
              submitLabel={createSubmitState.submitLabel}
              submitting={createSubmitState.submitting}
              disabled={!createSubmitState.canSubmit}
              onCancel={() => setShowCreateBoardForm(false)}
              layout="row"
            />
          }
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <CollapsibleSection
              sections={[
                {
                  key: 'config',
                  label: t('selectorDrawer.configSection.label'),
                  title: t('selectorDrawer.configSection.title'),
                  defaultSummary: t('selectorDrawer.configSection.defaultSummary'),
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
                formId={createFormId}
                onSubmitStateChange={setCreateSubmitState}
                onSuccess={(board: UserBoard) => {
                  setShowCreateBoardForm(false);
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
