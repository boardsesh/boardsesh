// Thin re-export: the implementation now lives in @boardsesh/board-config so
// it can be shared with the React Native MoonBoard editor. Kept here so
// existing web imports (`@/app/lib/moonboard-climb-helpers`) don't change.
export { convertLitUpHoldsMapToMoonBoardHolds } from '@boardsesh/board-config';
