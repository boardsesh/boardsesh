import { View } from 'react-native';
import { ClimbMenu } from './ClimbActionsMenu';
import type { ClimbListRowMenuProps } from './ClimbListRowMenu.types';

/** Android/browser and rows without an ellipsis retain their native menu. */
export function FallbackClimbListRowMenu(props: ClimbListRowMenuProps) {
  return (
    <>
      <ClimbMenu
        rows={props.rows}
        menuKey={props.menuKey}
        style={props.bodyStyle}
        liftPreview
        previewOverlayColor={props.previewOverlayColor}
      >
        {props.children}
      </ClimbMenu>
      {props.showMoreButton && props.rows.length > 0 ? (
        <View testID="climb-row-more-button" style={props.moreButtonStyle}>
          <ClimbMenu rows={props.rows} menuKey={props.menuKey} iconAppearance="plain" />
        </View>
      ) : null}
    </>
  );
}
