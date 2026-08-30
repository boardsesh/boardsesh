import { OutlineEditorPickerScreen } from '../../../src/components/outline-editor/OutlineEditorPickerScreen';
import { OutlineEditorGate } from '../../../src/components/outline-editor/OutlineEditorGate';

export default function OutlineEditorRoute() {
  return (
    <OutlineEditorGate>
      <OutlineEditorPickerScreen />
    </OutlineEditorGate>
  );
}
