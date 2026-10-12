// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import { usePrivacyCredentialScope, usePrivacyScopedState } from '../../../hooks/use-privacy-scoped-state';
import { invalidatePrivacySnapshots } from '../../../lib/privacy/privacy-cache';
import { sanitizeClimbTarget } from '../../../lib/queue-privacy';
import { PlayCoreSheetHosts, type PlayCoreSheetHostsProps } from '../PlayCoreSheetHosts';

vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new-queue-item' }));

const recorded = vi.hoisted(() => ({
  props: new Map<string, Record<string, unknown>>(),
  mounts: vi.fn<(name: string) => void>(),
  unmounts: vi.fn<(name: string) => void>(),
}));

function SheetStub({ name, ...props }: Record<string, unknown> & { name: string }) {
  const [draft, setDraft] = useState('');
  recorded.props.set(name, props);
  useEffect(() => {
    recorded.mounts(name);
    return () => recorded.unmounts(name);
  }, [name]);
  return <input aria-label={name} value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

vi.mock('../PlayDrawerSectionsSheet', () => ({
  PlayDrawerSectionsSheet: (props: Record<string, unknown>) => <SheetStub name="sections" {...props} />,
}));
vi.mock('../../ClimbActionsSheet', () => ({
  ClimbActionsSheet: (props: Record<string, unknown>) => <SheetStub name="actions" {...props} />,
}));
vi.mock('../../AddBetaVideoSheet', () => ({
  AddBetaVideoSheet: (props: Record<string, unknown>) => <SheetStub name="beta" {...props} />,
}));
vi.mock('../logbook/LogbookFullSheet', () => ({
  LogbookFullSheet: (props: Record<string, unknown>) => <SheetStub name="logbook" {...props} />,
}));
vi.mock('../ClimberLogsSheet', () => ({
  ClimberLogsSheet: (props: Record<string, unknown>) => <SheetStub name="climbers" {...props} />,
}));
vi.mock('../../report-climb/ReportClimbSheet', () => ({
  ReportClimbSheet: (props: Record<string, unknown>) => <SheetStub name="report" {...props} />,
}));
vi.mock('../AngleSelectorSheet', () => ({
  AngleSelectorSheet: (props: Record<string, unknown>) => <SheetStub name="angle" {...props} />,
}));
vi.mock('../../LogAscentSheet', () => ({
  LogAscentSheet: (props: Record<string, unknown>) => <SheetStub name="tick" {...props} />,
}));
vi.mock('../../ble/BleControlSheetHost', () => ({
  BleControlSheetHost: (props: Record<string, unknown>) => <SheetStub name="ble" {...props} />,
}));

const pinnedClimb: Climb = {
  uuid: 'pinned-climb',
  name: 'Pinned climb',
  setter_username: 'setter',
  frames: 'p1r1',
  angle: 35,
  ascensionist_count: 20,
  difficulty: '6b',
  quality_average: '3',
  stars: 3,
  difficulty_error: '0',
  benchmark_difficulty: null,
};
const activeBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
const pinnedBoard = { boardName: 'tension', layoutId: 2, sizeId: 20, setIds: '2', angle: 35 };
const noAction = () => {};

function props(open: boolean): PlayCoreSheetHostsProps {
  return {
    displayedClimb: { ...pinnedClimb, uuid: 'current-climb', name: 'Current climb' },
    ...activeBoard,
    boardConfig: activeBoard,
    activeAngle: 40,
    climbBoardMismatch: false,
    sectionsSettingsOpen: open,
    climbActionsVisible: open,
    addBetaVideoOpen: open,
    fullLogbookClimbUuid: open ? pinnedClimb.uuid : null,
    climberLogsOpen: open,
    reportClimbOpen: open,
    angleSelectorVisible: open,
    isTickBarActive: open,
    bleControlVisible: open,
    composerCredentialScope: 0,
    betaVideoTarget: null,
    reportTarget: null,
    tickTarget: null,
    currentUserId: 'viewer',
    isAuthenticated: true,
    moderationEnabled: true,
    showConnectPill: true,
    displayedClimbIsDraft: false,
    isMirrored: true,
    boardseshActive: false,
    sessionId: 'session',
    addToQueue: vi.fn(),
    dismissPlayerAndWait: undefined,
    onAngleChange: vi.fn(),
    handleCloseSectionsSettings: noAction,
    handleToggleFavoriteFromMenu: noAction,
    handleOpenAddBetaVideo: noAction,
    handleOpenReportClimb: noAction,
    openQueueFromActions: noAction,
    handleShare: noAction,
    handleDismiss: noAction,
    handleCloseSubDrawer: noAction,
    handleCloseAddBetaVideo: noAction,
    handleCloseFullLogbook: noAction,
    handleCloseClimberLogs: noAction,
    handleOpenClimberProfile: noAction,
    handleCloseReportClimb: noAction,
    handleTickBarDismiss: noAction,
    handleCloseBleControl: noAction,
  };
}

function ScopedHosts({ open }: { open: boolean }) {
  const [target] = usePrivacyScopedState({ climb: pinnedClimb, boardConfig: pinnedBoard }, sanitizeClimbTarget);
  const credentialScope = usePrivacyCredentialScope();
  return (
    <PlayCoreSheetHosts
      {...props(open)}
      composerCredentialScope={credentialScope}
      betaVideoTarget={target}
      reportTarget={target}
      tickTarget={target}
    />
  );
}

beforeEach(() => {
  recorded.props.clear();
  recorded.mounts.mockClear();
  recorded.unmounts.mockClear();
});

describe('PlayCoreSheetHosts lifetime and ownership', () => {
  it('mounts no sheets on opening, then retains all nine hosts through closing and reopening', () => {
    const { container, rerender, getByLabelText, unmount } = render(<PlayCoreSheetHosts {...props(false)} />);
    expect(container.childElementCount).toBe(0);
    expect(recorded.mounts).not.toHaveBeenCalled();
    rerender(<PlayCoreSheetHosts {...props(true)} />);
    expect(recorded.mounts).toHaveBeenCalledTimes(9);
    const inputs = [...container.children];
    fireEvent.change(getByLabelText('tick'), { target: { value: 'Keep my draft' } });
    rerender(<PlayCoreSheetHosts {...props(false)} />);
    expect([...container.children]).toEqual(inputs);
    expect([...recorded.props.values()].every((sheet) => sheet.visible === false)).toBe(true);
    expect(recorded.unmounts).not.toHaveBeenCalled();
    rerender(<PlayCoreSheetHosts {...props(true)} />);
    expect(getByLabelText('tick')).toHaveProperty('value', 'Keep my draft');
    expect(recorded.mounts).toHaveBeenCalledTimes(9);
    unmount();
    expect(recorded.unmounts).toHaveBeenCalledTimes(9);
  });

  it('withdraws pinned metadata without remounting drafts, but remounts only composers for new credentials', () => {
    const { container, getByLabelText, rerender } = render(<ScopedHosts open />);
    const originalInputs = [...container.children];
    for (const name of ['beta', 'report', 'tick']) {
      fireEvent.change(getByLabelText(name), { target: { value: `Draft ${name}` } });
      expect(recorded.props.get(name)).toMatchObject({ climb: pinnedClimb, boardName: 'tension', angle: 35 });
    }
    rerender(<ScopedHosts open={false} />);
    act(() => invalidatePrivacySnapshots());
    expect([...container.children]).toEqual(originalInputs);
    for (const name of ['beta', 'report', 'tick']) {
      expect(getByLabelText(name)).toHaveProperty('value', `Draft ${name}`);
      expect(recorded.props.get(name)).toMatchObject({
        climb: { uuid: 'pinned-climb', name: '', frames: '' },
        boardName: 'tension',
        angle: 35,
      });
    }
    expect(recorded.unmounts).not.toHaveBeenCalled();
    act(() => invalidatePrivacySnapshots('credential'));
    expect(recorded.unmounts.mock.calls.map(([name]) => name).sort()).toEqual(['beta', 'report', 'tick']);
    expect(recorded.mounts).toHaveBeenCalledTimes(12);
    for (const name of ['beta', 'report', 'tick']) expect(getByLabelText(name)).toHaveProperty('value', '');
    expect(recorded.props.get('tick')).toMatchObject({ climbUuid: 'current-climb', boardName: 'kilter' });
  });

  it('keeps angle stats on the active board while composer inputs use their pinned boards', () => {
    const onAngleChange = vi.fn();
    const close = vi.fn();
    render(
      <PlayCoreSheetHosts
        {...props(true)}
        climbBoardMismatch
        onAngleChange={onAngleChange}
        handleCloseSubDrawer={close}
        tickTarget={{ climb: pinnedClimb, boardConfig: pinnedBoard }}
      />,
    );
    expect(recorded.props.get('angle')).toMatchObject({
      boardName: 'kilter',
      layoutId: 1,
      currentAngle: 40,
      climbUuid: undefined,
    });
    expect(recorded.props.get('tick')).toMatchObject({
      boardName: 'tension',
      layoutId: 2,
      sizeId: 20,
      setIds: '2',
      angle: 35,
      isMirror: true,
      sessionId: 'session',
    });
    const angleChange = recorded.props.get('angle')?.onAngleChange as (angle: number) => void;
    angleChange(45);
    expect(onAngleChange).toHaveBeenCalledWith(45);
    expect(close).toHaveBeenCalledOnce();
  });
});
