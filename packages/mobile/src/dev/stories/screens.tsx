import { Fragment, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isThemeOverride, isUiVariantPreference } from '@boardsesh/key-value-storage';
import { Text } from '../../components/Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { STORIES } from './registry';
import { findStory } from './registry-core';
import { getScenarioOverrides, setScenarioOverrides, subscribeScenarioOverrides } from './scenario-overrides';
import { isScenarioStory, type ComponentStory, type RegisteredStory, type ScenarioStory } from './types';

const HIDDEN_HEADER = { headerShown: false } as const;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `?theme=dark|light|system` and `?variant=liquidGlass|material|auto` switch the
 * whole app through the real theme setters, so a scenario route opened next is
 * drawn the same way. Both persist on the simulator like a Settings change.
 */
function useStoryAppearance(themeParam: string | undefined, variantParam: string | undefined): void {
  const { themeOverride, setThemeOverride, uiVariantPreference, setUiVariant } = useTheme();
  useEffect(() => {
    if (isThemeOverride(themeParam) && themeParam !== themeOverride) void setThemeOverride(themeParam);
  }, [themeParam, themeOverride, setThemeOverride]);
  useEffect(() => {
    if (isUiVariantPreference(variantParam) && variantParam !== uiVariantPreference) void setUiVariant(variantParam);
  }, [variantParam, uiVariantPreference, setUiVariant]);
}

function logReady(id: string): void {
  // The shots script waits for this line in the Metro log before capturing.
  // eslint-disable-next-line no-console
  console.log(`[stories] ready ${id}`);
}

/**
 * `dev/stories/<id>`: draws a component story, or applies a scenario and opens its route.
 *
 * `?shot=<nonce>` is set by the shots scripts on every `--story` capture. A new
 * value re-runs the story's effects, so re-shooting the story already on screen
 * (after an edit, or with another `--theme`) logs its line again.
 */
export function StoryScreen() {
  const params = useLocalSearchParams<{ id: string; theme?: string; variant?: string; shot?: string }>();
  const id = firstParam(params.id) ?? '';
  const shot = firstParam(params.shot) ?? '';
  useStoryAppearance(firstParam(params.theme), firstParam(params.variant));

  if (id === 'reset') return <ResetScenario shot={shot} />;
  const entry = findStory(STORIES, id);
  if (!entry) return <MissingStory id={id} shot={shot} />;
  if (isScenarioStory(entry.story)) {
    return <OpenScenario key={entry.id} entry={entry} story={entry.story} shot={shot} />;
  }
  return <ComponentStoryCanvas key={entry.id} entry={entry} story={entry.story} shot={shot} />;
}

function ComponentStoryCanvas({ entry, story, shot }: { entry: RegisteredStory; story: ComponentStory; shot: string }) {
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const overrides = story.overrides ?? null;

  // Every story sets the whole override state while it is on screen: one
  // without overrides clears a scenario's, so a component draws the same
  // whatever was opened before it. Applied on focus, so going back to this story
  // re-applies them. On blur, clear only our own: a newer story may already
  // have replaced them.
  useFocusEffect(
    useCallback(() => {
      setScenarioOverrides(overrides);
      return () => {
        if (overrides !== null && getScenarioOverrides() === overrides) setScenarioOverrides(null);
      };
    }, [overrides]),
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => logReady(entry.id));
    return () => cancelAnimationFrame(frame);
  }, [entry.id, shot]);

  if (story.layout === 'fullscreen') {
    return (
      <View style={[styles.fill, { backgroundColor: systemColors.background }]}>
        <Stack.Screen options={HIDDEN_HEADER} />
        {story.render()}
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={HIDDEN_HEADER} />
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
        {story.render()}
      </ScrollView>
    </View>
  );
}

function OpenScenario({ entry, story, shot }: { entry: RegisteredStory; story: ScenarioStory; shot: string }) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await story.prepare?.();
      if (cancelled) return;
      setScenarioOverrides(story.overrides);
      // eslint-disable-next-line no-console
      console.log(`[stories] scenario ${entry.id} -> ${story.route}`);
      router.replace(story.route as Href);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.id, story, shot]);
  return <StoryMessage title={`Opening ${entry.id}`} body={story.route} />;
}

function ResetScenario({ shot }: { shot: string }) {
  useEffect(() => {
    setScenarioOverrides(null);
    router.replace('/dev/stories' as Href);
    logReady('reset');
  }, [shot]);
  return <StoryMessage title="Clearing scenario overrides" body="" />;
}

function MissingStory({ id, shot }: { id: string; shot: string }) {
  const nearby = useMemo(() => {
    const needle = id.split('--')[0] ?? id;
    return STORIES.filter((entry) => entry.id.includes(needle))
      .slice(0, 8)
      .map((entry) => entry.id);
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

/** `dev/stories`: every story, grouped by file, plus a reset for scenario overrides. */
export function StoryIndexScreen() {
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();
  const overrides = useSyncExternalStore(subscribeScenarioOverrides, getScenarioOverrides, getScenarioOverrides);
  const groups = useMemo(() => {
    const byTitle = new Map<string, RegisteredStory[]>();
    for (const entry of STORIES) {
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
        {overrides ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setScenarioOverrides(null)}
            style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
          >
            <Text variant="body">Scenario overrides are on. Tap to clear.</Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {JSON.stringify(overrides)}
            </Text>
          </Pressable>
        ) : null}
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
                  {isScenarioStory(entry.story) ? `${entry.id} · opens ${entry.story.route}` : entry.id}
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
