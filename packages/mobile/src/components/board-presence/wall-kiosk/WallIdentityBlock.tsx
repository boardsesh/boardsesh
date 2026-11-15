import { memo } from 'react';
import { useDisplayGrade } from '../../../hooks/use-display-grade';
import { WallIdentityBlockView, type WallIdentityBlockViewProps } from './WallIdentityBlockView';
type WallIdentityBlockProps = Omit<WallIdentityBlockViewProps, 'resolvedGrade'> & { boardName?: string };
export const WallIdentityBlock = memo(function WallIdentityBlock({ boardName, ...props }: WallIdentityBlockProps) {
  const { resolveGrade } = useDisplayGrade();
  const resolvedGrade = resolveGrade({ difficulty: props.climb?.grade ?? '' }, boardName);
  return <WallIdentityBlockView {...props} resolvedGrade={resolvedGrade} />;
});
