import { useState } from 'react';
import type { StoryModule } from '../../dev/stories/types';
import { BoardShareSheet, type BoardShareVisibility } from './BoardShareSheet';

// The share sheet's three shapes (#4415): a Spraywall and a home board offer a
// printable wall poster; an invite link never does.

const WALL_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function OpenShareSheet({
  shareUrl,
  wallName,
  visibility,
  subject,
  posterUrl,
}: {
  shareUrl: string;
  wallName: string;
  visibility: BoardShareVisibility;
  subject?: 'wall' | 'board';
  posterUrl?: string;
}) {
  const [visible, setVisible] = useState(true);
  return (
    <BoardShareSheet
      visible={visible}
      onDismiss={() => setVisible(false)}
      shareUrl={shareUrl}
      wallName={wallName}
      visibility={visibility}
      subject={subject}
      posterUrl={posterUrl}
    />
  );
}

const stories: StoryModule = {
  title: 'Board discovery / Share sheet',
  stories: {
    sprayUnlisted: {
      name: 'Unlisted Spraywall, with Print a poster',
      render: () => (
        <OpenShareSheet
          shareUrl={`https://www.boardsesh.com/b/garage-spray/40/list?wall=${WALL_UUID}`}
          wallName="Garage Spraywall"
          visibility="unlisted"
          posterUrl={`https://www.boardsesh.com/poster/b/garage-spray?wall=${WALL_UUID}`}
        />
      ),
    },
    homeBoardPublic: {
      name: 'Public home board, with Print a poster',
      render: () => (
        <OpenShareSheet
          shareUrl="https://www.boardsesh.com/b/the-garage"
          wallName="The Garage"
          visibility="public"
          subject="board"
          posterUrl="https://www.boardsesh.com/poster/b/the-garage"
        />
      ),
    },
    homeBoardInvite: {
      name: 'Invite-only home board, no poster',
      render: () => (
        <OpenShareSheet
          shareUrl="https://www.boardsesh.com/b/the-garage?invite=Ab3_dE-fGhIjKlMnOpQrSt"
          wallName="The Garage"
          visibility="invite"
          subject="board"
        />
      ),
    },
  },
};

export default stories;
