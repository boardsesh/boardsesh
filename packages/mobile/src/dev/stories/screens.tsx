import { Component, Fragment, useCallback, useEffect, useMemo, useState, type ReactNode, type ErrorInfo } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Redirect, router, Stack, useIsFocused, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../../components/Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { loadStory, loadStories, storyModuleIds } from './registry';
import type { ComponentStory, RegisteredStory, StoryRenderControls } from './types';
import { useStoryRendererReady } from '../fixtures/board-render-style';
import { useStoryAppearance } from './use-story-appearance';

const HIDDEN_HEADER = { headerShown: false } as const;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function logReady(id: string): void {
  // The shots script waits for this line in the Metro log before capturing.
  // eslint-disable-next-line no-console
  console.log(`[stories] ready ${id}`);
}

/**
 * `dev/stories/<id>`: draws a view with injected props.
 *
 * `?shot=<nonce>` is set by the shots scripts on every `--story` capture. A new
 * value re-runs the story's effects, so re-shooting the story already on screen
 * (after an edit, or with another `--theme`) logs its line again.
 */
export function StoryScreen({
  inTab = false,
  defaultStoryId,
  tab,
}: {
  inTab?: boolean;
  defaultStoryId?: string;
  tab?: ComponentStory['tab'];
}) {
  const params = useLocalSearchParams<{
    id?: string;
    storyId?: string;
    theme?: string;
    variant?: string;
    locale?: string;
    renderMode?: string;
    shot?: string;
    captureOrientation?: string;
  }>();
  const { width, height } = useWindowDimensions();
  const id = firstParam(params.storyId) ?? firstParam(params.id) ?? defaultStoryId ?? '';
  const shot = firstParam(params.shot) ?? '';
  useStoryAppearance(firstParam(params.theme), firstParam(params.variant));

  const entry = loadStory(id);
  if (inTab && entry?.story.tab && entry.story.tab !== tab) return null;
  if (!entry) return <MissingStory id={id} shot={shot} />;
  const captureOrientation = firstParam(params.captureOrientation);
  // Navigation confirms the iOS system prompt in portrait. Do not mount content
  // or collect its asset/layout readiness until the requested capture dimensions.
  if (
    captureOrientation &&
    !((captureOrientation === 'portrait' && height > width) || (captureOrientation === 'landscape' && width > height))
  )
    return <View style={styles.fill} />;
  if (entry.story.tab && !inTab) {
    return (
      <Redirect
        href={{
          pathname: `/dev/story-tabs/${entry.story.tab}` as `/dev/story-tabs/${string}`,
          params: { ...params, id: undefined, storyId: entry.id },
        }}
      />
    );
  }
  return (
    <StoryCaptureBoundary key={`${entry.id}:${shot}:${captureOrientation ?? ''}`} id={entry.id}>
      <ComponentStoryCanvas entry={entry} story={entry.story} shot={shot} inTab={inTab} />
    </StoryCaptureBoundary>
  );
}

