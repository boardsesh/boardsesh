declare const controller: {
  appInputsUnchanged(github: unknown, context: unknown, deployedSha: string, headSha: string): Promise<boolean>;
  changedPaths(github: unknown, context: unknown, number: number): Promise<string[]>;
  cleanupPreview(options: Record<string, unknown>): Promise<void>;
  createBuildRequest(options: Record<string, unknown>): Promise<unknown>;
  inspectBuild(options: Record<string, unknown>): Promise<void>;
  inspectPublish(options: Record<string, unknown>): Promise<void>;
  prepareArtifact(
    directory: string,
    trustedDirectory: string,
    number: number,
    sha: string,
    hostDirectory: string,
  ): void;
  publish(options: Record<string, unknown>): Promise<void>;
  reconcilePullRequest(options: Record<string, unknown>): Promise<string>;
  retirePreview(number: number, options?: Record<string, unknown>): Promise<void>;
  reportPublishFailure(options: Record<string, unknown>): Promise<void>;
  runLifecycle(options: Record<string, unknown>): Promise<void>;
  sourceRequest(github: unknown, context: unknown): Promise<unknown>;
  validRequest(request: unknown, number: number): boolean;
};
export = controller;
