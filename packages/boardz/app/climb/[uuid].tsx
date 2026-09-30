import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutRectangle } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBetaLinks } from '../../src/beta/use-beta-links';
import { BoardView } from '../../src/board/BoardView';
import { HoldLegend } from '../../src/board/HoldLegend';
import { useBoard } from '../../src/board/board-provider';
import { useBluetooth, type ShowClimbResult } from '../../src/ble/bluetooth-provider';
import { useClimbSequence } from '../../src/climbs/climb-sequence';
import { gradeBand, gradeLabel } from '../../src/grades/grades';
import { FAVOURITES_ID, PROJECTS_ID } from '../../src/lists/lists';
import { useLists } from '../../src/lists/lists-provider';
import { climbStatuses } from '../../src/session/session';
import { useSession } from '../../src/session/session-provider';
import { usePreferences } from '../../src/settings/preferences-provider';
import { useClimbTicks } from '../../src/ticks/use-ticks';
import { GradeBadge } from '../../src/ui/GradeBadge';
import { Icon } from '../../src/ui/Icon';
import { IconButton } from '../../src/ui/IconButton';
import { Check, Heart, Lightbulb, ListPlus, Play } from '../../src/ui/icons';
import { Marquee } from '../../src/ui/Marquee';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';
import { TopBar } from '../../src/ui/TopBar';
import { LED, useTheme } from '../../src/ui/theme';
import { GUTTER, spacing } from '../../src/ui/tokens';

// How far a sideways swipe on the board has to travel to change climbs,
// unless it's a quick flick.
const SWIPE_DISTANCE = 60;
const FLICK_VELOCITY = 600;
// A drag has to go this far sideways to count as a swipe.
const SWIPE_START = 10;
// The hold list under the board: one line, always the same height.
const LEGEND_HEIGHT = 22;

const LIGHT_PROBLEM: Partial<Record<ShowClimbResult, string>> = {
  incompatible: "This climb's holds aren't on your board setup, so it can't be lit.",
  failed: 'Lost the board. Move closer and connect again.',
};

/**
 * One climb, filling the screen: nothing scrolls and nothing changes size
 * between climbs, so the board stays put while you swipe through the list.
 */
