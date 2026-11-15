import { selectByVariant } from '../../theme/variants';
import { useTheme as usePaperTheme } from 'react-native-paper';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useTheme } from '../../providers/theme-provider';
import { WallStatusScene } from '../board-presence/WallStatus.stories';
import { OnboardingPromptView } from './OnboardingPromptView';
const noop = () => {};
function WelcomeStory({ onReady, onError }: StoryRenderControls) {
  const { systemColors, variant } = useTheme();
  const paper = usePaperTheme();
  return (
    <OnboardingPromptView
      onContinue={noop}
      onImageDisplayed={onReady}
      onImageError={onError}
      iconColor={String(selectByVariant(variant, { material: paper.colors.primary, liquidGlass: systemColors.accent }))}
      bodyColor={String(
        selectByVariant(variant, { material: paper.colors.onSurfaceVariant, liquidGlass: systemColors.secondaryLabel }),
      )}
      backgroundColor={String(
        selectByVariant(variant, { material: paper.colors.background, liquidGlass: systemColors.background }),
      )}
    />
  );
}
const stories: StoryModule = {
  title: 'Onboarding / Welcome',
  stories: {
    boardHistory: {
      name: 'Live board history',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <WallStatusScene {...controls} />,
    },
    welcome: {
      name: 'Live board history introduction',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <WelcomeStory {...controls} />,
    },
  },
};
export default stories;
