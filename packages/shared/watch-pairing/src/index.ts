// Shared watch-pairing helpers used by both web (settings section) and mobile
// (WatchPairScreen): the pair-code response type + runtime validator, and the
// pure countdown that drives the live "expires in" tick. Pure TS, no platform I/O.

export * from './types';
export * from './countdown';
