import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PanGesture } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import { useQueue } from '../../providers/queue-provider';
import { SessionScreenHeader } from './SessionScreenHeader';
import { PreSessionView } from './pre-session/PreSessionView';
import { InSessionView } from './in-session/InSessionView';
import { InviteSheet } from './InviteSheet';

type SessionScreenProps = {
  onClose: () => void;
  /** Swipe-down-to-dismiss gesture, attached to the header by the host. */
  headerGesture: PanGesture;
  /** Host overlay offset (0 = presented) — the in-session body's pull-to-dismiss drives it. */
  translateY: SharedValue<number>;
  screenHeight: number;
};

/**
 * Top-level body of the session overlay. Picks between the pre-session
 * configuration form and the in-session live view based on whether the
 * QueueContext currently holds an active sessionId.
 */
export function SessionScreen({ onClose, headerGesture, translateY, screenHeight }: SessionScreenProps) {
  const { sessionId, sessionUsers } = useQueue();
  const insets = useSafeAreaInsets();
  const [showInvite, setShowInvite] = useState(false);

  const sessionActive = sessionId !== null;
  // Teach the share affordance while solo; once a friend joins, the label drops
  // and the share glyph stands on its own.
  const soloInvite = sessionActive && sessionUsers.length <= 1;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <SessionScreenHeader
        onClose={onClose}
        sessionActive={sessionActive}
        onShare={sessionActive ? () => setShowInvite(true) : undefined}
        inviteHint={soloInvite}
        dragGesture={headerGesture}
      />
      <View style={styles.body}>
        {sessionActive ? <InSessionView translateY={translateY} screenHeight={screenHeight} /> : <PreSessionView />}
      </View>
      {sessionId ? (
        <InviteSheet visible={showInvite} onDismiss={() => setShowInvite(false)} sessionId={sessionId} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  body: {
    flex: 1,
  },
});
