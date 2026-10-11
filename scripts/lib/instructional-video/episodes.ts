import type { TutorialChapter, TutorialEpisode, TutorialTake } from './types';

const chapters: readonly TutorialChapter[] = [
  {
    id: 'crew',
    title: 'Your crew. One queue.',
    beats: [
      {
        id: 'crew-invite',
        title: 'Invite your crew',
        narration: 'Open the session invite. Your crew can scan the code and join your queue.',
        seconds: 7,
        takeId: 'crew',
        fromMark: 'invite',
        label: 'Scan to join',
        focus: { x: 0.18, y: 0.65, width: 0.64, height: 0.29 },
        overview: true,
      },
      {
        id: 'crew-contribution',
        title: 'Everyone adds climbs',
        narration: 'Everyone can add climbs. The avatar tells you who queued each one.',
        seconds: 7,
        takeId: 'crew',
        fromMark: 'contribution',
        label: 'See who queued it',
        focus: { x: 0.03, y: 0.75, width: 0.94, height: 0.13 },
        overview: true,
      },
      {
        id: 'crew-preview',
        title: 'Browse without interrupting',
        narration: 'Browse the queue without changing the wall. The current climb stays lit until you choose another.',
        seconds: 7,
        takeId: 'crew',
        fromMark: 'preview',
        label: 'Browse without changing the wall',
        focus: { x: 0.02, y: 0.885, width: 0.96, height: 0.06 },
      },
      {
        id: 'crew-play-next',
        title: 'Give someone the next go',
        narration: 'Long-press a queued climb and choose Play next to put it behind the current climb.',
        seconds: 7,
        takeId: 'crew',
        fromMark: 'play-next',
        label: 'Long-press → Play next',
        anchor: 'play-next',
      },
    ],
  },
  {
    id: 'workouts',
    title: 'Give your session a plan.',
    beats: [
      {
        id: 'workouts-generate',
        title: 'Build a workout',
        narration: 'Choose a workout and your grades. Boardsesh builds a queue you can climb through.',
        seconds: 7,
        takeId: 'workouts',
        fromMark: 'generated',
        label: 'Build a workout queue',
        focus: { x: 0.02, y: 0.495, width: 0.96, height: 0.31 },
        overview: true,
      },
      {
        id: 'workouts-rest',
        title: 'Set your rest',
        narration: 'Set a rest interval and turn on automatic advancement.',
        seconds: 7,
        takeId: 'workouts',
        fromMark: 'rest-configured',
        label: 'Set rest and auto-advance',
        focus: { x: 0.02, y: 0.515, width: 0.96, height: 0.285 },
      },
      {
        id: 'workouts-log',
        title: 'Rest between climbs',
        narration: 'After you log a go, rest runs automatically. Keep the app open to move on when it ends.',
        seconds: 7,
        takeId: 'workouts',
        fromMark: 'logged',
        label: 'Rest countdown → next climb',
        focus: { x: 0.24, y: 0.065, width: 0.74, height: 0.11 },
      },
      {
        id: 'workouts-advance',
        title: 'The next climb is ready',
        narration: 'When the rest ends, the queue moves on and the next climb lights up.',
        seconds: 7,
        takeId: 'workouts',
        fromMark: 'advanced',
        label: 'After rest → next climb',
        focus: { x: 0.04, y: 0.05, width: 0.92, height: 0.7 },
        overview: true,
      },
    ],
  },
  {
    id: 'search',
    title: 'Find your next project.',
    beats: [
      {
        id: 'search-holds',
        title: 'Pick the holds',
        narration: 'Paint the holds you want to use. The list narrows to climbs using your selection.',
        seconds: 7,
        takeId: 'search',
        fromMark: 'holds',
        label: 'Paint holds to filter climbs',
        focus: { x: 0.04, y: 0.18, width: 0.92, height: 0.65 },
      },
      {
        id: 'search-region',
        title: 'Choose part of the wall',
        narration: 'Drag over a region to find climbs in that part of the board.',
        seconds: 7,
        takeId: 'search',
        fromMark: 'region',
        label: 'Drag a region',
        focus: { x: 0.05, y: 0.13, width: 0.9, height: 0.68 },
      },
      {
        id: 'search-similar',
        title: 'Find something similar',
        narration: 'On your downloaded board, open Similar climbs to find another problem with familiar holds.',
        seconds: 7,
        takeId: 'search',
        fromMark: 'similar',
        label: 'Similar climbs · downloaded board',
        focus: { x: 0.03, y: 0.725, width: 0.94, height: 0.25 },
        overview: true,
      },
      {
        id: 'search-heatmap',
        title: 'See which holds get used',
        narration: 'The hold heatmap shows what gets used most. It works on your downloaded board.',
        seconds: 7,
        takeId: 'search',
        fromMark: 'heatmap',
        label: 'Explore the hold heatmap',
        focus: { x: 0.05, y: 0.16, width: 0.9, height: 0.66 },
      },
    ],
  },
  {
    id: 'spray',
    title: 'Your spray wall, too.',
    beats: [
      {
        id: 'spray-photo',
        title: 'Your wall, in your pocket',
        narration: 'Your spray wall lives on its own photo, alongside the other boards you climb.',
        seconds: 7,
        takeId: 'spray',
        fromMark: 'photo',
        label: 'Your own wall photo',
        anchor: 'board-surface',
        focus: { x: 0.035, y: 0.245, width: 0.93, height: 0.49 },
      },
      {
        id: 'spray-highlight',
        title: 'Follow the highlighted holds',
        narration: 'Pick a climb and its holds light up on the photo. No LEDs needed.',
        seconds: 7,
        takeId: 'spray',
        fromMark: 'highlight',
        label: 'Highlighted holds · no LEDs',
        anchor: 'board-surface',
        focus: { x: 0.1, y: 0.38, width: 0.8, height: 0.22 },
        overview: true,
      },
      {
        id: 'spray-look',
        title: 'Keep your own hold look',
        narration: 'Turn on Use my look on spray walls to keep your own hold colors and outlines.',
        seconds: 7,
        takeId: 'spray',
        fromMark: 'look',
        label: 'Use your look on spray walls',
        focus: { x: 0, y: 0.34, width: 1, height: 0.17 },
      },
      {
        id: 'spray-share',
        title: 'Share with your crew',
        narration: 'Share your wall by link or QR code so your crew can climb on it too.',
        seconds: 7,
        takeId: 'spray',
        fromMark: 'share',
        label: 'Share your wall with the crew',
        focus: { x: 0, y: 0.56, width: 1, height: 0.43 },
      },
    ],
  },
  {
    id: 'progress',
    title: 'Make every send count.',
    beats: [
      {
        id: 'progress-grades',
        title: 'Use the grades you gave',
        narration: 'Turn on Use my grades to see climbs with the grades you gave them.',
        seconds: 7,
        takeId: 'progress',
        fromMark: 'personal-grades',
        label: 'Turn on Use my grades',
        focus: { x: 0, y: 0.405, width: 1, height: 0.095 },
      },
      {
        id: 'progress-filter',
        title: 'Find climbs at your grade',
        narration: 'Your personal grades also shape sorting and filtering, so the list fits your experience.',
        seconds: 7,
        takeId: 'progress',
        fromMark: 'grade-filter',
        label: 'Filter using your own grades',
        focus: { x: 0, y: 0.23, width: 1, height: 0.26 },
      },
      {
        id: 'progress-boards',
        title: 'See all your boards together',
        narration: 'Open your progress to see sends across all your boards in one place.',
        seconds: 7,
        takeId: 'progress',
        fromMark: 'multiboard',
        label: 'Every board · one logbook',
        focus: { x: 0.04, y: 0.19, width: 0.92, height: 0.405 },
        overview: true,
      },
      {
        id: 'progress-calendar',
        title: 'Follow your progress',
        narration: 'Pick a board to explore its progress and see when you climbed on the calendar.',
        seconds: 7,
        takeId: 'progress',
        fromMark: 'calendar',
        label: 'Kilter · climbing calendar',
        focus: { x: 0, y: 0.445, width: 1, height: 0.235 },
      },
    ],
  },
];

