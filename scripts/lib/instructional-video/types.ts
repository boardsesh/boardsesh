/** Shared authoring and capture contract for native instructional videos. */
export type TutorialPlatform = 'android' | 'ios';
export type TutorialRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type TutorialAnchor = TutorialRect & Readonly<{ t: number }>;

export type TutorialBeat = Readonly<{
  id: string;
  title: string;
  narration: string;
  /** Draft timing. Final timing comes from the corresponding voice recording. */
  seconds: number;
  takeId: string;
  fromMark: string;
  toMark?: string;
  /** Normalized rectangle in the captured screen, used for the detail zoom. */
  focus?: TutorialRect;
  anchor?: string;
  label: string;
  overview?: boolean;
}>;

export type TutorialChapter = Readonly<{
  id: string;
  title: string;
  beats: readonly TutorialBeat[];
}>;

export type TutorialTake = Readonly<{
  id: string;
  chapterId: string;
  route: string;
  /** Repository-relative Maestro flow. */
  flow: string;
  setupFlows?: readonly string[];
  requiredMarks: readonly string[];
  requiredAnchors?: readonly string[];
  minSeconds: number;
  session?: 'crew' | 'workout' | 'notification';
  requiresDownload?: boolean;
}>;

export type TutorialEpisode = Readonly<{
  id: string;
  title: string;
  language: 'en-US';
  releaseVersion?: string;
  sourceRef?: string;
  chapters: readonly TutorialChapter[];
  takes: readonly TutorialTake[];
  master: Readonly<{ minSeconds: number; maxSeconds: number }>;
  overview: Readonly<{ minSeconds: number; maxSeconds: number }>;
}>;

export type TutorialTakeManifest = Readonly<{
  formatVersion: 1;
  takeId: string;
  platform: TutorialPlatform;
  fps: 30;
  width: number;
  height: number;
  screen: Readonly<{ width: number; height: number }>;
  frameCount: number;
  seconds: number;
  sourceCommit: string;
  /** Release editions require an explicitly clean app-source capture. */
  sourceDirty?: boolean;
  nativeArtifactSha256: string;
  fingerprint: string;
  marks: Readonly<Record<string, number>>;
  anchors: Readonly<Record<string, readonly TutorialAnchor[]>>;
}>;

export type TutorialCaptureOptions = Readonly<{
  episode: TutorialEpisode;
  platform: TutorialPlatform;
  /** Absolute .boardsesh/tutorial-videos directory. */
  workRoot: string;
  chapterIds?: readonly string[];
  serial?: string;
  apkPath?: string;
  recapture?: boolean;
  backendUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Cancellation unwinds owned capture processes before stopping the local demo. */
  signal?: AbortSignal;
}>;

export const TUTORIAL_FPS = 30;
export const TUTORIAL_SIZE = { width: 1080, height: 1920 } as const;
/** Existing marketing Reels safe margins, reused for instructional text. */
export const TUTORIAL_SAFE_AREA = { top: 270, bottom: 672, left: 65, right: 65 } as const;
