import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PanGesture } from 'react-native-gesture-handler';
import type { SharedValue } from 'react-native-reanimated';
import { useQueueSessionId, useQueueLiveStats } from '../../providers/queue-provider';
import { SessionScreenHeader } from './SessionScreenHeader';
import { PreSessionView } from './pre-session/PreSessionView';
import { InSessionView } from './in-session/InSessionView';
import { InviteSheet } from './InviteSheet';

type SessionScreenProps = {
  /** Minimize handler. Absent in tab mode (switching tabs is the minimize). */
  onClose?: () => void;
  /** Swipe-down-to-dismiss gesture, attached to the header by the host. Absent in tab mode. */
  headerGesture?: PanGesture;
  /** Host overlay offset (0 = presented) — the in-session body's pull-to-dismiss drives it. Absent in tab mode. */
  translateY?: SharedValue<number>;
  /** Screen height for the dismiss-distance threshold. Absent in tab mode. */
  screenHeight?: number;
};

/**
 * Top-level body of the session screen. Picks between the pre-session
 * configuration form and the in-session live view based on whether the
 * QueueContext currently holds an active sessionId.
 *
 * In tab mode (no `onClose`) the floating glass chrome lives inside Pre/In
 * SessionView — the large title, board pill, and the live share/invite control
 * dock there, matching the Discover/Climbs tabs. The flat header strip is
 * dropped. When presented as an overlay (`onClose` provided) the original
 * `SessionScreenHeader` strip is kept as the drag handle + minimize chevron, and
 * the share button rides in that strip instead of the chrome.
 */
export function SessionScreen({ onClose, headerGesture, translateY, screenHeight }: SessionScreenProps) {
  const { sessionId } = useQueueSessionId();
  const { sessionUsers } = useQueueLiveStats();
  const insets = useSafeAreaInsets();
  const [showInvite, setShowInvite] = useState(false);

  const sessionActive = sessionId !== null;
  // Teach the share affordance while solo; once a friend joins, the label drops
  // and the share glyph stands on its own.
  const soloInvite = sessionActive && sessionUsers.length <= 1;
  const handleShare = useCallback(() => setShowInvite(true), []);
  const onShare = sessionActive ? handleShare : undefined;

  // The End-session confirmation sheet lives in InSessionView, but its trigger
  // comes from either the tab chrome (RecordTopChrome's End trailing action) or the
  // overlay header strip — so the open/close intent is owned here and the sheet is
  // driven as a controlled prop below.
  const [showEndSession, setShowEndSession] = useState(false);
  const requestEndSession = useCallback(() => setShowEndSession(true), []);
  const dismissEndSession = useCallback(() => setShowEndSession(false), []);
  const onEndSession = sessionActive ? requestEndSession : undefined;

  // If the session ends out from under us (e.g. another participant ends it) while
  // the confirm sheet is open, clear the intent — InSessionView (which renders the
  // sheet) unmounts, so a stale `true` would otherwise auto-open the sheet on the
  // next session.
  useEffect(() => {
    if (!sessionActive) setShowEndSession(false);
  }, [sessionActive]);

  // Overlay mode keeps the original padded container + drag-handle header strip.
  const isOverlay = onClose !== undefined;

  if (isOverlay) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <SessionScreenHeader
          onClose={onClose}
          sessionActive={sessionActive}
          onShare={onShare}
          onEndSession={onEndSession}
          inviteHint={soloInvite}
          dragGesture={headerGesture}
        />
        <View style={styles.body}>
          {sessionActive ? (
            <InSessionView
              showChrome={false}
              endVisible={showEndSession}
              onEndDismiss={dismissEndSession}
              translateY={translateY}
              screenHeight={screenHeight}
            />
          ) : (
            <PreSessionView showChrome={false} />
          )}
        </View>
        {sessionId ? (
          <InviteSheet visible={showInvite} onDismiss={() => setShowInvite(false)} sessionId={sessionId} />
        ) : null}
      </View>
    );
  }

  // Tab mode: the chrome (large title + board pill + share) floats inside the
  // view over its own FlashList, which insets its top padding by the measured
  // chrome height. No padded container, no header strip.
  return (
    <View style={styles.container}>
      {sessionActive ? (
        <InSessionView
          showChrome
          onShare={onShare}
          onRequestEndSession={requestEndSession}
          endVisible={showEndSession}
          onEndDismiss={dismissEndSession}
        />
      ) : (
        <PreSessionView showChrome />
      )}
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
