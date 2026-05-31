// @boardsesh/queue-react — renderer-agnostic React for the queue.
//
// React hooks shared by web and mobile. Pure React only: hooks / context, no
// react-dom, no next, no DOM globals, no MUI (web); no react-native host
// components, no Expo APIs (mobile). All platform I/O (GraphQL client, session
// resolution, item mapping, error reporting) is injected — see
// `QueueMutationsDeps`. `react` is a peerDependency.

export { useQueueMutations } from './use-queue-mutations';
export { createQueueMutations } from './create-queue-mutations';
export type { QueueMutationsActions, QueueMutationsDeps } from './create-queue-mutations';
