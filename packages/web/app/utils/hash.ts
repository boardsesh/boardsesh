/**
 * Queue state hashing lives in @boardsesh/queue so web and backend share one
 * implementation and can never drift (issue #2359). This re-export keeps the
 * existing `@/app/utils/hash` import path — and the test mocks pinned to it —
 * working without duplicating the logic.
 */
export { fnv1aHash, computeQueueStateHash } from '@boardsesh/queue';
