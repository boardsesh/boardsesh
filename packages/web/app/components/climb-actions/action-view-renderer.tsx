'use client';

import React from 'react';
import MuiButton from '@mui/material/Button';
import { ActionTooltip } from './action-tooltip';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbActionsViewMode, ClimbActionSize, ClimbActionResult, ClimbActionMenuItem, ClimbActionType } from './types';

/**
 * Computed display properties shared across all action components.
 */
export function computeActionDisplay(
  viewMode: ClimbActionsViewMode,
  size: ClimbActionSize = 'default',
  showLabel?: boolean,
) {
  return {
    shouldShowLabel: showLabel ?? (viewMode === 'button' || viewMode === 'dropdown'),
    iconSize: size === 'small' ? 14 : size === 'large' ? 20 : 16,
  };
}

/**
 * Standard icon element for action components (icon mode).
 * Wraps content in ActionTooltip with a clickable span.
 */
export function ActionIconElement({
  tooltip,
  onClick,
  className,
  children,
  extraContent,
}: {
  tooltip: string;
  onClick: (e?: React.MouseEvent) => void;
  className?: string;
  children: React.ReactNode;
  extraContent?: React.ReactNode;
}) {
  return (
    <>
      <ActionTooltip title={tooltip}>
        <span onClick={onClick} style={{ cursor: 'pointer' }} className={className}>
          {children}
        </span>
      </ActionTooltip>
      {extraContent}
    </>
  );
}

/**
 * Standard button element for action components (button/compact mode).
 */
export function ActionButtonElement({
  icon,
  label,
  showLabel,
  onClick,
  disabled,
  size = 'default',
  className,
  variant = 'outlined',
  extraContent,
}: {
  icon: React.ReactNode;
  label: string;
  showLabel: boolean;
  onClick: (e?: React.MouseEvent) => void;
  disabled?: boolean;
  size?: ClimbActionSize;
  className?: string;
  variant?: 'outlined' | 'contained' | 'text';
  extraContent?: React.ReactNode;
}) {
  return (
    <>
      <MuiButton
        variant={variant}
        startIcon={icon}
        onClick={onClick}
        disabled={disabled}
        size={size === 'large' ? 'large' : 'small'}
        className={className}
      >
        {showLabel && label}
      </MuiButton>
      {extraContent}
    </>
  );
}

/**
 * Shared sx styles for list-mode action buttons.
 * Used by ActionListElement and Link-wrapped action variants.
 */
export const listElementSx = {
  height: 48,
  justifyContent: 'flex-start',
  paddingLeft: `${themeTokens.spacing[4]}px`,
  fontSize: themeTokens.typography.fontSize.base,
  color: 'text.primary',
  '& .MuiButton-startIcon': {
    color: 'text.secondary',
  },
  '&:hover': {
    backgroundColor: 'action.hover',
  },
} as const;

/**
 * Standard list element for action components (list mode / drawer menus).
 * All actions share identical styling for list mode.
 */
export function ActionListElement({
  icon,
  label,
  onClick,
  disabled,
  extraContent,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: (e?: React.MouseEvent) => void;
  disabled?: boolean;
  extraContent?: React.ReactNode;
}) {
  return (
    <>
      <MuiButton
        variant="text"
        startIcon={icon}
        fullWidth
        onClick={onClick}
        disabled={disabled}
        sx={listElementSx}
      >
        {label}
      </MuiButton>
      {extraContent}
    </>
  );
}

/**
 * Resolves which element to display based on the current view mode.
 * Eliminates the repeated switch statement across all action components.
 */
export function resolveActionViewMode(
  viewMode: ClimbActionsViewMode,
  elements: {
    iconElement: React.ReactNode;
    buttonElement: React.ReactNode;
    listElement: React.ReactNode;
    dropdownElement?: React.ReactNode;
  },
): React.ReactNode {
  switch (viewMode) {
    case 'icon':
      return elements.iconElement;
    case 'button':
    case 'compact':
      return elements.buttonElement;
    case 'list':
      return elements.listElement;
    case 'dropdown':
      return elements.dropdownElement ?? null;
    default:
      return elements.iconElement;
  }
}

/**
 * Builds a complete ClimbActionResult using shared rendering utilities.
 * This is the primary consolidation function - actions provide their specific
 * icon, label, onClick handler, and any custom overrides, and this function
 * generates the standard icon/button/list/dropdown elements.
 */
export function buildActionResult({
  key,
  label,
  icon,
  onClick,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  available = true,
  extraContent,
  tooltipTitle,
  menuItem: menuItemOverride,
  // Allow full custom element overrides when the standard rendering doesn't fit
  iconElementOverride,
  buttonElementOverride,
  listElementOverride,
  dropdownElementOverride,
  expandedContent,
}: {
  key: ClimbActionType;
  label: string;
  icon: React.ReactNode;
  onClick: (e?: React.MouseEvent) => void;
  viewMode: ClimbActionsViewMode;
  size?: ClimbActionSize;
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
  available?: boolean;
  extraContent?: React.ReactNode;
  tooltipTitle?: string;
  menuItem?: ClimbActionMenuItem;
  iconElementOverride?: React.ReactNode;
  buttonElementOverride?: React.ReactNode;
  listElementOverride?: React.ReactNode;
  dropdownElementOverride?: React.ReactNode;
  expandedContent?: React.ReactNode;
}): ClimbActionResult {
  const { shouldShowLabel } = computeActionDisplay(viewMode, size, showLabel);

  const iconElement = iconElementOverride ?? (
    <ActionIconElement
      tooltip={tooltipTitle ?? label}
      onClick={onClick}
      className={className}
      extraContent={extraContent}
    >
      {icon}
    </ActionIconElement>
  );

  const buttonElement = buttonElementOverride ?? (
    <ActionButtonElement
      icon={icon}
      label={label}
      showLabel={shouldShowLabel}
      onClick={onClick}
      disabled={disabled}
      size={size}
      className={className}
      extraContent={extraContent}
    />
  );

  const listElement = listElementOverride ?? (
    <ActionListElement
      icon={icon}
      label={label}
      onClick={onClick}
      disabled={disabled}
      extraContent={extraContent}
    />
  );

  const menuItem: ClimbActionMenuItem = menuItemOverride ?? {
    key,
    label,
    icon,
    onClick: () => onClick(),
  };

  const element = resolveActionViewMode(viewMode, {
    iconElement,
    buttonElement,
    listElement,
    dropdownElement: dropdownElementOverride ?? extraContent ?? null,
  });

  return {
    element,
    menuItem,
    key,
    available,
    expandedContent,
  };
}

/**
 * Builds a ClimbActionResult for an unavailable action.
 * Use this when an action should not be displayed (e.g., feature not supported for this board).
 */
export function buildUnavailableResult(key: ClimbActionType): ClimbActionResult {
  return {
    element: null,
    menuItem: { key },
    key,
    available: false,
  };
}
