import { describe, expect, it } from 'vitest';
import type { ConfigContext } from 'expo/config';
import { FEEDBACK_ATTACHMENT_MAX_COUNT } from '@boardsesh/shared-schema';
import appConfig from '../../../app.config';

describe('native media share activation', () => {
  it('accepts links, images, recordings and mixed Android batches', () => {
    const config = appConfig({ config: { name: 'Boardsesh', slug: 'boardsesh' } } as ConfigContext);
    const plugin = config.plugins?.find((entry) => Array.isArray(entry) && entry[0] === 'expo-share-intent');
    expect(plugin).toEqual([
      'expo-share-intent',
      {
        iosActivationRules: {
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsImageWithMaxCount: FEEDBACK_ATTACHMENT_MAX_COUNT,
          NSExtensionActivationSupportsMovieWithMaxCount: FEEDBACK_ATTACHMENT_MAX_COUNT,
        },
        iosShareExtensionName: 'Boardsesh Share',
        iosAppGroupIdentifier: 'group.com.boardsesh.app',
        androidIntentFilters: ['text/*', 'image/*', 'video/*'],
        androidMultiIntentFilters: ['image/*', 'video/*', '*/*'],
      },
    ]);
  });
});