export default function ClimbScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  const { climbs } = useClimbSequence();
  const { board } = useBoard();
  const bluetooth = useBluetooth();
  const { session } = useSession();
  const { gradeFormat } = usePreferences();
  const { listIdsFor, toggle } = useLists();
  // -1 when the climb isn't in the list any more: show that, never a different climb.
  const [index, setIndex] = useState(() => climbs.findIndex((climb) => climb.uuid === uuid));
  const [lightResult, setLightResult] = useState<ShowClimbResult | null>(null);
  const [boardArea, setBoardArea] = useState<LayoutRectangle | null>(null);
  const climb = index >= 0 ? climbs[index] : undefined;
  const ticks = useClimbTicks(board?.boardName, climb?.uuid);
  const beta = useBetaLinks(board?.boardName, climb?.uuid, board?.angle ?? 0);
  const connected = bluetooth.status === 'connected';

  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= climbs.length) return;
    void Haptics.selectionAsync();
    setIndex(nextIndex);
  };
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .enabled(climbs.length > 1)
    .activeOffsetX([-SWIPE_START, SWIPE_START])
    .onEnd(({ translationX, velocityX }) => {
      const flick = Math.abs(velocityX) >= FLICK_VELOCITY;
      if (translationX <= -SWIPE_DISTANCE || (flick && velocityX < 0)) goTo(index + 1);
      else if (translationX >= SWIPE_DISTANCE || (flick && velocityX > 0)) goTo(index - 1);
    });

  // Light each climb as it comes on screen, and again once the board connects.
  useEffect(() => {
    if (!climb) return;
    let cancelled = false;
    setLightResult(null);
    void bluetooth.showClimb(climb.frames).then((result) => {
      if (!cancelled) setLightResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [climb?.uuid, bluetooth.status]);

  if (!climb || !board) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
        <TopBar />
        <View style={styles.center}>
          <Text variant="title3">This climb isn&apos;t here any more.</Text>
          <Text tone="tertiary">Head back and pick another.</Text>
        </View>
      </View>
    );
  }

  const lit = connected && lightResult === 'lit';
  const lightProblem = lightResult ? LIGHT_PROBLEM[lightResult] : undefined;
  // Lit: switch the board off. Connected: light it. Otherwise: connect first.
  const toggleLight = async () => {
    if (!connected) {
      router.push('/connect');
      return;
    }
    void Haptics.selectionAsync();
    if (lit) {
      const cleared = await bluetooth.showClimb('');
      setLightResult(cleared === 'lit' ? null : cleared);
      return;
    }
    const result = await bluetooth.showClimb(climb.frames);
    setLightResult(result);
    const problem = LIGHT_PROBLEM[result];
    if (problem) toast.show({ tone: 'danger', title: "Couldn't light it", message: problem });
  };

  const history = (ticks.data ?? []).filter((tick) => tick.angle === board.angle);
  const sessionStatus = climbStatuses(session?.ticks ?? []).get(climb.uuid);
  const sent =
    history.some((tick) => tick.status !== 'attempt') || (sessionStatus !== undefined && sessionStatus !== 'attempt');
  const onLists = listIdsFor(board.boardName, climb.uuid);
  const favourite = onLists.has(FAVOURITES_ID);
  const project = onLists.has(PROJECTS_ID);
  const toggleFavourite = () => {
    void Haptics.selectionAsync();
    toggle(FAVOURITES_ID, climb, board);
  };
  const position = climbs.length > 1 ? `${String(index + 1).padStart(2, '0')} / ${climbs.length}` : null;
  const meta = [climb.setter_username, position, `${board.angle}°`].filter(Boolean).join(' · ');

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp, paddingBottom: insets.bottom + spacing.sm }]}>
      <TopBar
        right={
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Board lights"
              accessibilityValue={{ text: !connected ? 'Not connected' : lit ? 'On' : 'Off' }}
              accessibilityHint={
                !connected ? 'Connects to your board' : lit ? 'Turns the board off' : 'Lights this climb'
              }
              onPress={() => void toggleLight()}
              hitSlop={4}
              style={({ pressed }) => [styles.lightButton, pressed && styles.pressed]}
            >
              <Icon
                icon={Lightbulb}
                size={22}
                filled={lit}
                color={lit ? LED.amber : lightProblem && connected ? theme.danger : connected ? theme.fg2 : theme.fg4}
              />
            </Pressable>
            <IconButton
              icon={Play}
              label={beta.videos.length > 0 ? `Beta videos, ${beta.videos.length}` : 'Beta videos'}
              size="lg"
              active={beta.videos.length > 0}
              onPress={() => router.push({ pathname: '/beta', params: { uuid: climb.uuid } })}
            />
            <IconButton
              icon={ListPlus}
              label="Save to a list"
              size="lg"
              onPress={() => router.push({ pathname: '/save', params: { uuid: climb.uuid } })}
            />
            <IconButton icon={Heart} label="Favourite" size="lg" active={favourite} onPress={toggleFavourite} />
            <IconButton
              icon={Check}
              label="Log this climb"
              size="lg"
              onPress={() => router.push({ pathname: '/log', params: { uuid: climb.uuid } })}
            />
          </>
        }
      />

      <View style={styles.title}>
        <View style={styles.titleRow}>
          <Marquee variant="title3">{climb.name}</Marquee>
          <GradeBadge
            label={gradeLabel(climb.difficulty, gradeFormat)}
            band={gradeBand(climb.difficulty)}
            benchmark={climb.benchmark_difficulty != null}
            fixedWidth
          />
        </View>
        <Text variant="small" tone="tertiary" numberOfLines={1}>
          {meta}
          {sent ? (
            <Text variant="small" color={theme.success}>
              {'  ·  Sent'}
            </Text>
          ) : null}
          {project ? (
            <Text variant="small" tone="secondary">
              {'  ·  Project'}
            </Text>
          ) : null}
        </Text>
      </View>

      <GestureDetector gesture={swipe}>
        <View style={styles.boardArea} onLayout={(event) => setBoardArea(event.nativeEvent.layout)}>
          {boardArea ? (
            <>
              <BoardView
                board={board}
                frames={climb.frames}
                maxHeight={boardArea.height - LEGEND_HEIGHT - spacing.sm}
                horizontalInset={spacing.sm * 2}
                lit={!connected || lit}
              />
              <View style={styles.legend}>
                <HoldLegend board={board} frames={climb.frames} singleLine />
              </View>
            </>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs, padding: spacing.xxl },
  lightButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  title: { paddingHorizontal: GUTTER, paddingBottom: spacing.md, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 32 },
  // Board and hold list sit right under the title; any spare room goes below them.
  boardArea: { flex: 1, alignItems: 'center' },
  legend: { alignSelf: 'stretch', height: LEGEND_HEIGHT, justifyContent: 'center', marginTop: spacing.sm },
});
