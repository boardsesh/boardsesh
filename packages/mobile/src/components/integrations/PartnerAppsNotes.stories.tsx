import { useState } from 'react';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { CreateDrawerFormView } from '../create-climb/CreateDrawerFormView';

/** The create-climb form below the board, its switches live, as a setter sees it. */
function DraftForm({
  boardName,
  sprayWallPublic = false,
  partnerAppsEnabled = true,
}: {
  boardName: string;
  sprayWallPublic?: boolean;
  partnerAppsEnabled?: boolean;
}) {
  const [description, setDescription] = useState('');
  const [noMatch, setNoMatch] = useState(false);
  const [noKickboard, setNoKickboard] = useState(false);
  const [campus, setCampus] = useState(false);
  const [anyFeet, setAnyFeet] = useState(false);
  const [isDraft, setIsDraft] = useState(true);
  return (
    <StorySurface>
      <CreateDrawerFormView
        partnerAppsEnabled={partnerAppsEnabled}
        boardName={boardName}
        description={description}
        onChangeDescription={setDescription}
        noMatch={noMatch}
        onChangeNoMatch={setNoMatch}
        noKickboard={noKickboard}
        onChangeNoKickboard={setNoKickboard}
        campus={campus}
        onChangeCampus={setCampus}
        anyFeet={anyFeet}
        onChangeAnyFeet={setAnyFeet}
        anyFeetAvailable
        isDraft={isDraft}
        onChangeIsDraft={setIsDraft}
        sprayWallPublic={sprayWallPublic}
      />
    </StorySurface>
  );
}

const stories: StoryModule = {
  title: 'Connected apps / Notes for setters (#7387)',
  stories: {
    draftNote: {
      name: 'Save as draft on a board, partner apps on',
      render: () => (
        <StoryVariant label="Kilter board">
          <DraftForm boardName="kilter" />
        </StoryVariant>
      ),
    },
    wallDraftNote: {
      name: 'Save as draft on a public Spraywall, partner apps on',
      render: () => (
        <StoryVariant label="Public Spraywall">
          <DraftForm boardName="spray" sprayWallPublic />
        </StoryVariant>
      ),
    },
    draftNoteOff: {
      name: 'Save as draft, partner apps off (unchanged)',
      render: () => (
        <StoryVariant label="Kilter board">
          <DraftForm boardName="kilter" partnerAppsEnabled={false} />
        </StoryVariant>
      ),
    },
  },
};

export default stories;
