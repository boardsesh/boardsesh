import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ChannelSwitcherScreen } from '../../src/components/ChannelSwitcherScreen';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { parsePreviewChannel } from '../../src/lib/preview-link';

// Deep-link target for the "Open this preview in Boardsesh" link in every PR's
// OTA-preview comment — reached as https://www.boardsesh.com/preview/pr-1234
// (universal link) or com.boardsesh.app:///preview/pr-1234 (scheme, normalised
// in +native-intent.ts). Renders the same switcher as /channel-switcher, but
// asks it to offer the linked channel straight away.
//
// An unrecognised channel falls through to the plain switcher rather than
// +not-found: landing on the preview list is a better dead end than an error.
export default function PreviewChannelRoute() {
  const { t } = useTranslation('common');
  const screenOptions = useStackScreenOptions();
  const { channel } = useLocalSearchParams<{ channel?: string }>();
  const requestedChannel = parsePreviewChannel(channel);

  return (
    <>
      <Stack.Screen options={{ ...screenOptions, title: t('mobile.previewChannels.screenTitle'), headerShown: true }} />
      <ChannelSwitcherScreen requestedChannel={requestedChannel ?? undefined} />
    </>
  );
}
