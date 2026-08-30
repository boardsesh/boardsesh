import { useLocalSearchParams } from 'expo-router';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import { OutlineCanvasScreen } from '../../../src/components/outline-editor/OutlineCanvasScreen';
import { OutlineEditorGate } from '../../../src/components/outline-editor/OutlineEditorGate';
import { OutlineEditorMessage } from '../../../src/components/outline-editor/OutlineEditorMessage';

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
};

function isBoardName(value: string | undefined): value is BoardName {
  return value != null && (SUPPORTED_BOARDS as readonly string[]).includes(value);
}

export default function OutlineCanvasRoute() {
  const params = useLocalSearchParams<Params>();
  const layoutId = Number(params.layoutId ?? NaN);
  const sizeId = Number(params.sizeId ?? NaN);

  // A hand-built deep link can land here with anything in the query string, so
  // validate before handing the config to the geometry lookup.
  const paramsAreValid = isBoardName(params.boardName) && Number.isFinite(layoutId) && Number.isFinite(sizeId);

  return (
    <OutlineEditorGate>
      {paramsAreValid && isBoardName(params.boardName) ? (
        <OutlineCanvasScreen
          boardName={params.boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={params.setIds ?? ''}
        />
      ) : (
        // i18n-ignore-next-line — admin-only screen
        <OutlineEditorMessage message="That link doesn't name a board configuration. Pick one from the editor list." />
      )}
    </OutlineEditorGate>
  );
}
