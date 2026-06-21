// Pure board-presence ("now on the wall") state machine — no React, no DOM,
// works in any JS runtime. The React wrapper (useReducer bound to the presence
// subscription) lives in a separate `@boardsesh/board-presence-react` package.

export { boardPresenceReducer, initialBoardPresenceState, HISTORY_CAP } from './reducer';

export { mapBoardPresenceEnvelopeToAction } from './map-envelope';

export type { BoardPresenceState, BoardPresenceAction } from './types';
