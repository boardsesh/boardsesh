import { RoomManager } from './room-manager';

export { RoomManager } from './room-manager';
export { VersionConflictError } from './types';
export type { ConnectedClient, DiscoverableSession, QueueState, PendingWrite } from './types';
export type { SessionConnectionLiveness, SessionLiveness } from './session-liveness';

export const roomManager = new RoomManager();
