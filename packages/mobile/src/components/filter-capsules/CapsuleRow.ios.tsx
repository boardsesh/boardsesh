// CapsuleRow, iOS: one <Host> wrapping a horizontal SwiftUI ScrollView + HStack
// of native @expo/ui controls, so every menu is a real iOS menu. Liquid Glass
// capsules on iOS 26, bordered ones below it (capsule-style.ios.ts). Each
// capsule descriptor maps to one control:
//   sheet      → Button (label + optional SF Symbol)
//   rail       → Button with a trailing chevron (up while the rail is shown);
//                with `popover`, the Button is a Popover trigger (regular-width iPad)
//   menu       → Menu + Picker ('picker') or Menu of Buttons with a checkmark
//                ('commands'); `actions` after a Divider
//   toggle     → Button with the toggle accessibility traits
//   toggleMenu → Menu with onPrimaryAction: tap runs `onPress`, a long-press opens
//                the actions. (A Button + onLongPressGesture doesn't work: the
//                button's own tap gesture swallows the long-press inside the
//                scroll row.)
// The Android counterpart is CapsuleRow.android.tsx; the descriptor types are in
// CapsuleRow.types.ts.

import { memo, useMemo, type ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Host,
  HStack,
  ScrollView,
  Menu,
  Picker,
  Button,
  Text,
  Image,
  Divider,
  Popover,
  RNHostView,
} from '@expo/ui/swift-ui';
import {
  tag,
  padding,
  fixedSize,
  accessibilityHint,
  accessibilityHidden,
  accessibilityLabel,
  accessibilityAddTraits,
} from '@expo/ui/swift-ui/modifiers';
import { useGlassCapability } from '../../hooks/use-glass-capability';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { capsuleModifiers, type CapsuleStyleContext } from './capsule-style.ios';
import { isCapsuleActive } from './CapsuleRow.logic';
import type {
  Capsule,
  CapsuleIcon,
  CapsuleMenuAction,
  CapsuleRowProps,
  MenuCapsule,
  RailCapsule,
} from './CapsuleRow.types';

// The rail chevron, in points. Small beside a `controlSize('small')` label; it
// needs an explicit size because @expo/ui gives an Image without one a 24pt font.
const CHEVRON_SIZE = 12;

// The SF Symbol union the Button `systemImage` prop accepts. Mapped from the
// semantic CapsuleIcon here, then narrowed at the single call site (the symbol
// union isn't resolvable from the shared types module; see MoreForm.ios).
type SystemImageName = NonNullable<ComponentProps<typeof Button>['systemImage']>;

const SF_SYMBOL: Record<CapsuleIcon, string> = {
  filters: 'line.3.horizontal.decrease',
  recent: 'clock.arrow.circlepath',
  locked: 'lock.fill',
  lock: 'lock',
  unlock: 'lock.open',
};

function systemImageFor(icon: CapsuleIcon | undefined): SystemImageName | undefined {
  return icon ? (SF_SYMBOL[icon] as SystemImageName) : undefined;
}

function ActionButton({ action }: { action: CapsuleMenuAction }) {
  return (
    <Button
      label={action.label}
      systemImage={systemImageFor(action.icon)}
      role={action.destructive ? 'destructive' : undefined}
      onPress={action.onPress}
    />
  );
}

function MenuActions({ actions }: { actions: readonly CapsuleMenuAction[] | undefined }) {
  if (!actions || actions.length === 0) return null;
  return (
    <>
      <Divider />
      {actions.map((action) => (
        <ActionButton key={action.key} action={action} />
      ))}
    </>
  );
}

