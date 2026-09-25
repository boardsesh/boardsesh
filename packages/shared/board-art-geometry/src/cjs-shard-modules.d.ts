/**
 * Types the `import('./<board>/<layout>-<size>.cjs')` calls in
 * `generated/shards.web.ts`.
 *
 * The shards are `.cjs` with no declaration files, which is fine for the native
 * index: it reaches them through `require`, and `@types/node` types that as
 * `any`. `import()` is real module resolution, so without this TypeScript raises
 * TS7016 on all 51 of them.
 *
 * `unknown` rather than `BoardArtGeometry` on purpose — nothing has actually
 * checked what is in those files, and `unwrap()` in the generated web index is
 * where the cast is made and where it is visible.
 *
 * Scope: this file is only reachable from this package's own `include`
 * (`src/**\/*`). Consumers resolve `./generated/shards` to the native
 * `shards.ts` and never compile the web variant, so the wildcard does not leak
 * into their programs. Nothing else in the repo reaches a `.cjs` through
 * `import` — every other use is `require`.
 */
declare module '*.cjs' {
  const shard: unknown;
  export default shard;
}
