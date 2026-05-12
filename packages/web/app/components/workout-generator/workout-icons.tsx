'use client';

import React from 'react';

// SVG icons for workout types matching the iOS app style

type IconProps = {
  size?: number;
  color?: string;
};

export const VolumeIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 18L7 14L11 16L21 6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="3" cy="18" r="1.5" fill={color} />
    <circle cx="21" cy="6" r="1.5" fill={color} />
  </svg>
);

export const PyramidIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 18L8 10L12 4L16 10L21 18" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="3" cy="18" r="1.5" fill={color} />
    <circle cx="8" cy="10" r="1.5" fill={color} />
    <circle cx="12" cy="4" r="1.5" fill={color} />
    <circle cx="16" cy="10" r="1.5" fill={color} />
    <circle cx="21" cy="18" r="1.5" fill={color} />
  </svg>
);

export const LadderIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3 20L7 15L11 12L15 9L19 6L21 4"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="3" cy="20" r="1.5" fill={color} />
    <circle cx="7" cy="15" r="1.5" fill={color} />
    <circle cx="11" cy="12" r="1.5" fill={color} />
    <circle cx="15" cy="9" r="1.5" fill={color} />
    <circle cx="19" cy="6" r="1.5" fill={color} />
  </svg>
);

export const GradeFocusIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 12H21" stroke={color} strokeWidth="2" strokeLinecap="round" />
    <circle cx="6" cy="12" r="1.5" fill={color} />
    <circle cx="12" cy="12" r="1.5" fill={color} />
    <circle cx="18" cy="12" r="1.5" fill={color} />
  </svg>
);

export const getWorkoutIcon = (type: 'volume' | 'pyramid' | 'ladder' | 'focus', props?: IconProps) => {
  switch (type) {
    case 'volume':
      return <VolumeIcon {...props} />;
    case 'pyramid':
      return <PyramidIcon {...props} />;
    case 'ladder':
      return <LadderIcon {...props} />;
    case 'focus':
      return <GradeFocusIcon {...props} />;
    default:
      return <VolumeIcon {...props} />;
  }
};
