import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { MaterialIconProps } from './MaterialCommunityIcon.types';

// Android resolves the SVG implementation. Keep the existing font renderer on
// iOS and web, with the same set of names checked for both implementations.
export default function MaterialCommunityIcon(props: MaterialIconProps) {
  return <MaterialCommunityIcons {...props} />;
}
