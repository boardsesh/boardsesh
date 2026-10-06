import { useRef } from 'react';
import { Alert } from 'react-native';
import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';

type SprayLeaveStrings = { title: string; body: string; stay: string; leave: string };

/** Registers native dismissal prevention, including the containing boards modal. */
export function useSprayLeaveGuard(shouldConfirm: boolean, strings: SprayLeaveStrings): void {
  const navigation = useNavigation();
  const alertOpen = useRef(false);
  usePreventRemove(shouldConfirm, ({ data: { action } }) => {
    // A second swipe while the alert is open must not stack another question.
    if (alertOpen.current) return;
    alertOpen.current = true;
    const closeAlert = () => {
      alertOpen.current = false;
    };
    Alert.alert(
      strings.title,
      strings.body,
      [
        { text: strings.stay, style: 'cancel', onPress: closeAlert },
        {
          text: strings.leave,
          onPress: () => {
            closeAlert();
            navigation.dispatch(action);
          },
        },
      ],
      { onDismiss: closeAlert },
    );
  });
}
