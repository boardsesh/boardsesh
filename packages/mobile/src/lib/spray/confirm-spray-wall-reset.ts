import { Alert } from 'react-native';

/** The four strings the confirm shows, already translated. */
export type SprayWallResetConfirmCopy = {
  title: string;
  body: string;
  start: string;
  cancel: string;
};

/**
 * Ask the owner before a reset starts. Resolves true for "Start reset".
 *
 * A system alert rather than an in-app dialog: it is raised over the live board
 * sheet, a native sheet that an in-app dialog would draw behind. Dismissing the
 * alert any other way (Android back) is "Not now".
 */
export function confirmSprayWallReset(copy: SprayWallResetConfirmCopy): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      copy.title,
      copy.body,
      [
        { text: copy.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: copy.start, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
