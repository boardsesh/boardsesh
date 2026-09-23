/**
 * Types for `create-service-docker-context.mjs`.
 *
 * The script is plain ESM with no types of its own. Most of the tests that
 * import it are outside `tsconfig.json`'s `include` and so never typechecked;
 * `backend-docker-context-images.test.ts` is inside it, and without this would
 * see the whole module as `any` — which is how `services.backend` stopped being
 * checked at all.
 *
 * Partial by design: it declares what a typechecked caller uses today. Adding
 * another test to the `include` that needs a different export fails loudly here
 * rather than silently widening back to `any`.
 */
declare module '*/create-service-docker-context.mjs' {
  export type ServiceDockerContextConfig = {
    dockerfile: string;
    rootPackageName?: string;
    rootPackageNames?: string[];
    extraSourceDirs?: string[];
    extraSourceDirExcludeExtensions?: string[];
  };

  export const services: Record<string, ServiceDockerContextConfig>;

  export function copyDirectory(
    sourceDirectory: string,
    destinationDirectory: string,
    repoRoot: string,
    rootSourceDirectory?: string,
    excludeExtensions?: string[],
  ): void;
}
