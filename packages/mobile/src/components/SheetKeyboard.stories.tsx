import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import type { BottomSheet } from './sheet-presentation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { getBoardAngleOptions, getGradesForBoard } from '@boardsesh/board-config';
import { createInitialTickState, deriveAscentType } from '@boardsesh/play-view';
import type { StoryModule, StoryRenderControls } from '../dev/stories/types';
import { publishSheetKeyboardCalibration } from '../lib/sheet-keyboard-calibration-store';
import { LogAscentSheetView } from './LogAscentSheetView';
import { QuickTickBarView, type QuickTickBarProps } from './play-drawer/QuickTickBar';
import type { QuickTickForm } from './play-drawer/use-quick-tick-form';
import { SessionTitleSheetView } from './session-screen/SessionTitleSheetView';
import { CommentSheetView } from './you/CommentSheetView';

const noop = () => {};
const noContent = () => null;
const noTime = () => '';
const STORY_DATE = new Date('2026-11-15T17:00:00.000Z');
const angles = getBoardAngleOptions('kilter', false);
const grades = getGradesForBoard('kilter').map((grade) => ({
  difficultyId: grade.difficulty_id,
  name: grade.difficulty_name,
}));

function useKeyboardCalibration() {
  const insets = useSafeAreaInsets();
  const { calibration } = useLocalSearchParams<{ calibration?: string }>();
  useEffect(() => {
    publishSheetKeyboardCalibration({ enabled: calibration !== '0', windowTopInset: insets.top });
    return () => publishSheetKeyboardCalibration({ enabled: false, windowTopInset: insets.top });
  }, [calibration, insets.top]);
}

function TickKeyboardStory({ onReady }: StoryRenderControls) {
  const { t } = useTranslation('session');
  const [visible, setVisible] = useState(true);
  const [tickState, setTickState] = useState(createInitialTickState);
  const [comment, setComment] = useState('');
  const [angle, setAngle] = useState(40);
  const [climbedAt, setClimbedAt] = useState(STORY_DATE);
  const [climbedAtEdited, setClimbedAtEdited] = useState(false);
  const close = useCallback(() => setVisible(false), []);
  const ascentType = deriveAscentType(false, tickState.attemptCount);
  const form: QuickTickForm = {
    climbUuid: 'keyboard-story',
    boardName: 'kilter',
    angle,
    openingAngle: 40,
    tickState,
    comment,
    climbedAt,
    maximumClimbedAtDate: STORY_DATE,
    climbedAtEdited,
    grades,
    consensusDifficultyId: undefined,
    firstAscent: false,
    saveBlockedByGrade: false,
    resolvedGradeName: grades.find((grade) => grade.difficultyId === tickState.difficulty)?.name,
    ascentType,
    saveLabel: ascentType === 'flash' ? t('playView.tickBar.flashSaveLabel') : t('playView.tickBar.sendSaveLabel'),
    isPending: false,
    lastError: null,
    onQualitySelect: (quality) => setTickState((previous) => ({ ...previous, quality })),
    onAngleSelect: setAngle,
    onGradeSelect: (difficulty) => setTickState((previous) => ({ ...previous, difficulty })),
    onTriesSelect: (attemptCount) => setTickState((previous) => ({ ...previous, attemptCount })),
    onCommentChange: setComment,
    onClimbedAtChange: (date) => {
      setClimbedAt(date);
      setClimbedAtEdited(true);
    },
    onFutureAdjusted: noop,
    onSave: close,
    onAttempt: close,
  };
  const renderFields = (options: Omit<QuickTickBarProps, 'form'>) => (
    <QuickTickBarView {...options} form={form} angles={angles} />
  );
  useKeyboardCalibration();
  return (
    <LogAscentSheetView
      visible={visible}
      onClose={close}
      onPresented={onReady}
      climbName="Keyboard clearance"
      angle={40}
      baseAscensionistCount={0}
      form={form}
      renderFields={renderFields}
    />
  );
}

function TitleKeyboardStory({ onReady }: StoryRenderControls) {
  const [visible, setVisible] = useState(true);
  const [name, setName] = useState('Evening session');
  const close = useCallback(() => setVisible(false), []);
  useKeyboardCalibration();
  return (
    <SessionTitleSheetView
      visible={visible}
      name={name}
      onChangeName={setName}
      onClose={close}
      onSave={close}
      isPending={false}
      saveDisabled={false}
      errorMessage={null}
      onPresented={onReady}
    />
  );
}

function CommentKeyboardStory({ onReady }: StoryRenderControls) {
  const sheetRef = useRef<BottomSheet>(null);
  const [draft, setDraft] = useState('');
  useKeyboardCalibration();
  useEffect(() => {
    sheetRef.current?.snapToIndex(0);
  }, []);
  return (
    <CommentSheetView
      sheetRef={sheetRef}
      comments={[]}
      loading={false}
      canComment
      draft={draft}
      isPending={false}
      submitError={null}
      errorVisible={false}
      errorScope="keyboard-story"
      renderAvatar={noContent}
      renderAudienceControl={noContent}
      formatTime={noTime}
      onChangeDraft={setDraft}
      onSubmit={() => setDraft('')}
      onClose={noop}
      onPresented={onReady}
    />
  );
}

const stories: StoryModule = {
  title: 'Sheet keyboard',
  stories: {
    tick: {
      name: 'Tick note and pinned actions',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <TickKeyboardStory {...controls} />,
    },
    title: {
      name: 'Short session-title form',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <TitleKeyboardStory {...controls} />,
    },
    comment: {
      name: 'Pinned comment composer',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <CommentKeyboardStory {...controls} />,
    },
  },
};
export default stories;
