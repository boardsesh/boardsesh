'use client';

import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './direction-picker.module.css';

type DirectionPickerProps = {
  value: number | null;
  onChange: (direction: number) => void;
  disabled?: boolean;
  size?: number;
};

/**
 * Circular direction picker component
 * Allows users to select a direction of pull (0-360 degrees)
 * 0 = up, 90 = right, 180 = down, 270 = left
 */
const DirectionPicker: React.FC<DirectionPickerProps> = ({ value, onChange, disabled = false, size = 120 }) => {
  const { t } = useTranslation('climbs');
  const circleRef = useRef<SVGSVGElement>(null);

  const calculateAngleFromEvent = useCallback((clientX: number, clientY: number) => {
    if (!circleRef.current) return null;

    const rect = circleRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;

    // Calculate angle in radians, then convert to degrees
    // atan2 gives angle from positive X axis, counterclockwise
    // We want 0 = up, 90 = right, so we need to adjust
    let angle = Math.atan2(deltaX, -deltaY) * (180 / Math.PI);

    // Normalize to 0-360
    if (angle < 0) {
      angle += 360;
    }

    return Math.round(angle);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (disabled) return;

      const angle = calculateAngleFromEvent(e.clientX, e.clientY);
      if (angle !== null) {
        onChange(angle);
      }
    },
    [disabled, calculateAngleFromEvent, onChange],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (disabled || e.buttons !== 1) return;

      const angle = calculateAngleFromEvent(e.clientX, e.clientY);
      if (angle !== null) {
        onChange(angle);
      }
    },
    [disabled, calculateAngleFromEvent, onChange],
  );

  const center = size / 2;
  const radius = size / 2 - 10;
  const arrowLength = radius - 10;

  // Calculate arrow end point based on angle
  // 0 degrees = up, so we start from -90 in standard math coordinates
  const angleRad = value !== null ? ((value - 90) * Math.PI) / 180 : null;
  const arrowEndX = angleRad !== null ? center + Math.cos(angleRad) * arrowLength : center;
  const arrowEndY = angleRad !== null ? center + Math.sin(angleRad) * arrowLength : center - arrowLength;

  // Arrow head points
  const arrowHeadSize = 10;
  const arrowHeadAngle = 25 * (Math.PI / 180);

  let arrowHead1X = arrowEndX;
  let arrowHead1Y = arrowEndY;
  let arrowHead2X = arrowEndX;
  let arrowHead2Y = arrowEndY;

  if (angleRad !== null) {
    arrowHead1X = arrowEndX - arrowHeadSize * Math.cos(angleRad - arrowHeadAngle);
    arrowHead1Y = arrowEndY - arrowHeadSize * Math.sin(angleRad - arrowHeadAngle);
    arrowHead2X = arrowEndX - arrowHeadSize * Math.cos(angleRad + arrowHeadAngle);
    arrowHead2Y = arrowEndY - arrowHeadSize * Math.sin(angleRad + arrowHeadAngle);
  }

  return (
    <div className={styles.container}>
      <svg
        ref={circleRef}
        width={size}
        height={size}
        className={`${styles.picker} ${disabled ? styles.disabled : ''}`}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        style={{ touchAction: 'none' }}
      >
        {/* Outer circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="var(--neutral-50)"
          stroke="var(--neutral-300)"
          strokeWidth={2}
        />

        {/* Direction indicators */}
        <text x={center} y={12} textAnchor="middle" className={styles.label}>
          Up
        </text>
        <text x={size - 8} y={center + 4} textAnchor="end" className={styles.label}>
          R
        </text>
        <text x={center} y={size - 4} textAnchor="middle" className={styles.label}>
          {t('directionPicker.down')}
        </text>
        <text x={8} y={center + 4} textAnchor="start" className={styles.label}>
          L
        </text>

        {/* Center dot */}
        <circle cx={center} cy={center} r={4} fill="var(--neutral-400)" />

        {/* Arrow line */}
        {value !== null && (
          <>
            <line
              x1={center}
              y1={center}
              x2={arrowEndX}
              y2={arrowEndY}
              style={{ stroke: 'var(--color-primary)' }}
              strokeWidth={3}
              strokeLinecap="round"
            />
            {/* Arrow head */}
            <polygon
              points={`${arrowEndX},${arrowEndY} ${arrowHead1X},${arrowHead1Y} ${arrowHead2X},${arrowHead2Y}`}
              style={{ fill: 'var(--color-primary)' }}
            />
          </>
        )}

        {/* Clickable overlay */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="transparent"
          style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
      </svg>

      {value !== null && <div className={styles.angleDisplay}>{value}°</div>}
    </div>
  );
};

export default DirectionPicker;