const takes: readonly TutorialTake[] = chapters.map((chapter) => ({
  id: chapter.id,
  chapterId: chapter.id,
  route: chapter.id === 'progress' ? 'profile' : 'boards',
  flow: `packages/mobile/.maestro/tutorial/${chapter.id}.yaml`,
  requiredMarks: chapter.beats.map((beat) => beat.fromMark),
  // Capture requirements stay stable when an edit replaces an anchor with a measured crop.
  requiredAnchors:
    chapter.id === 'crew'
      ? ['invite-qr', 'queue-row-avatar', 'play-next']
      : chapter.id === 'spray'
        ? ['board-surface']
        : [],
  minSeconds: 28,
  ...(chapter.id === 'crew' ? { session: 'crew' as const } : {}),
  ...(chapter.id === 'workouts' ? { session: 'workout' as const } : {}),
  ...(chapter.id === 'search' ? { requiresDownload: true } : {}),
}));

export const EVERGREEN_EPISODE: TutorialEpisode = {
  id: 'evergreen',
  title: 'Get more from Boardsesh',
  language: 'en-US',
  chapters,
  takes,
  master: { minSeconds: 120, maxSeconds: 180 },
  overview: { minSeconds: 45, maxSeconds: 60 },
};

/** A release authoring template; a pinned source and crew-notes capture complete it. */
export const RELEASE_260_EPISODE: TutorialEpisode = {
  id: 'release-2.6.0',
  title: 'New in Boardsesh 2.6.0',
  language: 'en-US',
  releaseVersion: '2.6.0',
  chapters: [
    { ...chapters[3], beats: chapters[3].beats.slice(0, 2).map((beat) => ({ ...beat, overview: true })) },
    { ...chapters[1], beats: chapters[1].beats.slice(2).map((beat) => ({ ...beat, overview: true })) },
    {
      id: 'crew-notes',
      title: 'Your crew, on every climb.',
      beats: [
        {
          id: 'crew-notes',
          title: 'Read your crew’s notes',
          narration: 'The people you follow come first on a climb: their notes and the grade they gave it.',
          seconds: 8,
          takeId: 'crew-notes',
          fromMark: 'notes',
          label: 'Your crew’s notes and grades',
          overview: true,
        },
      ],
    },
    { ...chapters[4], beats: chapters[4].beats.slice(0, 2).map((beat) => ({ ...beat, overview: true })) },
  ],
  takes: [
    takes[3],
    takes[1],
    takes[4],
    {
      id: 'crew-notes',
      chapterId: 'crew-notes',
      route: 'boards',
      flow: 'packages/mobile/.maestro/tutorial/crew-notes.yaml',
      requiredMarks: ['notes'],
      minSeconds: 8,
    },
  ],
  master: { minSeconds: 45, maxSeconds: 90 },
  overview: { minSeconds: 45, maxSeconds: 60 },
};

