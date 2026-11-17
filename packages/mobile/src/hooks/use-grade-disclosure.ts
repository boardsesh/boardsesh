import { useCallback, useRef, useState } from 'react';
import { useDeviceLayout } from './use-device-layout';

type GradeDisclosureOptions = {
  rowShown: boolean;
  onRowShownChange: (shown: boolean) => void;
  beforeOpenPopover: () => void;
};

/** The caller owns row persistence; an open iPad popover survives narrowing until dismissed. */
export function useGradeDisclosure(options: GradeDisclosureOptions) {
  const { isPad, widthClass } = useDeviceLayout();
  const isRegularWidthPad = isPad && widthClass === 'regular';
  const [popoverOpen, setPopoverOpen] = useState(false);
  const usesPopover = popoverOpen || isRegularWidthPad;
  const latestRef = useRef({ ...options, isRegularWidthPad, usesPopover });
  latestRef.current = { ...options, isRegularWidthPad, usesPopover };

  const dismissPopover = useCallback(() => setPopoverOpen(false), []);
  const open = useCallback(() => {
    const current = latestRef.current;
    if (current.isRegularWidthPad) {
      current.beforeOpenPopover();
      setPopoverOpen(true);
    } else {
      current.onRowShownChange(true);
    }
  }, []);
  const close = useCallback(() => {
    const current = latestRef.current;
    if (current.usesPopover) setPopoverOpen(false);
    else current.onRowShownChange(false);
  }, []);

  return {
    usesPopover,
    popoverOpen,
    open,
    close,
    dismissPopover,
    railOpen: usesPopover ? popoverOpen : options.rowShown,
  };
}
