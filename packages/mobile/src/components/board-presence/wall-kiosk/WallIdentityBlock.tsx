import { memo } from 'react';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { useAuroraPresenceClimb } from '../../../hooks/use-aurora-presence-grades';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { WallIdentityBlockView, type WallIdentityBlockViewProps } from './WallIdentityBlockView';
type WallIdentityBlockProps = Omit<WallIdentityBlockViewProps, 'resolvedGrade'> & {
  boardName?: string;
  boardConfig?: BoardConfig;
};
export const WallIdentityBlock = memo(function WallIdentityBlock({
  boardName,
  boardConfig,
  ...props
}: WallIdentityBlockProps) {
  const { resolveGrade } = useDisplayGrade();
  const { climb, grade } = useAuroraPresenceClimb(props.climb, boardConfig ?? null);
  const resolvedGrade = resolveGrade(grade ?? { difficulty: climb?.grade ?? '' }, boardName);
  return <WallIdentityBlockView {...props} climb={climb} resolvedGrade={resolvedGrade} />;
});
