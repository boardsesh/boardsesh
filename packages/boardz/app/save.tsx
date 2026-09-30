import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useBoard } from '../src/board/board-provider';
import { useClimbSequence } from '../src/climbs/climb-sequence';
import { LIST_ICONS } from '../src/lists/ListCard';
import { useLists } from '../src/lists/lists-provider';
import { Button } from '../src/ui/Button';
import { Card } from '../src/ui/Card';
import { Plus } from '../src/ui/icons';
import { ListRow } from '../src/ui/ListRow';
import { Sheet } from '../src/ui/Sheet';
import { Text } from '../src/ui/Text';
import { TextField } from '../src/ui/TextField';
import { spacing } from '../src/ui/tokens';

/** Tick the lists a climb belongs on, or start a new one. Changes apply straight away. */
export default function SaveSheet() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  const { climbs } = useClimbSequence();
  const { board } = useBoard();
  const { lists, listIdsFor, toggle, create } = useLists();
  const [name, setName] = useState('');
  const climb = climbs.find((candidate) => candidate.uuid === uuid);

  if (!climb || !board) {
    return (
      <Sheet title="Save to a list">
        <Text tone="tertiary">This climb isn&apos;t here any more.</Text>
      </Sheet>
    );
  }

  const onLists = listIdsFor(board.boardName, climb.uuid);
  const flip = (listId: string) => {
    void Haptics.selectionAsync();
    toggle(listId, climb, board);
  };
  const addList = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    flip(create(trimmed));
    setName('');
  };

  return (
    <Sheet title="Save to a list" avoidKeyboard>
      <Text variant="small" tone="tertiary" numberOfLines={1}>
        {climb.name}
      </Text>
      <Card flush>
        {lists.map((list, index) => (
          <ListRow
            key={list.id}
            title={list.name}
            icon={LIST_ICONS[list.kind]}
            meta={`${list.climbs.length} ${list.climbs.length === 1 ? 'climb' : 'climbs'}`}
            accessory={onLists.has(list.id) ? 'check' : 'none'}
            onPress={() => flip(list.id)}
            separator={index < lists.length - 1}
          />
        ))}
      </Card>
      <View style={styles.newList}>
        <View style={styles.flex}>
          <TextField
            placeholder="New list"
            value={name}
            onChangeText={setName}
            returnKeyType="done"
            onSubmitEditing={addList}
          />
        </View>
        <Button title="Add" variant="secondary" icon={Plus} disabled={name.trim().length === 0} onPress={addList} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  newList: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
