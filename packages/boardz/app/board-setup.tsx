import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import type { BoardName } from '@boardsesh/shared-schema';
import {
  formatBoardDisplayName,
  getBoardCapabilities,
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
} from '@boardsesh/board-config';
import {
  SETUP_BOARD_NAMES,
  angleOptions,
  createBoard,
  defaultAngle,
  describeBoard,
  type ActiveBoard,
} from '../src/board/active-board';
import { useBoard } from '../src/board/board-provider';
import { useAccountBoards } from '../src/board/use-account-boards';
import { useAuth } from '../src/auth/auth-provider';
import { Button } from '../src/ui/Button';
import { Card } from '../src/ui/Card';
import { IconButton } from '../src/ui/IconButton';
import { ChevronLeft } from '../src/ui/icons';
import { ListRow } from '../src/ui/ListRow';
import { SegmentedControl } from '../src/ui/SegmentedControl';
import { Text } from '../src/ui/Text';
import { Sheet } from '../src/ui/Sheet';
import { spacing } from '../src/ui/tokens';

type Step =
  | { kind: 'start' }
  | { kind: 'layout'; boardName: BoardName }
  | { kind: 'size'; boardName: BoardName; layoutId: number }
  | { kind: 'sets'; boardName: BoardName; layoutId: number; sizeId: number }
  | { kind: 'angle'; boardName: BoardName; layoutId: number; sizeId: number; setIds: number[] };

// Angles go in strips of five; Aurora boards have fifteen.
const ANGLES_PER_STRIP = 5;

function stepTitle(step: Step): string {
  switch (step.kind) {
    case 'start':
      return 'Your board';
    case 'layout':
      return step.boardName === 'moonboard' ? 'MoonBoard version' : `${formatBoardDisplayName(step.boardName)} layout`;
    case 'size':
      return 'Board size';
    case 'sets':
      return 'Hold sets';
    case 'angle':
      return 'Wall angle';
  }
}

