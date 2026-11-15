import { AppUpdatesCardView } from './AppUpdatesCardView';
import { appReleaseLabel } from './AppUpdatesCard.logic';
import { Text } from './Text';
import { Button } from './Button';
import type { StoryModule } from '../dev/stories/types';
const noop = () => {};
const scenarios = ['regular', 'canary', 'preview'] as const;
const stories: StoryModule = {
  title: 'App updates',
  stories: Object.fromEntries(
    scenarios.map((scenario) => {
      const context = {
        channel: 'production',
        branch: scenario === 'preview' ? 'pr-6476' : null,
        automaticCanary: scenario === 'canary',
      };
      return [
        scenario,
        {
          name: scenario,
          render: () => (
            <AppUpdatesCardView
              context={context}
              releaseLabel={appReleaseLabel(context)}
              isPending={false}
              busy={false}
              buildDetails={<Text>2.7 · Preview build</Text>}
              updateControl={() => <Button title="Check for updates" onPress={noop} />}
              available
              actions={[{ label: 'Production', selected: true }, { label: 'Staging' }]}
              onChannelPick={noop}
              showEarlyUpdates={false}
              earlyRow={undefined}
              earlyState="off"
              onEarlyUpdatesChange={noop}
              showQa
              currentPrNumber={scenario === 'preview' ? 6476 : null}
              onOpenQa={noop}
              onOpenPreviews={noop}
            />
          ),
        },
      ];
    }),
  ),
};
export default stories;
