// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import { usePrivacyCredentialScope, usePrivacyScopedState } from '../../../hooks/use-privacy-scoped-state';
import { invalidateCredentialSnapshots } from '../../../lib/privacy/privacy-cache';
import { PlayCoreSheetHosts, type PlayCoreSheetHostsProps } from '../PlayCoreSheetHosts';

vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));

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
vi.mock('../../AddBetaVideoSheet', () => ({
  AddBetaVideoSheet: (props: Record<string, unknown>) => <SheetStub name="beta" {...props} />,
}));
vi.mock('../../AddToPlaylistSheet', () => ({
  AddToPlaylistSheet: (props: Record<string, unknown>) => <SheetStub name="playlist" {...props} />,
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
    sectionsListActiveHolds: false,
    buttonsPreviewBoard: { supportsMirroring: false, angleAvailable: true, angle: 40, showLightbulb: true },
    addBetaVideoOpen: open,
    addToPlaylistOpen: open,
    fullLogbookClimbUuid: open ? pinnedClimb.uuid : null,
    climberLogsOpen: open,
    reportClimbOpen: open,
    angleSelectorVisible: open,
    isTickBarActive: open,
    bleControlVisible: open,
    composerCredentialScope: 0,
    betaVideoTarget: null,
    playlistTarget: null,
    reportTarget: null,
    tickTarget: null,
    isMirrored: true,
    boardseshActive: false,
    sessionId: 'session',
    onAngleChange: vi.fn(),
    handleCloseSectionsSettings: noAction,
    handleCloseSubDrawer: noAction,
    handleCloseAddBetaVideo: noAction,
    handleCloseAddToPlaylist: noAction,
    handleCloseFullLogbook: noAction,
    handleCloseClimberLogs: noAction,
    handleOpenClimberProfile: noAction,
    handleCloseReportClimb: noAction,
    handleTickBarDismiss: noAction,
    handleCloseBleControl: noAction,
  };
}

function ScopedHosts({ open }: { open: boolean }) {
  const [target] = usePrivacyScopedState({ climb: pinnedClimb, boardConfig: pinnedBoard });
  const credentialScope = usePrivacyCredentialScope();
  return (
    <PlayCoreSheetHosts
      {...props(open)}
      composerCredentialScope={credentialScope}
      betaVideoTarget={target}
      playlistTarget={target}
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
    // Sections, beta, playlist, logbook, climber logs, report, angle, tick, BLE.
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

  it('remounts only composers for new credentials', () => {
    const { getByLabelText, rerender } = render(<ScopedHosts open />);
    for (const name of ['beta', 'playlist', 'report', 'tick']) {
      fireEvent.change(getByLabelText(name), { target: { value: `Draft ${name}` } });
      expect(recorded.props.get(name)).toMatchObject({ climb: pinnedClimb, boardName: 'tension', angle: 35 });
    }
    rerender(<ScopedHosts open={false} />);
    act(() => invalidateCredentialSnapshots());
    expect(recorded.unmounts.mock.calls.map(([name]) => name).sort()).toEqual(['beta', 'playlist', 'report', 'tick']);
    expect(recorded.mounts).toHaveBeenCalledTimes(13);
    for (const name of ['beta', 'playlist', 'report', 'tick']) {
      expect(getByLabelText(name)).toHaveProperty('value', '');
    }
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

  // ⋯ → Add to playlist opens THIS host, inside the player, so the picker
  // presents above `/play`; the root one lands under it (#3294).
  it('hosts the playlist picker in the player, on the climb and board ⋯ was opened for', () => {
    const close = vi.fn();
    render(
      <PlayCoreSheetHosts
        {...props(true)}
        handleCloseAddToPlaylist={close}
        playlistTarget={{ climb: pinnedClimb, boardConfig: pinnedBoard }}
      />,
    );
    expect(recorded.props.get('playlist')).toMatchObject({
      visible: true,
      climb: pinnedClimb,
      boardName: 'tension',
      layoutId: 2,
      sizeId: 20,
      setIds: '2',
      angle: 35,
      onClose: close,
    });
  });
});
