/**
 * The web half of the pair described in `shards-async.ts`: one `import()` per
 * board config, so Metro emits each shard as its own chunk instead of putting
 * all 51 in the entry bundle.
 */
export { BOARD_ART_GEOMETRY_SHARDS_ASYNC } from './generated/shards.web';
