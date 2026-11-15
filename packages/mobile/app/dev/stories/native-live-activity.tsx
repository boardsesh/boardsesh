import { Redirect } from 'expo-router';
import { loadNativeActivitySetup } from '../../../src/dev/stories/load';
export default function NativeActivityRoute() {
  const Setup = loadNativeActivitySetup();
  return Setup ? <Setup /> : <Redirect href="/" />;
}
