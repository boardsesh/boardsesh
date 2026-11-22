import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StoryModule } from '../dev/stories/types';
import { useUnsavedSheetGuard } from '../hooks/use-unsaved-sheet-guard';
import { useTheme } from '../providers/theme-provider';
import { AccessibleBottomSheetTextInput } from './AccessibleBottomSheetTextInput';
import { AppMenu } from './AppMenu';
import { Button } from './Button';
import { ModalSheet } from './ModalSheet';
import { SheetTopBar } from './SheetTopBar';
import { Text } from './Text';

function PresentationStory() {
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState('No action selected');
  const { spacing, systemColors } = useTheme();
  const close = useCallback(() => setVisible(false), []);
  const discard = useCallback(() => setDraft(''), []);
  const guard = useUnsavedSheetGuard({ visible, dirty: draft.length > 0, onClose: close, onDiscard: discard });
  return (
    <View style={[styles.fill, { padding: spacing[4], gap: spacing[4] }]}>
      <Button title="Open form" onPress={() => setVisible(true)} />
      <Text>{selection}</Text>
      <ModalSheet
        visible={visible}
        onClose={close}
        onRequestClose={guard.requestClose}
        enablePanDownToClose={guard.enablePanDownToClose}
        scrollable
        header={<SheetTopBar title="Presentation form" leading={{ kind: 'cancel', onPress: guard.requestClose }} />}
      >
        <View style={{ padding: spacing[4], gap: spacing[4] }}>
          <AccessibleBottomSheetTextInput
            accessibilityLabel="Draft note"
            value={draft}
            onChangeText={setDraft}
            multiline
            style={{ padding: spacing[3], color: systemColors.label, backgroundColor: systemColors.fill }}
          />
          <AppMenu
            label="Preview actions"
            accessibilityLabel="Preview actions"
            actions={[{ label: 'First action', systemIcon: 'checkmark' }]}
            onSelectIndex={() => setSelection('First action selected')}
          />
          {Array.from({ length: 20 }, (_, index) => (
            <Text key={index}>Scrollable row {index + 1}</Text>
          ))}
        </View>
      </ModalSheet>
    </View>
  );
}

const stories: StoryModule = {
  title: 'Adaptive sheet presentation',
  stories: {
    form: { name: 'Form, menu and discard confirmation', layout: 'fullscreen', render: () => <PresentationStory /> },
  },
};
export default stories;
const styles = StyleSheet.create({ fill: { flex: 1 } });
