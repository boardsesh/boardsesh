import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { liveActivityNative, type LiveActivityQueueItem } from '../../../modules/live-activity/src';
import { STORY_BOARDS } from '../fixtures/boards';

/** Initializes actual ActivityKit UI for native-system captures, outside the application providers. */
export default function NativeActivitySetup() {
  const {
    board: boardId,
    server,
    shot,
    end,
  } = useLocalSearchParams<{ board?: string; server?: string; shot?: string; end?: string }>();
  const [status, setStatus] = useState('Preparing native activity');
  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      if (Platform.OS !== 'ios' || !liveActivityNative || !(await liveActivityNative.isAvailable()).available) {
        throw new Error('ActivityKit is unavailable in this native binary');
      }
      await liveActivityNative.endSession();
      if (cancelled) return;
      if (end === '1') {
        setStatus('Native activity ended');
        console.log('[stories] native ended');
        return;
      }
      if (!server || !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(server))
        throw new Error('Native captures require the local read-only replay server');
      const fixture = STORY_BOARDS[boardId as keyof typeof STORY_BOARDS];
      if (!fixture?.climbs.length) throw new Error(`Missing native board fixture ${boardId}`);
      const queue: LiveActivityQueueItem[] = fixture.climbs.slice(0, 3).map((climb, index) => ({
        uuid: `native-story-${index}`,
        climbUuid: climb.uuid,
        climbName: climb.name,
        difficulty: climb.difficulty ?? '',
        angle: fixture.board.angle,
        frames: climb.frames,
        setterUsername: climb.setter_username ?? '',
        mirrored: false,
      }));
      const current = queue[0];
      const sessionId = `native-capture-${shot ?? 'current'}`;
      await liveActivityNative.startSession({
        ...fixture.board,
        sessionId,
        serverUrl: server,
        // The native module always creates a socket. Keep it on a closed local port;
        // this capture cannot join a live session or send a backend mutation.
        wsUrl: 'ws://127.0.0.1:1',
        widgetNavigationAllowed: false,
        isPartySession: false,
        boardConnection: 'disconnected',
        renderMode: 'classic',
      });
      if (cancelled) {
        await liveActivityNative.endSession();
        return;
      }
      await liveActivityNative.updateActivity({
        sessionId,
        queueSequence: 0,
        queueItemUuid: current.uuid,
        queue,
        climbUuid: current.climbUuid,
        climbName: current.climbName,
        climbDifficulty: current.difficulty,
        angle: current.angle,
        currentIndex: 0,
        totalClimbs: queue.length,
        hasNext: queue.length > 1,
        hasPrevious: false,
        widgetNavigationAllowed: false,
        isPartySession: false,
        boardConnection: 'disconnected',
        renderMode: 'classic',
      });
      if (!cancelled) {
        setStatus(current.climbName);
        console.log(`[stories] native started ${boardId} ${current.climbUuid}-classic.webp`);
      }
    };
    void prepare().catch((error: unknown) => {
      console.error(`[stories] error native-live-activity ${error instanceof Error ? error.message : String(error)}`);
      if (!cancelled) setStatus('Native activity failed');
    });
    return () => {
      cancelled = true;
      void liveActivityNative?.endSession();
    };
  }, [boardId, server, shot, end]);
  return (
    <View>
      <Text>{status}</Text>
    </View>
  );
}
