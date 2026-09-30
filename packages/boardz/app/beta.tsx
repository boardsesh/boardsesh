import { useLocalSearchParams } from 'expo-router';
import { BetaSection } from '../src/beta/BetaSection';
import { useBoard } from '../src/board/board-provider';
import { useClimbSequence } from '../src/climbs/climb-sequence';
import { Sheet } from '../src/ui/Sheet';
import { Text } from '../src/ui/Text';

/** The climb's beta videos, and the setter's note when there is one. */
export default function BetaSheet() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  const { climbs } = useClimbSequence();
  const { board } = useBoard();
  const climb = climbs.find((candidate) => candidate.uuid === uuid);

  if (!climb || !board) {
    return (
      <Sheet title="Beta">
        <Text tone="tertiary">This climb isn&apos;t here any more.</Text>
      </Sheet>
    );
  }

  return (
    <Sheet title="Beta">
      <Text variant="small" tone="tertiary" numberOfLines={1}>
        {climb.name}
      </Text>
      {climb.description ? <Text tone="secondary">{climb.description}</Text> : null}
      <BetaSection boardName={board.boardName} climbUuid={climb.uuid} angle={board.angle} />
    </Sheet>
  );
}
