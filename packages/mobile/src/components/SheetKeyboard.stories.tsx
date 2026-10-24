import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StoryModule } from '../dev/stories/types';
import { publishSheetKeyboardCalibration } from '../lib/sheet-keyboard-calibration-store';
import { LogAscentSheet } from './LogAscentSheet';
import { SessionTitleSheet } from './session-screen/SessionTitleSheet';
import { CommentSheet } from './you/CommentSheet';

function useKeyboardCalibration() {
  const insets = useSafeAreaInsets();
  const { calibration } = useLocalSearchParams<{ calibration?: string }>();
  useEffect(() => {
    publishSheetKeyboardCalibration({ enabled: calibration !== '0', windowTopInset: insets.top });
    return () => publishSheetKeyboardCalibration({ enabled: false, windowTopInset: insets.top });
  }, [calibration, insets.top]);
}

function TickKeyboardStory() {
  const [visible, setVisible] = useState(true);
  useKeyboardCalibration();
  return (
    <View>
      <LogAscentSheet
        visible={visible}
        onClose={() => setVisible(false)}
        climbUuid="keyboard-story"
        climbName="Keyboard clearance"
        boardName="kilter"
        angle={40}
        isMirror={false}
        isBenchmark={false}
        baseAscensionistCount={0}
      />
    </View>
  );
}

function TitleKeyboardStory() {
  const [visible, setVisible] = useState(true);
  useKeyboardCalibration();
  return (
    <SessionTitleSheet
      visible={visible}
      sessionId={null}
      currentName="Evening session"
      onClose={() => setVisible(false)}
    />
  );
}

function CommentKeyboardStory() {
  const sheetRef = useRef<BottomSheet>(null);
  useKeyboardCalibration();
  useEffect(() => {
    sheetRef.current?.snapToIndex(0);
  }, []);
  // No entity: the real composer renders without fetching or posting comments.
  return <CommentSheet sheetRef={sheetRef} entityId={null} onClose={() => {}} />;
}

const stories: StoryModule = {
  title: 'Sheet keyboard',
  stories: {
    tick: { name: 'Tick note and pinned actions', layout: 'fullscreen', render: () => <TickKeyboardStory /> },
    title: { name: 'Short session-title form', layout: 'fullscreen', render: () => <TitleKeyboardStory /> },
    comment: { name: 'Pinned comment composer', layout: 'fullscreen', render: () => <CommentKeyboardStory /> },
  },
};

export default stories;
