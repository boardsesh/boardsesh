/** Presentation fixtures, never evidence of a recorded account or backend response. */
export const CPP_STORY_TARGETS = {
  kilter: { boardId: 'kilter-original-12x12', label: 'Kilter Original' },
  tension: { boardId: 'tension-2-mirror', label: 'Tension Board 2' },
  moonboard: { boardId: 'moonboard-2024', label: 'MoonBoard 2024' },
  spray: { boardId: 'spray-liz', label: 'Liz’s spray wall' },
} as const;
export type CppStoryTarget = keyof typeof CPP_STORY_TARGETS;
export const CPP_STORY_SCENES = {
  kilter: ['search', 'logbook', 'queue', 'workout', 'status', 'kiosk'],
  tension: ['search', 'logbook', 'queue', 'workout', 'status', 'kiosk'],
  moonboard: ['search', 'logbook', 'queue', 'workout', 'status', 'kiosk'],
  spray: ['search', 'logbook', 'queue', 'workout', 'setting', 'playlist', 'holds'],
} as const;
