// Web-side re-export shim for the Woods board config, mirroring
// `moonboard-config.ts`. Web code imports Woods helpers from here so the
// `@boardsesh/board-config` path stays in one place. www only resolves Woods
// board routes now that the climbing UI lives in the Expo app, so this is
// deliberately narrower than the MoonBoard shim.
export { WOODS_LAYOUTS, WOODS_SETS, WOODS_SIZES } from '@boardsesh/board-config';
