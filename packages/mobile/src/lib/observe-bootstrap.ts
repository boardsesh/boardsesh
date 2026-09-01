// Side-effect-only module: registers the expo-observe SDK and configures it at
// module scope, before anything mounts. Import it exactly once, from
// app/_layout.tsx.
//
// The ordering is not a style choice. expo-observe's router integration reads
// `isInitialized()` when a screen's provider mounts and throws if that value
// ever changes afterwards ("Router integration was toggled during a screen's
// lifecycle"), so configure cannot move into a hook, an effect, or a provider —
// it has to have already happened by the time the first screen renders. Same
// reason `analytics-bootstrap.ts` next to it is an import rather than a call.
//
// This is also the ONLY module that imports `expo-observe` directly. Everything
// else reaches the SDK through the dependency-free slot in
// `observe-runtime.ts`, which is what keeps Expo's winter runtime out of the
// node-env test graph that `error-reporting.ts` sits in — importing the SDK
// there fails 33 test files with `Cannot find module './ImportMetaRegistry'`.
//
// The feature flags re-apply dispatchingEnabled / sampleRate later (see
// hooks/use-observe-runtime-config.ts); that is safe precisely because
// buildObserveConfig hands the same OBSERVE_INTEGRATIONS constant back.
import { Observe } from 'expo-observe';
import { buildObserveConfig, type ObserveRuntimeOverrides } from './observe-config';
import { setObserveRuntime } from './observe-runtime';

setObserveRuntime({
  configure: (overrides: ObserveRuntimeOverrides) => Observe.configure(buildObserveConfig(overrides)),
  reportError: (error: unknown) => Observe.reportError(error),
});

Observe.configure(buildObserveConfig());
