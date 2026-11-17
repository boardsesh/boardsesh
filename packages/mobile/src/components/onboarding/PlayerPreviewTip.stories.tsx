import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StyleSheet, View } from 'react-native';
import type { StoryModule } from '../../dev/stories/types';
import type { WallGlowInput } from '../play-drawer/use-wall-glow';
import { spacing } from '../../theme/tokens';
import { PlayerPreviewTip } from './PlayerPreviewTip';

const noop = () => {};
// The sample wall button reads a few queries; a private client keeps the story offline.
const storyQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
const GLOW: WallGlowInput = {
  key: 'player-preview-tip-story',
  boardWidth: 100,
  boardHeight: 150,
  holds: [
    { x: 30, y: 8, color: '#FF00FF' },
    { x: 75, y: 16, color: '#4DF5FD' },
    { x: 50, y: 30, color: '#FFA500' },
    { x: 25, y: 55, color: '#4DF5FD' },
    { x: 70, y: 75, color: '#FFA500' },
    { x: 40, y: 100, color: '#4DF5FD' },
    { x: 65, y: 125, color: '#00DD00' },
  ],
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={storyQueryClient}>
      <View style={styles.screen}>{children}</View>
    </QueryClientProvider>
  );
}

const stories: StoryModule = {
  title: 'Onboarding / Player preview tip',
  stories: {
    timed: {
      name: 'Put on board drives for 45 seconds',
      layout: 'fullscreen',
      render: () => (
        <Frame>
          <PlayerPreviewTip
            glow={GLOW}
            keepLighting={{ windowMs: 45_000, setting: 'putOnBoardKeepsLighting' }}
            onExit={noop}
          />
        </Frame>
      ),
    },
    untilStop: {
      name: 'Put on board drives until you stop',
      layout: 'fullscreen',
      render: () => (
        <Frame>
          <PlayerPreviewTip
            glow={GLOW}
            keepLighting={{ windowMs: null, setting: 'putOnBoardKeepsLighting' }}
            onExit={noop}
          />
        </Frame>
      ),
    },
  },
};
export default stories;

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: spacing[4] },
});
