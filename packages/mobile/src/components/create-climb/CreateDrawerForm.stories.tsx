import { useState } from 'react';
import type { StoryModule } from '../../dev/stories/types';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import { CreateDrawerForm } from './CreateDrawerForm';

/** The form below the board, with its switches live, as a setter sees it. */
function FormStory({ boardName }: { boardName: string }) {
  const [description, setDescription] = useState('');
  const [noMatch, setNoMatch] = useState(false);
  const [noKickboard, setNoKickboard] = useState(false);
  const [campus, setCampus] = useState(false);
  const [anyFeet, setAnyFeet] = useState(false);
  const [isDraft, setIsDraft] = useState(true);
  return (
    <StorySurface>
      <CreateDrawerForm
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
      />
    </StorySurface>
  );
}

const stories: StoryModule = {
  title: 'Create climb / Form',
  stories: {
    draftNote: {
      name: 'Save as draft on a board',
      render: () => (
        <StoryVariant label="Kilter board">
          <FormStory boardName="kilter" />
        </StoryVariant>
      ),
    },
    wallDraftNote: {
      name: 'Save as draft on a Spraywall',
      render: () => (
        <StoryVariant label="Spraywall">
          <FormStory boardName="spray" />
        </StoryVariant>
      ),
    },
  },
};

export default stories;