export default function BoardSetupScreen() {
  const { board: currentBoard, setBoard } = useBoard();
  const { status } = useAuth();
  const accountBoards = useAccountBoards();
  const [steps, setSteps] = useState<Step[]>([{ kind: 'start' }]);
  const [selectedSetIds, setSelectedSetIds] = useState<number[]>([]);
  const [angle, setAngle] = useState(40);

  const step = steps[steps.length - 1];
  const push = (next: Step) => setSteps([...steps, next]);
  const back = () => setSteps(steps.slice(0, -1));

  const choose = (board: ActiveBoard) => {
    setBoard(board);
    router.back();
  };

  // Steps with a single choice make it themselves: most brands have one layout,
  // and some one size or one hold set.
  const goToAngle = (boardName: BoardName, layoutId: number, sizeId: number, setIds: number[]) => {
    setAngle(currentBoard?.boardName === boardName ? currentBoard.angle : defaultAngle(boardName));
    push({ kind: 'angle', boardName, layoutId, sizeId, setIds });
  };

  const goToSets = (boardName: BoardName, layoutId: number, sizeId: number) => {
    const sets = getBoardSetsForLayoutAndSize(boardName, layoutId, sizeId);
    if (sets.length === 1) {
      goToAngle(boardName, layoutId, sizeId, [sets[0].id]);
      return;
    }
    // Every set installed is the common case; the climber unticks what's missing.
    setSelectedSetIds(sets.map((set) => set.id));
    push({ kind: 'sets', boardName, layoutId, sizeId });
  };

  const chooseLayout = (boardName: BoardName, layoutId: number) => {
    const sizes = getBoardSizesForLayoutId(boardName, layoutId);
    if (sizes.length === 1) goToSets(boardName, layoutId, sizes[0].id);
    else push({ kind: 'size', boardName, layoutId });
  };

  const chooseBoard = (boardName: BoardName) => {
    const layouts = getBoardLayouts(boardName);
    if (layouts.length === 1) chooseLayout(boardName, layouts[0].id);
    else push({ kind: 'layout', boardName });
  };

  return (
    <Sheet
      title={stepTitle(step)}
      left={steps.length > 1 ? <IconButton icon={ChevronLeft} label="Back" onPress={back} /> : undefined}
    >
      {step.kind === 'start' ? (
        <>
          {status === 'signedIn' ? (
            <View style={styles.group}>
              <Text variant="label">From your Boardsesh account</Text>
              {accountBoards.isPending ? (
                <ActivityIndicator style={styles.loading} />
              ) : accountBoards.data && accountBoards.data.length > 0 ? (
                <Card flush>
                  {accountBoards.data.map((board, index, boards) => (
                    <ListRow
                      key={board.boardUuid ?? `${board.boardName}-${board.layoutId}-${board.sizeId}`}
                      title={board.name}
                      meta={`${describeBoard(board)} · ${board.angle}°`}
                      accessory={currentBoard?.boardUuid === board.boardUuid ? 'check' : 'chevron'}
                      separator={index < boards.length - 1}
                      onPress={() => choose(board)}
                    />
                  ))}
                </Card>
              ) : (
                <Text variant="small" tone="tertiary">
                  {accountBoards.isError
                    ? 'Could not load your boards. You can still set one up below.'
                    : 'No boards saved on your account yet. Set one up below.'}
                </Text>
              )}
            </View>
          ) : null}
          <View style={styles.group}>
            <Text variant="label">Set up a board</Text>
            <Card flush>
              {SETUP_BOARD_NAMES.map((boardName, index) => (
                <ListRow
                  key={boardName}
                  title={boardName === 'moonboard' ? 'MoonBoard' : `${formatBoardDisplayName(boardName)} Board`}
                  accessory="chevron"
                  separator={index < SETUP_BOARD_NAMES.length - 1}
                  onPress={() => chooseBoard(boardName)}
                />
              ))}
            </Card>
          </View>
        </>
      ) : null}

      {step.kind === 'layout' ? (
        <>
          <Text variant="small" tone="tertiary">
            {step.boardName === 'moonboard'
              ? 'Which MoonBoard is on your wall? The version decides which problems you see.'
              : 'Which layout is on your wall?'}
          </Text>
          <Card flush>
            {getBoardLayouts(step.boardName).map((layout, index, layouts) => (
              <ListRow
                key={layout.id}
                title={layout.name}
                accessory="chevron"
                separator={index < layouts.length - 1}
                onPress={() => chooseLayout(step.boardName, layout.id)}
              />
            ))}
          </Card>
        </>
      ) : null}

      {step.kind === 'size' ? (
        <>
          <Text variant="small" tone="tertiary">
            How big is your board?
          </Text>
          <Card flush>
            {getBoardSizesForLayoutId(step.boardName, step.layoutId).map((size, index, sizes) => (
              <ListRow
                key={size.id}
                title={size.name}
                subtitle={size.description || null}
                accessory="chevron"
                separator={index < sizes.length - 1}
                onPress={() => goToSets(step.boardName, step.layoutId, size.id)}
              />
            ))}
          </Card>
        </>
      ) : null}

      {step.kind === 'sets' ? (
        <>
          <Text variant="small" tone="tertiary">
            Which hold sets are on your wall? Climbs that need holds you don&apos;t have are hidden.
          </Text>
          <Card flush>
            {getBoardSetsForLayoutAndSize(step.boardName, step.layoutId, step.sizeId).map((set, index, sets) => {
              const selected = selectedSetIds.includes(set.id);
              return (
                <ListRow
                  key={set.id}
                  title={set.name}
                  accessory={selected ? 'check' : 'none'}
                  separator={index < sets.length - 1}
                  onPress={() =>
                    setSelectedSetIds(
                      selected ? selectedSetIds.filter((setId) => setId !== set.id) : [...selectedSetIds, set.id],
                    )
                  }
                />
              );
            })}
          </Card>
          <Button
            title="Continue"
            size="lg"
            fullWidth
            disabled={selectedSetIds.length === 0}
            onPress={() => goToAngle(step.boardName, step.layoutId, step.sizeId, selectedSetIds)}
          />
        </>
      ) : null}

      {step.kind === 'angle' ? (
        <>
          <Text variant="small" tone="tertiary">
            {step.boardName === 'moonboard'
              ? 'MoonBoard problems are graded at 25° and 40°. You can switch any time from Home.'
              : getBoardCapabilities(step.boardName).angleBoundClimbs
                ? 'Each problem on this board is set at one angle, so every angle has its own problems. You can switch any time from Home.'
                : 'The angle your board is set to. You can change it any time from Home.'}
          </Text>
          <View style={styles.group}>
            {Array.from({ length: Math.ceil(angleOptions(step.boardName).length / ANGLES_PER_STRIP) }, (_, strip) =>
              angleOptions(step.boardName).slice(strip * ANGLES_PER_STRIP, (strip + 1) * ANGLES_PER_STRIP),
            ).map((options) => (
              <SegmentedControl
                key={options.join()}
                fullWidth
                size="lg"
                value={angle}
                onChange={setAngle}
                options={options.map((option) => ({
                  value: option,
                  label: `${option}°`,
                  accessibilityLabel: `${option} degrees`,
                }))}
              />
            ))}
          </View>
          <Button
            title="Save board"
            size="lg"
            fullWidth
            onPress={() =>
              choose(
                createBoard({
                  boardName: step.boardName,
                  layoutId: step.layoutId,
                  sizeId: step.sizeId,
                  setIds: step.setIds,
                  angle,
                }),
              )
            }
          />
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  group: { gap: spacing.sm },
  loading: { paddingVertical: spacing.lg },
});
