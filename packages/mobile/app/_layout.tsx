import type { ComponentType } from 'react';
import { usePathname, type ErrorBoundaryProps } from 'expo-router';
import { loadIntegrationBootstrap } from '../src/dev/integration/load';
import { loadStoryRoot, loadStoryErrorBoundary } from '../src/dev/stories/load';

// Keep application imports lazy: their module initialization starts telemetry,
// update recovery and device services, before any provider can be mounted.
type ApplicationRoot = typeof import('../src/application-root');
let application: ApplicationRoot | undefined;
function loadApplication(): ApplicationRoot {
  application ??= require('../src/application-root') as ApplicationRoot;
  return application;
}

export const unstable_settings = { anchor: 'index' };

export function ErrorBoundary(props: ErrorBoundaryProps) {
  const pathname = usePathname();
  if (
    __DEV__ &&
    (process.env.EXPO_PUBLIC_STORY_MODE === '1' ||
      pathname.startsWith('/dev/stories') ||
      pathname.startsWith('/dev/story-tabs'))
  ) {
    const StoryBoundary = loadStoryErrorBoundary();
    if (StoryBoundary) return <StoryBoundary {...props} />;
  }
  const Boundary = loadApplication().ErrorBoundary;
  return <Boundary {...props} />;
}

function renderApplication() {
  const Application: ComponentType = loadApplication().default;
  return <Application />;
}

export default function RootLayout() {
  const pathname = usePathname();
  if (
    __DEV__ &&
    (process.env.EXPO_PUBLIC_STORY_MODE === '1' ||
      pathname.startsWith('/dev/stories') ||
      pathname.startsWith('/dev/story-tabs'))
  ) {
    const StoryRoot = loadStoryRoot();
    if (StoryRoot) return <StoryRoot />;
  }
  const Bootstrap = loadIntegrationBootstrap();
  return Bootstrap ? <Bootstrap renderApplication={renderApplication} /> : renderApplication();
}
