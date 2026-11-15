import { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { liveActivityNative, type LiveActivityQueueItem } from '../../../modules/live-activity/src';
import { STORY_BOARDS } from '../fixtures/boards';
import { parseSetIds } from '../../lib/board-presence/parse-set-ids';

/** Initializes actual ActivityKit UI for native-system captures, outside the application providers. */
export default function NativeActivitySetup() {
  const {
    board: boardId,
    server,
    shot,
    end,
  } = useLocalSearchParams<{ board?: string; server?: string; shot?: string; end?: string }>();
  const [status, setStatus] = useState('Preparing native activity');
  // Route changes must finish the old native start and teardown before starting
  // the next capture; a late endSession would otherwise erase its activity.
  const lifecycleRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      if (cancelled) return;
      if (Platform.OS !== 'ios' || !liveActivityNative || !(await liveActivityNative.isAvailable()).available) {
        throw new Error('ActivityKit is unavailable in this native binary');
      }
      if (cancelled) return;
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
      const { ensureBackgroundsCached } = await import('../../lib/background-image-cache');
      const backgrounds = await ensureBackgroundsCached({
        boardName: fixture.board.boardName,
        layoutId: fixture.board.layoutId,
        sizeId: fixture.board.sizeId,
        setIds: parseSetIds(fixture.board.setIds),
        variant: 'thumb',
      });
      if (cancelled) return;
      if (!backgrounds || backgrounds.paths.length === 0 || backgrounds.missingCount > 0)
        throw new Error(`Missing bundled board backgrounds for native capture ${boardId}`);
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
        boardBackgroundPaths: backgrounds.paths,
      });
      if (cancelled) return;
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
    lifecycleRef.current = lifecycleRef.current.then(prepare).catch((error: unknown) => {
      if (cancelled) return;
      console.error(`[stories] error native-live-activity ${error instanceof Error ? error.message : String(error)}`);
      setStatus('Native activity failed');
    });
    return () => {
      cancelled = true;
      lifecycleRef.current = lifecycleRef.current
        .then(() => liveActivityNative?.endSession())
        .catch((error: unknown) => {
          console.error(
            `[stories] error native-live-activity ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    };
  }, [boardId, server, shot, end]);
  return (
    <View>
      <Text>{status}</Text>
    </View>
  );
}
