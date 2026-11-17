import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { ComponentProps } from 'react';

export type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

// Expo's --no-dev Metro proxy extracts CSS imports without installing them in
// the page. React hoists and deduplicates this resource in every browser mode.
const touchScrollStyles = `
/* RNGH v3 resets its detector's pan-y to inline none when a hook replaces its
 * config. These are only Swipeable's outer pan host and its immediate tap host;
 * nested row controls keep their own touch policy. The wrapper has no layout box.
 */
:is([data-boardsesh-web-swipeable='plain'], [data-boardsesh-web-swipeable='test-id'] > div)
  > div
  > div[style*='touch-action'],
:is([data-boardsesh-web-swipeable='plain'], [data-boardsesh-web-swipeable='test-id'] > div)
  > div
  > div
  > div
  > div[style*='touch-action'] {
  touch-action: pan-y !important;
}
`;

/** Keep RNGH's declared vertical browser scrolling across its v3 config updates. */
export default function WebSwipeable(props: ComponentProps<typeof Swipeable>) {
  return (
    <div data-boardsesh-web-swipeable={props.testID ? 'test-id' : 'plain'} style={{ display: 'contents' }}>
      <style href="boardsesh-swipeable-touch" precedence="default">
        {touchScrollStyles}
      </style>
      <Swipeable {...props} />
    </div>
  );
}
