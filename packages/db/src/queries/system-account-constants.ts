/** Fixed identity for shared boards and unclaimed catalogue content; no sign-in capability. */
export const SYSTEM_BOARD_OWNER_ID = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_BOARD_OWNER_EMAIL = 'system@boardsesh.com';
export const SYSTEM_BOARD_OWNER_NAME = 'Boardsesh';

/** Fixed owner of generated recommendation cohort playlists. */
export const RECOMMENDATIONS_USER_ID = 'system-recommendations';
export const RECOMMENDATIONS_USER_EMAIL = 'recommendations@boardsesh.com';
export const RECOMMENDATIONS_USER_NAME = 'Boardsesh';

/** Fixed owner of the hold-classifier's shadow classifications. */
export const HOLD_CLASSIFIER_USER_ID = 'system-hold-classifier';
export const HOLD_CLASSIFIER_USER_EMAIL = 'hold-classifier@boardsesh.com';
export const HOLD_CLASSIFIER_USER_NAME = 'Boardsesh Hold Classifier';

export const BATCH_SYSTEM_USERS = {
  recommendations: {
    id: RECOMMENDATIONS_USER_ID,
    email: RECOMMENDATIONS_USER_EMAIL,
    name: RECOMMENDATIONS_USER_NAME,
  },
  'hold-classifier': {
    id: HOLD_CLASSIFIER_USER_ID,
    email: HOLD_CLASSIFIER_USER_EMAIL,
    name: HOLD_CLASSIFIER_USER_NAME,
  },
} as const;
