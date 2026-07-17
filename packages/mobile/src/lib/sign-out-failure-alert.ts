import { Alert } from 'react-native';

export function showSignOutFailure(title: string, message: string): void {
  Alert.alert(title, message);
}
