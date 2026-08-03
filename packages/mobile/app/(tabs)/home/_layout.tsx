import { Stack } from 'expo-router';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';
import { NativeTabContentInsetProbe } from '../../../src/components/navigation/NativeTabContentInsetProbe';
import { BoardArtVisibilityProvider } from '../../../src/providers/board-art-visibility-provider';

export default function HomeLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <BoardArtVisibilityProvider tab="home">
      <NativeTabContentInsetProbe />
      <Stack screenOptions={screenOptions}>
        {/* The Home feed owns its top via floating chrome (the avatar island + scope
          title), like the other tabs — so the stack header is hidden here. */}
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* Session detail keeps the native tab bar by living in this stack, while
          pushed-route accessory/queue chrome unmounts. It sets its own header
          title from the loaded session. */}
        <Stack.Screen name="session/[sessionId]" options={{ headerShown: true }} />
      </Stack>
    </BoardArtVisibilityProvider>
  );
}
