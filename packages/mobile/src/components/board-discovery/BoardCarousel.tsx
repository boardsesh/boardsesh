import { BoardCarouselView, type BoardCarouselViewProps } from './BoardCarouselView';
import { BoardDiscoveryCard } from './BoardDiscoveryCard';
export function BoardCarousel(props: Omit<BoardCarouselViewProps, 'Card'>) {
  return <BoardCarouselView {...props} Card={BoardDiscoveryCard} />;
}
