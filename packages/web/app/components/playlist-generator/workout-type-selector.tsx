'use client';

import React from 'react';
import MuiList from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { ChevronRightOutlined } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { type WorkoutType, WORKOUT_TYPES } from './types';
import { getWorkoutIcon } from './workout-icons';
import styles from './workout-type-selector.module.css';

type WorkoutTypeSelectorProps = {
  onSelect: (type: WorkoutType) => void;
};

const WorkoutTypeSelector: React.FC<WorkoutTypeSelectorProps> = ({ onSelect }) => {
  const { t } = useTranslation('playlists');
  const theme = useTheme();
  return (
    <div className={styles.container}>
      <MuiList>
        {WORKOUT_TYPES.map((item) => (
          <ListItemButton key={item.type} className={styles.listItem} onClick={() => onSelect(item.type)}>
            <div className={styles.itemContent}>
              <div className={styles.iconWrapper}>
                {getWorkoutIcon(item.icon, { size: 28, color: theme.palette.primary.main })}
              </div>
              <div className={styles.textContent}>
                <Typography variant="body2" component="span" fontWeight={600} className={styles.title}>
                  {t(`generator.workoutTypes.${item.type}.name`)}
                </Typography>
                <Typography variant="body2" component="span" color="text.secondary" className={styles.description}>
                  {t(`generator.workoutTypes.${item.type}.description`)}
                </Typography>
              </div>
            </div>
            <ChevronRightOutlined className={styles.arrow} />
          </ListItemButton>
        ))}
      </MuiList>
    </div>
  );
};

export default WorkoutTypeSelector;
