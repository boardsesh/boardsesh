import { formatGrade } from '@boardsesh/play-view';
import { useCallback, useRef, useState, type ComponentProps } from 'react';
import { View } from 'react-native';
import { SessionRecapCardView } from '../../components/session/SessionRecapCardView';
import { SessionSummaryView } from '../../components/session/SessionSummaryView';
import { GradeTileView } from '../../components/session/session-stat-tile-views';
import { AvatarGroup } from '../../components/you/AvatarGroup';
import { StoryBoard } from '../stories/StoryBoard';
import type { StoryRenderControls } from '../stories/types';
import { STORY_CLIMBS } from './climbs';

const ignoreError = () => {};
const formatStoryGrade = (grade: string | null | undefined, board?: string | null) =>
  formatGrade(grade, 'v-grade', board);
type SummaryStoryProps = Pick<
  ComponentProps<typeof SessionSummaryView>,
  'summary' | 'workout' | 'pendingTicks' | 'offline' | 'initiallyExpandedStageId'
> &
  Partial<StoryRenderControls>;
export function SessionSummaryStory({ summary, onReady, onError = ignoreError, ...props }: SummaryStoryProps) {
  const readiness = useRef({ animation: false, art: !summary.hardestClimb });
  const report = useCallback(() => {
    if (readiness.current.animation && readiness.current.art) onReady?.();
  }, [onReady]);
  const onPresented = useCallback(() => {
    readiness.current.animation = true;
    report();
  }, [report]);
  const onArtReady = useCallback(() => {
    readiness.current.art = true;
    report();
  }, [report]);
  const [notes, setNotes] = useState(summary.notes ?? '');
  const [draft, setDraft] = useState(notes);
  const [editing, setEditing] = useState(false);
  const renderRecap = useCallback(
    (onEditorFocus: () => void) => (
      <SessionRecapCardView
        displayedNotes={notes}
        editable
        isEditing={editing}
        draft={draft}
        pending={false}
        error={false}
        onChangeDraft={setDraft}
        onEdit={() => {
          setDraft(notes);
          setEditing(true);
        }}
        onCancel={() => setEditing(false)}
        onSave={() => {
          setNotes(draft.trim());
          setEditing(false);
        }}
        onEditorFocus={onEditorFocus}
      />
    ),
    [notes, editing, draft],
  );
  const hardest = summary.hardestClimb;
  return (
    <SessionSummaryView
      {...props}
      summary={summary}
      formatGrade={formatStoryGrade}
      sessionWhen="Monday morning"
      onPresented={onPresented}
      thumbnail={
        hardest ? (
          <View style={{ width: 64, height: 82 }}>
            <StoryBoard climb={STORY_CLIMBS[0]} onReady={onArtReady} onError={onError} />
          </View>
        ) : undefined
      }
      renderRecap={renderRecap}
      avatars={<AvatarGroup participants={summary.participants} interactive={false} size={36} />}
      gradeTile={
        hardest ? (
          <GradeTileView
            grade={hardest.grade}
            displayGrade={formatStoryGrade(hardest.grade, hardest.boardType) ?? hardest.grade}
          />
        ) : undefined
      }
    />
  );
}
