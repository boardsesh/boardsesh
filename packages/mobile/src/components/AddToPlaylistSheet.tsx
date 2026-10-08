import { useMemo, useRef, type ComponentType } from 'react';
import { type FlatListProps } from 'react-native';
import { BottomSheetTextInput, BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';
import { ModalSheet } from './ModalSheet';
import { ClimbPreviewCard } from './ClimbPreviewCard';
import { InlinePlaylistPicker, type PickerTextInputProps } from './playlist/InlinePlaylistPicker';
import { useDeviceLayout } from '../hooks/use-device-layout';
import { AddToPlaylistPopover } from './playlist/AddToPlaylistPopover';
import type { WindowAnchorPoint } from './navigation/AnchoredPopover.types';

type AddToPlaylistSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  /** Actual control location in native-window coordinates. */
  anchorPoint?: WindowAnchorPoint;
  /** Request an animated close (pan-down). */
  onClose: () => void;
  /** Fired once the dismiss animation has settled — safe to unmount/clear.
   * Optional: always-mounted hosts don't unmount, so they may omit it. */
  onFullyDismissed?: () => void;
};

// The native bottom-sheet text input pushes the sheet up for the keyboard; the
// reaction overlay injects the plain RN TextInput instead. Both satisfy the
// picker's narrowed text-input contract — a single, honest cast (BottomSheetTextInput
// carries extra bottom-sheet-only props but accepts everything the picker drives).
const SheetTextInput = BottomSheetTextInput as ComponentType<PickerTextInputProps>;
// The bottom-sheet-aware list scrolls within the native sheet detent (its
// virtualization plugs into the sheet's gesture handling); the reaction overlay
// uses the picker's default RN FlatList.
const SheetFlatList = BottomSheetFlatList as ComponentType<FlatListProps<Playlist>>;

/**
 * The swipe/ellipsis "Add to playlist" surface. Since #3167 native sheets can't
 * stack, so both the playlist list AND the create-new form live INLINE in this
 * one sheet (`InlinePlaylistPicker`) — no nested sheet to be dismissed on
 * present. The reaction overlay reuses the same picker without a sheet at all.
 */
function AddToPlaylistSheet({
  visible,
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  anchorPoint,
  onClose,
  onFullyDismissed,
}: AddToPlaylistSheetProps) {
  const snapPoints = useMemo(() => ['50%', '90%'], []);
  const { isPad, widthClass } = useDeviceLayout();
  const presentation = useRef({ visible: false, climbUuid: climb?.uuid, popover: false, anchorPoint });
  if (visible && (!presentation.current.visible || presentation.current.climbUuid !== climb?.uuid)) {
    presentation.current = {
      visible,
      climbUuid: climb?.uuid,
      popover: isPad && widthClass === 'regular' && !!anchorPoint,
      anchorPoint,
    };
  } else {
    presentation.current.visible = visible;
  }

  if (presentation.current.popover && presentation.current.anchorPoint && climb) {
    // Keep this native Host mounted when closed. Expo's popover binding reports
    // dismissal intent, not animation completion; clearing deferred data there
    // would destroy its presenting controller during the native transition.
    return (
      <AddToPlaylistPopover
        visible={visible}
        climb={climb}
        boardName={boardName}
        layoutId={layoutId}
        sizeId={sizeId}
        setIds={setIds}
        angle={angle}
        anchorPoint={presentation.current.anchorPoint}
        onClose={onClose}
      />
    );
  }

  return (
    <ModalSheet
      visible={visible && !!climb}
      snapPoints={snapPoints}
      onClose={onClose}
      onFullyDismissed={onFullyDismissed}
      enablePanDownToClose
    >
      {climb && (
        <>
          <ClimbPreviewCard
            climb={climb}
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            angle={angle}
          />
          {/* The picker's own BottomSheetFlatList scrolls with the sheet, so the
              sheet itself isn't `scrollable` (no nested scroll views). */}
          <InlinePlaylistPicker
            climb={climb}
            angle={angle}
            boardName={boardName}
            layoutId={layoutId}
            TextInputComponent={SheetTextInput}
            ListComponent={SheetFlatList}
          />
        </>
      )}
    </ModalSheet>
  );
}

export { AddToPlaylistSheet };
