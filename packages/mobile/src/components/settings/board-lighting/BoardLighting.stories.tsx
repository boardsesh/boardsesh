import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { buildBoardLightingSections } from './board-lighting-model';
import type { StoryModule } from '../../../dev/stories/types';
import type { KeepLightingChoice } from '../../../lib/keep-lighting';

function LightingStory() {
  const { t } = useTranslation('common');
  const [keep, setKeep] = useState<KeepLightingChoice>('60');
  const [drives, setDrives] = useState(false);
  const [disconnect, setDisconnect] = useState(true);
  const [always, setAlways] = useState(false);
  const [playlist, setPlaylist] = useState(true);
  const model = useMemo(
    () => ({
      sections: buildBoardLightingSections({
        t,
        keepLighting: { choice: keep, onChange: setKeep },
        drivesInSession: { enabled: drives, onChange: setDrives },
        disconnectWhenDrivingEnds: { enabled: disconnect, onChange: setDisconnect },
        alwaysDrive: { enabled: always, onChange: setAlways },
        playlistTapLoadsQueue: { enabled: playlist, onChange: setPlaylist },
        moonboardLightAdjacentHolds: null,
        onOpenDrivingHelp: () => {},
      }),
    }),
    [t, keep, drives, disconnect, always, playlist],
  );
  return <MoreForm model={model} />;
}
const stories: StoryModule = {
  title: 'Board lighting',
  stories: { settings: { name: 'Lighting and driving', layout: 'fullscreen', render: () => <LightingStory /> } },
};
export default stories;
