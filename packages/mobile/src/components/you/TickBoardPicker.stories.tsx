import type { TickBoardOption } from '@boardsesh/graphql/operations';
import { useState } from 'react';
import type { StoryModule } from '../../dev/stories/types';
import { ModalSheet } from '../ModalSheet';
import { TickBoardPickerView } from './TickBoardPicker';
const boards: TickBoardOption[] = [
  { uuid: 'kilter', name: 'Kilter Board', boardType: 'kilter', layoutId: 1, sizeId: 7, setIds: '1,20' },
  { uuid: 'tension', name: 'Tension Board', boardType: 'tension', layoutId: 10, sizeId: 8, setIds: '12,13' },
];
const noop = () => {};
function BoardPickerStory({ onReady }: { onReady: () => void }) {
  const [selection, setSelection] = useState<TickBoardOption | null>(boards[0]);
  return (
    <ModalSheet visible onClose={noop} snapPoints={['90%']} onPresented={onReady}>
      <TickBoardPickerView
        choices={[null, ...boards]}
        selectedUuid={selection?.uuid ?? 'none'}
        onSelect={setSelection}
        onBack={noop}
        isFetching={false}
        isError={false}
        isPending={false}
        onLoadMore={noop}
        onRetry={noop}
      />
    </ModalSheet>
  );
}
export default {
  title: 'Logbook / Board picker',
  stories: {
    populated: {
      name: 'Choose board',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: ({ onReady }) => <BoardPickerStory onReady={onReady} />,
    },
  },
} satisfies StoryModule;
