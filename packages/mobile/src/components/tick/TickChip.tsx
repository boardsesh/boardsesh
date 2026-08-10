// The tick sheets' chip: GradeChip with the `selection` colourway baked in.
//
// A wrapper rather than a second chip implementation, so the tries rail gets the
// exact geometry (44pt target, 22pt radius, tabular label) the grade rail has,
// and so the filter rails' chips — and their tests — keep the grade ramp
// untouched.
import React from 'react';
import { GradeChip, type GradeChipProps } from '../grade/GradeChip';

export type TickChipProps = Omit<GradeChipProps, 'colorway' | 'gradeColor'>;

export const TickChip = React.memo(function TickChip(props: TickChipProps) {
  return <GradeChip {...props} colorway="selection" />;
});
