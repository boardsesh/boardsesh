// @boardsesh/queue-react — renderer-agnostic React for the queue.
//
// React hooks shared by web and mobile. Pure React only: hooks / context, no
// react-dom, no next, no DOM globals, no MUI (web); no react-native host
// components, no Expo APIs (mobile). All platform I/O (GraphQL client, session
// resolution, item mapping, error reporting) is injected — see
// `QueueMutationsDeps`. `react` is a peerDependency.

export { useQueueMutations } from './use-queue-mutations';
export { createQueueMutations } from './create-queue-mutations';
export type { QueueMutationsActions, QueueMutationsDeps, PublishPlaybackStateInput } from './create-queue-mutations';
// Re-exported for discoverability only. Consumers import the dedicated
// `@boardsesh/queue-react/queue-item-input` subpath instead: nine mobile provider
// suites whole-module-mock this barrel, and a barrel import of the mapper would
// resolve to `undefined` inside every one of them.
export { toClimbQueueItemInput, WIRE_ITEM_FIELDS } from './queue-item-input';
export type { QueueItemAttribution, WireBoundQueueItem } from './queue-item-input';
