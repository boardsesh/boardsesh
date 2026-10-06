import { SHOWCASE_FPS, type ShowcaseCalloutName, type ShowcaseTakeId } from './contract';

/**
 * The storyboard, in frames at 30 fps. Scenes are back to back with no gaps;
 * `showcase-video-timeline.test` holds that and the 50–60 s runtime. Callout
 * scenes are as long as their callouts' reading time needs (render.ts
 * `readingBudgetReport`); the rest keep the rhythm.
 *
 * Backgrounds alternate from the first scene on (`resolveTimeline`), so two
 * busy layouts never meet on the same background. The one dark→dark join is
 * deliberate: log → outro hands a phone scene to the centred end card, which
 * then loops back into the boards scene, also dark.
 */
export type ShowcaseSceneId = 'boards' | 'spray' | 'wall' | 'crew' | 'workouts' | 'lock-screen' | 'log' | 'outro';

export type ShowcaseScene = Readonly<{
  id: ShowcaseSceneId;
  startFrame: number;
  endFrame: number;
  background: 'dark' | 'light';
  /**
   * Takes whose footage the scene shows. For the boards pile-up this is the
   * arrival order: the first three stand in the opening trio, the rest crowd
   * in after.
   */
  takes: readonly ShowcaseTakeId[];
  /** Callouts, in climb-role order (start, hand, finish). Either background. */
  callouts: readonly ShowcaseCalloutName[];
}>;

export const SHOWCASE_SCENES: readonly ShowcaseScene[] = [
  {
    id: 'boards',
    startFrame: 0,
    endFrame: 156,
    background: 'dark',
    takes: [
      'boards-kilter',
      'boards-tension',
      'boards-spray',
      'boards-moonboard',
      'boards-woods',
      'boards-decoy',
      'boards-touchstone',
      'boards-grasshopper',
      'boards-soill',
    ],
    callouts: [],
  },
  // One phone on a spray wall: the holds drawn on the owner's own photo.
  { id: 'spray', startFrame: 156, endFrame: 336, background: 'light', takes: ['spray'], callouts: ['board-surface'] },
  {
    id: 'wall',
    startFrame: 336,
    endFrame: 606,
    background: 'dark',
    takes: ['wall'],
    callouts: ['board-history-button', 'now-on-wall', 'wall-history'],
  },
  {
    id: 'crew',
    startFrame: 606,
    endFrame: 888,
    background: 'light',
    takes: ['crew'],
    callouts: ['invite-qr', 'queue-row-avatar', 'play-next'],
  },
  { id: 'workouts', startFrame: 888, endFrame: 1056, background: 'dark', takes: ['workouts'], callouts: [] },
  // The Dynamic Island scene. Id and take keep their lock-screen names so the
  // recorder and the anchors contract stay put.
  {
    id: 'lock-screen',
    startFrame: 1056,
    endFrame: 1236,
    background: 'light',
    takes: ['lock-screen'],
    callouts: ['lock-next', 'lock-relight', 'lock-mirror'],
  },
  {
    id: 'log',
    startFrame: 1236,
    endFrame: 1452,
    background: 'dark',
    takes: ['log'],
    callouts: ['profile-board-filter', 'activity-calendar'],
  },
  { id: 'outro', startFrame: 1452, endFrame: 1644, background: 'dark', takes: [], callouts: [] },
];

export const SHOWCASE_TOTAL_FRAMES = SHOWCASE_SCENES[SHOWCASE_SCENES.length - 1].endFrame;

/** Frame 0 is the settled boards trio: the poster, baked in as the first frame. */
export const SHOWCASE_POSTER_FRAME = 0;

/**
 * Scenes the cut can do without. The island scene needs a Live Activity, which
 * the simulator may refuse to start; without its take the scene is dropped and
 * the rest close up.
 */
export const SHOWCASE_SKIPPABLE_SCENES: readonly ShowcaseSceneId[] = ['lock-screen'];

/**
 * Takes the render can do without: any board phone (the pile-up uses however
 * many arrived, at least one) and the takes of a skippable scene.
 */
export const SHOWCASE_OPTIONAL_TAKES: readonly ShowcaseTakeId[] = SHOWCASE_SCENES.filter(
  (scene) => scene.id === 'boards' || SHOWCASE_SKIPPABLE_SCENES.includes(scene.id),
).flatMap((scene) => scene.takes);

export type ShowcaseTimeline = Readonly<{
  scenes: readonly ShowcaseScene[];
  totalFrames: number;
  skipped: readonly ShowcaseSceneId[];
}>;

/**
 * One scene of a cut: which storyboard scene, in what order, and optionally a
 * different length (frames) than the storyboard's. A render target
 * (`targets.ts`) is a list of these.
 */
export type ShowcaseScenePlan = Readonly<{ id: ShowcaseSceneId; frames?: number }>;

/** The storyboard as a plan: every scene, in order, at its own length. */
export const SHOWCASE_FULL_PLAN: readonly ShowcaseScenePlan[] = SHOWCASE_SCENES.map((scene) => ({ id: scene.id }));

const storyboardScene = (id: ShowcaseSceneId): ShowcaseScene => {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.id === id);
  if (!scene) throw new Error(`No storyboard scene "${id}"`);
  return scene;
};

/** Frames a plan runs with every take present. */
export const planFrames = (plan: readonly ShowcaseScenePlan[]): number =>
  plan.reduce((sum, step) => {
    const scene = storyboardScene(step.id);
    return sum + (step.frames ?? scene.endFrame - scene.startFrame);
  }, 0);

/**
 * The cut for the footage at hand: the plan's scenes in its order and lengths,
 * less any skippable scene whose takes are missing; the scenes after it move
 * up, and backgrounds alternate from the first scene (dark, light, dark, …;
 * the last scene keeps its own, so the outro stays dark for the loop), so no
 * two busy scenes share a background. With every take present and the full
 * plan this is `SHOWCASE_SCENES` exactly.
 */
export function resolveTimeline(
  available: ReadonlySet<ShowcaseTakeId>,
  plan: readonly ShowcaseScenePlan[] = SHOWCASE_FULL_PLAN,
): ShowcaseTimeline {
  const skipped: ShowcaseSceneId[] = [];
  const planned = plan.map((step) => ({ scene: storyboardScene(step.id), frames: step.frames }));
  const kept = planned.filter(({ scene }) => {
    const missing = SHOWCASE_SKIPPABLE_SCENES.includes(scene.id) && scene.takes.some((take) => !available.has(take));
    if (missing) skipped.push(scene.id);
    return !missing;
  });
  let frame = 0;
  const scenes = kept.map(({ scene, frames }, index): ShowcaseScene => {
    const length = frames ?? scene.endFrame - scene.startFrame;
    const background = index === kept.length - 1 ? scene.background : index % 2 === 0 ? 'dark' : 'light';
    const moved = { ...scene, startFrame: frame, endFrame: frame + length, background };
    frame += length;
    return moved;
  });
  return { scenes, totalFrames: frame, skipped };
}

/** Footage asked of a take no scene uses (every take has a scene in this cut). */
export const DEFAULT_TAKE_SECONDS = 6;

/**
 * Seconds of footage each take must supply: the scene's length plus a second of
 * slack either side, because the phone arrives before the scene's text and
 * leaves after it. The recorder's self-check fails a take shorter than this. A
 * take no scene uses gets `DEFAULT_TAKE_SECONDS`.
 */
export function requiredTakeSeconds(takeId: ShowcaseTakeId): number {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  if (!scene) return DEFAULT_TAKE_SECONDS;
  return (scene.endFrame - scene.startFrame) / SHOWCASE_FPS + 2;
}