function MenuControl({ capsule, look }: { capsule: MenuCapsule; look: CapsuleStyleContext }) {
  const { options, selected, onSelect } = capsule;
  return (
    <Menu
      label={capsule.label}
      systemImage={capsule.icon ? SF_SYMBOL[capsule.icon] : undefined}
      modifiers={capsuleModifiers(capsule.active, look)}
    >
      {capsule.optionStyle === 'commands' ? (
        options.map((option) => (
          <Button
            key={option.value}
            label={option.label}
            systemImage={option.value === selected ? 'checkmark' : undefined}
            onPress={() => onSelect(option.value)}
          />
        ))
      ) : (
        <Picker
          selection={selected}
          onSelectionChange={(value) => {
            // The Picker hands back its selection as an untyped tag; ours are
            // always strings, so guard rather than blind-cast. The caller narrows
            // the string to its own value type.
            if (typeof value !== 'string') return;
            onSelect(value);
          }}
        >
          {options.map((option) => (
            <Text key={option.value} modifiers={[tag(option.value)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
      )}
      <MenuActions actions={capsule.actions} />
    </Menu>
  );
}

function RailControl({ capsule, look }: { capsule: RailCapsule; look: CapsuleStyleContext }) {
  const { popover } = capsule;
  // No colour on the chevron: it takes the button's own, so it stays legible on
  // the filled active capsule. VoiceOver skips the glyph and reads the hint.
  const chip = (
    <Button
      onPress={capsule.onPress}
      modifiers={
        capsule.accessibilityHint
          ? [...capsuleModifiers(capsule.active, look), accessibilityHint(capsule.accessibilityHint)]
          : capsuleModifiers(capsule.active, look)
      }
    >
      <HStack spacing={spacing[1]}>
        <Text>{capsule.label}</Text>
        <Image
          systemName={capsule.expanded ? 'chevron.up' : 'chevron.down'}
          size={CHEVRON_SIZE}
          modifiers={[accessibilityHidden()]}
        />
      </HStack>
    </Button>
  );
  if (!popover) return chip;
  return (
    <Popover
      isPresented={capsule.expanded}
      attachmentAnchor="bottom"
      arrowEdge="top"
      onIsPresentedChange={(presented) => {
        if (!presented) popover.onDismiss();
      }}
    >
      <Popover.Trigger>{chip}</Popover.Trigger>
      <Popover.Content>
        <RNHostView matchContents>
          <View style={styles.popover}>{popover.content}</View>
        </RNHostView>
      </Popover.Content>
    </Popover>
  );
}

function CapsuleControl({ capsule, look }: { capsule: Capsule; look: CapsuleStyleContext }) {
  switch (capsule.kind) {
    case 'sheet': {
      const styleModifiers = capsuleModifiers(isCapsuleActive(capsule), look);
      return (
        <Button
          label={capsule.label}
          systemImage={systemImageFor(capsule.icon)}
          onPress={capsule.onPress}
          modifiers={
            capsule.accessibilityLabel
              ? [...styleModifiers, accessibilityLabel(capsule.accessibilityLabel)]
              : styleModifiers
          }
        />
      );
    }
    case 'rail':
      return <RailControl capsule={capsule} look={look} />;
    case 'menu':
      return <MenuControl capsule={capsule} look={look} />;
    case 'toggle':
      // `isToggle` + `isSelected` makes VoiceOver read the capsule as a toggle
      // button that is on or off (iOS 17+; older iOS ignores `isToggle`).
      return (
        <Button
          label={capsule.label}
          onPress={capsule.onPress}
          modifiers={[
            ...capsuleModifiers(capsule.active, look),
            accessibilityAddTraits(capsule.active ? ['isToggle', 'isSelected'] : ['isToggle']),
          ]}
        />
      );
    case 'toggleMenu':
      return (
        <Menu
          label={capsule.label}
          systemImage={capsule.icon ? SF_SYMBOL[capsule.icon] : undefined}
          onPrimaryAction={capsule.onPress}
          modifiers={capsuleModifiers(capsule.active, look)}
        >
          {capsule.actions.map((action) => (
            <ActionButton key={action.key} action={action} />
          ))}
        </Menu>
      );
  }
}

function CapsuleRowComponent({ capsules }: CapsuleRowProps) {
  const { brandColors } = useTheme();
  const supportsGlass = useGlassCapability();
  const look = useMemo<CapsuleStyleContext>(() => ({ brandColors, supportsGlass }), [brandColors, supportsGlass]);
  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ScrollView axes="horizontal" showsIndicators={false}>
        {/* Vertical slack lets a pressed capsule's Liquid Glass lens expand without the host's fixed height clipping it.
            `fixedSize(horizontal)` is what keeps the labels whole: a horizontal ScrollView still proposes its own
            (screen) width to the content, so without it the HStack squeezes every capsule toward its minimum and the
            labels truncate ("Filter…", "Colle…") even though the row overflows and scrolls anyway (#3782). Sizing the
            stack to its ideal width lets each capsule take the space its label needs and the ScrollView scroll. */}
        <HStack
          spacing={spacing[2]}
          modifiers={[
            padding({ horizontal: spacing[4], vertical: spacing[2] }),
            fixedSize({ horizontal: true, vertical: false }),
          ]}
        >
          {capsules.map((capsule) => (
            <CapsuleControl key={capsule.key} capsule={capsule} look={look} />
          ))}
        </HStack>
      </ScrollView>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
    // A hosting view can paint a system background; on a plain toolbar that
    // shows as an opaque band. The row always sits on its container's surface
    // (or the floating chrome's blur), so keep the Host see-through.
    backgroundColor: 'transparent',
  },
  // The rail draws no frame of its own, so the popover gives it the room above
  // and below its chips; the rail's own insets handle the sides.
  popover: { width: 400, paddingVertical: spacing[2] },
});

export const CapsuleRow = memo(CapsuleRowComponent);
