import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GetPartnerAppsEnabledResponse } from '@boardsesh/graphql/operations/connected-apps';
import type { StoryModule } from '../../dev/stories/types';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import { PARTNER_APPS_ENABLED_QUERY_KEY } from '../../lib/graphql/hooks/use-connected-apps';
import { CreateDrawerForm } from '../create-climb/CreateDrawerForm';

/**
 * Seeds the cached `partnerAppsEnabled` answer before anything below reads it,
 * so a story shows the notes as climbers see them with partner apps on or off,
 * whatever the server behind the simulator says.
 */
function PartnerApps({ on, children }: { on: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  useState(() =>
    queryClient.setQueryData<GetPartnerAppsEnabledResponse>(PARTNER_APPS_ENABLED_QUERY_KEY, { partnerAppsEnabled: on }),
  );
  return <>{children}</>;
}

/** The create-climb form below the board, its switches live, as a setter sees it. */
function DraftForm({ boardName, sprayWallPublic = false }: { boardName: string; sprayWallPublic?: boolean }) {
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
        <PartnerApps on>
          <StoryVariant label="Kilter board">
            <DraftForm boardName="kilter" />
          </StoryVariant>
        </PartnerApps>
      ),
    },
    wallDraftNote: {
      name: 'Save as draft on a public Spraywall, partner apps on',
      render: () => (
        <PartnerApps on>
          <StoryVariant label="Public Spraywall">
            <DraftForm boardName="spray" sprayWallPublic />
          </StoryVariant>
        </PartnerApps>
      ),
    },
    draftNoteOff: {
      name: 'Save as draft, partner apps off (unchanged)',
      render: () => (
        <PartnerApps on={false}>
          <StoryVariant label="Kilter board">
            <DraftForm boardName="kilter" />
          </StoryVariant>
        </PartnerApps>
      ),
    },
  },
};

export default stories;
