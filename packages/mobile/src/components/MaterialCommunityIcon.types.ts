import type { ComponentProps } from 'react';
import type MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { MaterialIconName } from './material-icon-paths';

export type { MaterialIconName } from './material-icon-paths';
export type MaterialIconProps = Omit<ComponentProps<typeof MaterialCommunityIcons>, 'name'> & {
  name: MaterialIconName;
};
