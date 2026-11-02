import { useLocalSearchParams } from 'expo-router';
import { BoardLookScreen } from '../../../src/components/settings/board-look/BoardLookScreen';
import { BOARD_LOOK_LIGHTING_SECTION } from '../../../src/components/settings/board-look/board-look-model';

export default function BoardLookRoute() {
  // `?section=lighting` (the player's preview-first card) opens on the lighting group.
  const { section } = useLocalSearchParams<{ section?: string }>();
  return <BoardLookScreen leadWithLighting={section === BOARD_LOOK_LIGHTING_SECTION} />;
}
