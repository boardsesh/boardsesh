import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { ComponentProps } from 'react';
import './reanimated-swipeable.css';

export type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';

/** Keep RNGH's declared vertical browser scrolling across its v3 config updates. */
export default function WebSwipeable(props: ComponentProps<typeof Swipeable>) {
  return (
    <div data-boardsesh-web-swipeable={props.testID ? 'test-id' : 'plain'} style={{ display: 'contents' }}>
      <Swipeable {...props} />
    </div>
  );
}