export const TUTORIAL_EPISODES: readonly TutorialEpisode[] = [EVERGREEN_EPISODE, RELEASE_260_EPISODE];

export function tutorialEpisode(id: string): TutorialEpisode {
  const episode = TUTORIAL_EPISODES.find((candidate) => candidate.id === id);
  if (!episode)
    throw new Error(
      `Unknown episode "${id}". Choose ${TUTORIAL_EPISODES.map((candidate) => candidate.id).join(', ')}.`,
    );
  validateTutorialEpisode(episode);
  return episode;
}

export function validateTutorialEpisode(episode: TutorialEpisode): void {
  const identifiers = new Set<string>();
  const takeIds = new Set(episode.takes.map((take) => take.id));
  for (const identifier of [
    episode.id,
    ...episode.chapters.map((chapter) => chapter.id),
    ...episode.chapters.flatMap((chapter) => chapter.beats.map((beat) => beat.id)),
  ]) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(identifier)) throw new Error(`Invalid tutorial identifier: ${identifier}`);
  }
  for (const chapter of episode.chapters) {
    if (identifiers.has(`chapter:${chapter.id}`)) throw new Error(`Duplicate chapter: ${chapter.id}`);
    identifiers.add(`chapter:${chapter.id}`);
    if (chapter.beats.length === 0) throw new Error(`Chapter ${chapter.id} has no teaching beats`);
    for (const beat of chapter.beats) {
      if (identifiers.has(`beat:${beat.id}`)) throw new Error(`Duplicate teaching beat: ${beat.id}`);
      identifiers.add(`beat:${beat.id}`);
      if (!takeIds.has(beat.takeId)) throw new Error(`Beat ${beat.id} references missing take ${beat.takeId}`);
      const take = episode.takes.find((candidate) => candidate.id === beat.takeId);
      if (!take?.requiredMarks.includes(beat.fromMark))
        throw new Error(`Beat ${beat.id} has an undeclared capture mark ${beat.fromMark}`);
      if (!Number.isFinite(beat.seconds) || beat.seconds <= 0)
        throw new Error(`Beat ${beat.id} needs a positive duration`);
      if (!beat.narration.trim() || !beat.label.trim()) throw new Error(`Beat ${beat.id} needs narration and a label`);
      if (
        beat.focus &&
        (Object.values(beat.focus).some(
          (coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1,
        ) ||
          beat.focus.width === 0 ||
          beat.focus.height === 0 ||
          beat.focus.x + beat.focus.width > 1 ||
          beat.focus.y + beat.focus.height > 1)
      ) {
        throw new Error(`Beat ${beat.id} has a focus rectangle outside the screen`);
      }
    }
  }
  if (takeIds.size !== episode.takes.length) throw new Error(`Episode ${episode.id} has duplicate takes`);
}