function ComponentStoryCanvas({
  entry,
  story,
  shot,
  inTab,
}: {
  entry: RegisteredStory;
  story: ComponentStory;
  shot: string;
  inTab: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const focused = useIsFocused();
  const rendererReady = useStoryRendererReady();
  const [laidOut, setLaidOut] = useState(false);
  const [contentReady, setContentReady] = useState(story.readiness !== 'explicit');
  const [failed, setFailed] = useState(false);
  const controls = useMemo<StoryRenderControls>(
    () => ({
      onReady: () => setContentReady(true),
      onError: (error: unknown) => {
        setFailed(true);
        // eslint-disable-next-line no-console
        console.error(`[stories] error ${entry.id} ${error instanceof Error ? error.message : String(error)}`);
      },
    }),
    [entry.id],
  );
  const onLayout = useCallback(() => setLaidOut(true), []);

  useEffect(() => {
    if (!focused || !laidOut || !contentReady || !rendererReady || failed) return;
    let finalFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      finalFrame = requestAnimationFrame(() => logReady(entry.id));
    });
    return () => {
      cancelAnimationFrame(frame);
      if (finalFrame !== undefined) cancelAnimationFrame(finalFrame);
    };
  }, [entry.id, shot, focused, laidOut, contentReady, rendererReady, failed]);

  if (story.layout === 'fullscreen') {
    return (
      <View onLayout={onLayout} style={[styles.fill, { backgroundColor: systemColors.background }]}>
        {!inTab && <Stack.Screen options={HIDDEN_HEADER} />}
        {story.render(controls)}
      </View>
    );
  }

  return (
    <View onLayout={onLayout} style={[styles.fill, { backgroundColor: systemColors.background }]}>
      {!inTab && <Stack.Screen options={HIDDEN_HEADER} />}
      <ScrollView
        contentContainerStyle={[
          styles.canvas,
          { paddingTop: insets.top + spacing[2], paddingBottom: insets.bottom + spacing[6] },
        ]}
      >
        <View style={styles.caption}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {entry.title}
          </Text>
          <Text variant="headline">{story.name}</Text>
        </View>
        {story.render(controls)}
      </ScrollView>
    </View>
  );
}

class StoryCaptureBoundary extends Component<{ id: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _details: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[stories] error ${this.props.id} ${error.message}`);
  }

  render() {
    return this.state.error ? (
      <StoryMessage title="Story failed" body={this.state.error.message} />
    ) : (
      this.props.children
    );
  }
}

function MissingStory({ id, shot }: { id: string; shot: string }) {
  const nearby = useMemo(() => {
    const needle = id.split('--')[0] ?? id;
    return storyModuleIds()
      .filter((moduleId) => moduleId.includes(needle))
      .slice(0, 8);
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log(`[stories] missing ${id}${nearby.length > 0 ? ` (did you mean ${nearby.join(', ')})` : ''}`);
  }, [id, nearby, shot]);
  return (
    <StoryMessage
      title={`No story "${id}"`}
      body={nearby.length > 0 ? nearby.join('\n') : 'See dev/stories for the list.'}
    />
  );
}

function StoryMessage({ title, body }: { title: string; body: string }) {
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  return (
    <View
      style={[
        styles.fill,
        styles.message,
        { paddingTop: insets.top + spacing[6], backgroundColor: systemColors.background },
      ]}
    >
      <Stack.Screen options={HIDDEN_HEADER} />
      <Text variant="headline">{title}</Text>
      {body ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

/** `dev/stories`: every view story, grouped by file. */
export function StoryIndexScreen() {
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const groups = useMemo(() => {
    const byTitle = new Map<string, RegisteredStory[]>();
    for (const entry of loadStories()) {
      const group = byTitle.get(entry.title) ?? [];
      group.push(entry);
      byTitle.set(entry.title, group);
    }
    return [...byTitle.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, []);

  return (
    <View style={[styles.fill, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={HIDDEN_HEADER} />
      <ScrollView
        contentContainerStyle={[
          styles.canvas,
          { paddingTop: insets.top + spacing[2], paddingBottom: insets.bottom + spacing[6] },
        ]}
      >
        <Text variant="largeTitle">Stories</Text>
        {groups.map(([title, entries]) => (
          <Fragment key={title}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.groupTitle}>
              {title}
            </Text>
            {entries.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                onPress={() => router.push(`/dev/stories/${entry.id}` as Href)}
                style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
              >
                <Text variant="body">{entry.story.name}</Text>
                <Text variant="footnote" color={systemColors.secondaryLabel}>
                  {entry.id}
                </Text>
              </Pressable>
            ))}
          </Fragment>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  canvas: {
    paddingHorizontal: spacing[4],
    gap: spacing[4],
  },
  caption: {
    gap: spacing[1],
  },
  message: {
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  groupTitle: {
    marginTop: spacing[2],
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  row: {
    borderRadius: 12,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
  },
});
