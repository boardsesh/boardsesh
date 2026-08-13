'use client';

import React, { useState, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Chip from '@mui/material/Chip';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import AccessTimeOutlined from '@mui/icons-material/AccessTimeOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import WarningOutlined from '@mui/icons-material/WarningOutlined';
import { Trans, useTranslation } from 'react-i18next';
import type { ControllerInfo } from '@/app/api/internal/controllers/route';
import { getBoardSelectorOptions } from '@/app/lib/board-constants';
import type { BoardName } from '@/app/lib/types';
import styles from './controllers-section.module.css';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

// Get board config data (synchronous - from generated data)
const boardSelectorOptions = getBoardSelectorOptions();

type ControllerCardProps = {
  controller: ControllerInfo;
  onRemove: () => void;
  isRemoving: boolean;
};

function ControllerCard({ controller, onRemove, isRemoving }: ControllerCardProps) {
  const { t } = useTranslation('settings');
  const boardName = controller.boardName.charAt(0).toUpperCase() + controller.boardName.slice(1);

  const getStatusTag = () => {
    if (controller.isOnline) {
      return (
        <Chip icon={<CheckCircleOutlined />} label={t('controllers.status.online')} size="small" color="success" />
      );
    }
    if (controller.lastSeen) {
      return (
        <Chip icon={<AccessTimeOutlined />} label={t('controllers.status.offline')} size="small" color="default" />
      );
    }
    return <Chip label={t('controllers.status.neverConnected')} size="small" color="default" />;
  };

  const formatLastSeen = (dateString: string | null) => {
    if (!dateString) return t('controllers.status.never');
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return t('controllers.status.justNow');
    if (diffMinutes < 60) return t('controllers.status.minutesAgo', { count: diffMinutes });
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return t('controllers.status.hoursAgo', { count: diffHours });
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  return (
    <Card className={styles.controllerCard}>
      <CardContent>
        <div className={styles.cardHeader}>
          <Typography variant="h5" sx={{ margin: 0 }}>
            {controller.name || t('controllers.card.unnamed')}
          </Typography>
          {getStatusTag()}
        </div>
        <div className={styles.controllerInfo}>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('controllers.card.board')}
            </Typography>
            <Chip label={boardName} size="small" color="primary" />
          </div>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('controllers.card.layout')}
            </Typography>
            <Typography variant="body2" component="span">
              {t('controllers.card.layoutValue', { layoutId: controller.layoutId, sizeId: controller.sizeId })}
            </Typography>
          </div>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('controllers.card.lastSeen')}
            </Typography>
            <Typography variant="body2" component="span">
              {formatLastSeen(controller.lastSeen)}
            </Typography>
          </div>
        </div>
        <ConfirmPopover
          title={t('controllers.card.deleteConfirm.title')}
          description={t('controllers.card.deleteConfirm.description')}
          onConfirm={onRemove}
          okText={t('controllers.card.deleteConfirm.ok')}
          cancelText={t('controllers.card.deleteConfirm.cancel')}
          okButtonProps={{ color: 'error' }}
        >
          <Button
            color="error"
            variant="outlined"
            startIcon={isRemoving ? <CircularProgress size={16} /> : <DeleteOutlined />}
            disabled={isRemoving}
            fullWidth
          >
            {t('controllers.card.delete')}
          </Button>
        </ConfirmPopover>
      </CardContent>
    </Card>
  );
}

type ApiKeySuccessModalProps = {
  isOpen: boolean;
  apiKey: string;
  controllerName: string;
  onClose: () => void;
};

function ApiKeySuccessModal({ isOpen, apiKey, controllerName, onClose }: ApiKeySuccessModalProps) {
  const { t } = useTranslation('settings');
  const { showMessage } = useSnackbar();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      showMessage(t('controllers.apiKey.copySuccess'), 'success');
    } catch {
      showMessage(t('controllers.apiKey.copyError'), 'error');
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} disableEscapeKeyDown maxWidth="sm" fullWidth>
      <DialogTitle>{t('controllers.apiKey.title')}</DialogTitle>
      <DialogContent>
        <MuiAlert severity="warning" icon={<WarningOutlined />} sx={{ marginBottom: 2 }}>
          <AlertTitle>{t('controllers.apiKey.warningTitle')}</AlertTitle>
          {t('controllers.apiKey.warning')}
        </MuiAlert>
        <Typography variant="body1" component="p">
          <Trans
            i18nKey="controllers.apiKey.registered"
            t={t}
            values={{ name: controllerName || t('controllers.card.unnamed') }}
            components={{ strong: <strong /> }}
          />
        </Typography>
        <Typography variant="body1" component="p" color="text.secondary">
          {t('controllers.apiKey.instruction')}
        </Typography>
        <TextField
          value={apiKey}
          multiline
          rows={2}
          fullWidth
          variant="outlined"
          size="small"
          slotProps={{ input: { readOnly: true, style: { fontFamily: 'monospace' } } }}
          sx={{ marginBottom: 1 }}
        />
        <Button variant="outlined" startIcon={<ContentCopyOutlined />} onClick={handleCopy} fullWidth>
          {t('controllers.apiKey.copy')}
        </Button>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          {t('controllers.apiKey.done')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function ControllersSection() {
  const { t } = useTranslation('settings');
  const [controllers, setControllers] = useState<ControllerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({ name: '' });
  const { showMessage } = useSnackbar();

  // Board configuration selection state
  const [selectedBoard, setSelectedBoard] = useState<BoardName | undefined>(undefined);
  const [selectedLayout, setSelectedLayout] = useState<number | undefined>(undefined);
  const [selectedSize, setSelectedSize] = useState<number | undefined>(undefined);
  const [selectedSets, setSelectedSets] = useState<number[]>([]);

  // Derived data for dropdowns
  const layouts = useMemo(
    () => (selectedBoard ? boardSelectorOptions.layouts[selectedBoard] || [] : []),
    [selectedBoard],
  );

  const sizes = useMemo(
    () =>
      selectedBoard && selectedLayout ? boardSelectorOptions.sizes[`${selectedBoard}-${selectedLayout}`] || [] : [],
    [selectedBoard, selectedLayout],
  );

  const sets = useMemo(
    () =>
      selectedBoard && selectedLayout && selectedSize
        ? boardSelectorOptions.sets[`${selectedBoard}-${selectedLayout}-${selectedSize}`] || []
        : [],
    [selectedBoard, selectedLayout, selectedSize],
  );

  // Success state for showing API key
  const [successApiKey, setSuccessApiKey] = useState<string | null>(null);
  const [successControllerName, setSuccessControllerName] = useState('');

  const fetchControllers = async () => {
    try {
      const response = await fetch('/api/internal/controllers');
      if (response.ok) {
        const data = await response.json();
        setControllers(data.controllers);
      }
    } catch (error) {
      console.error('Failed to fetch controllers:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchControllers();
  }, []);

  const handleAddClick = () => {
    setFormValues({ name: '' });
    setSelectedBoard(undefined);
    setSelectedLayout(undefined);
    setSelectedSize(undefined);
    setSelectedSets([]);
    setIsModalOpen(true);
  };

  const handleModalCancel = () => {
    setIsModalOpen(false);
    setFormValues({ name: '' });
    setSelectedBoard(undefined);
    setSelectedLayout(undefined);
    setSelectedSize(undefined);
    setSelectedSets([]);
  };

  const handleBoardChange = (value: BoardName) => {
    setSelectedBoard(value);
    setSelectedLayout(undefined);
    setSelectedSize(undefined);
    setSelectedSets([]);
  };

  const handleLayoutChange = (value: number) => {
    setSelectedLayout(value);
    setSelectedSize(undefined);
    setSelectedSets([]);
  };

  const handleSizeChange = (value: number) => {
    setSelectedSize(value);
    // Auto-select all sets when size is selected
    const availableSets =
      selectedBoard && selectedLayout
        ? boardSelectorOptions.sets[`${selectedBoard}-${selectedLayout}-${value}`] || []
        : [];
    const allSetIds = availableSets.map((set) => set.id);
    setSelectedSets(allSetIds);
  };

  const handleSetsChange = (value: number[]) => {
    setSelectedSets(value);
  };

  const handleRegister = async (values: {
    name?: string;
    boardName: BoardName;
    layoutId: number;
    sizeId: number;
    setIds: number[];
  }) => {
    setIsSaving(true);
    try {
      const response = await fetch('/api/internal/controllers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          boardName: values.boardName,
          layoutId: values.layoutId,
          sizeId: values.sizeId,
          setIds: Array.isArray(values.setIds) ? values.setIds.join(',') : values.setIds,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('controllers.register.registerError'));
      }

      const data = await response.json();

      // Close the registration modal
      setIsModalOpen(false);
      setFormValues({ name: '' });

      // Show the API key success modal
      setSuccessApiKey(data.apiKey);
      setSuccessControllerName(values.name || '');

      await fetchControllers();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('controllers.register.registerError'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async (controllerId: string) => {
    setRemovingId(controllerId);
    try {
      const response = await fetch('/api/internal/controllers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controllerId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('controllers.deleteError'));
      }

      showMessage(t('controllers.deleteSuccess'), 'success');
      await fetchControllers();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('controllers.deleteError'), 'error');
    } finally {
      setRemovingId(null);
    }
  };

  const handleSuccessClose = () => {
    setSuccessApiKey(null);
    setSuccessControllerName('');
  };

  if (loading) {
    return (
      <Card>
        <CardContent>
          <div className={styles.loadingContainer}>
            <CircularProgress />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent>
          <Typography variant="h5">{t('controllers.title')}</Typography>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.sectionDescription}>
            {t('controllers.subtitle')}
          </Typography>

          {controllers.length === 0 ? (
            <div className={styles.emptyState}>
              <Typography variant="body2" component="span" color="text.secondary">
                {t('controllers.empty')}
              </Typography>
            </div>
          ) : (
            <Stack spacing={2} className={styles.cardsContainer}>
              {controllers.map((controller) => (
                <ControllerCard
                  key={controller.id}
                  controller={controller}
                  onRemove={() => handleRemove(controller.id)}
                  isRemoving={removingId === controller.id}
                />
              ))}
            </Stack>
          )}

          <Button
            variant="contained"
            startIcon={<AddOutlined />}
            onClick={handleAddClick}
            fullWidth
            className={styles.addButton}
          >
            {t('controllers.add')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={isModalOpen} onClose={handleModalCancel} maxWidth="sm" fullWidth>
        <DialogTitle>{t('controllers.register.title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.modalDescription}>
            {t('controllers.register.description')}
          </Typography>
          <Box
            component="form"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              if (!selectedBoard || !selectedLayout || !selectedSize || selectedSets.length === 0) return;
              void handleRegister({
                name: formValues.name,
                boardName: selectedBoard,
                layoutId: selectedLayout,
                sizeId: selectedSize,
                setIds: selectedSets,
              });
            }}
            sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}
          >
            <TextField
              label={t('controllers.register.nameLabel')}
              placeholder={t('controllers.register.namePlaceholder')}
              variant="outlined"
              size="small"
              fullWidth
              value={formValues.name}
              onChange={(e) => setFormValues((prev) => ({ ...prev, name: e.target.value }))}
              inputProps={{ maxLength: 100 }}
            />

            <FormControl fullWidth required>
              <InputLabel>{t('controllers.register.boardLabel')}</InputLabel>
              <MuiSelect
                value={selectedBoard || ''}
                label={t('controllers.register.boardLabel')}
                onChange={(e) => handleBoardChange(e.target.value)}
              >
                {/* i18n-ignore-next-line -- brand name, not translated */}
                <MenuItem value="kilter">Kilter</MenuItem>
                {/* i18n-ignore-next-line -- brand name, not translated */}
                <MenuItem value="tension">Tension</MenuItem>
              </MuiSelect>
            </FormControl>

            <FormControl fullWidth required disabled={!selectedBoard}>
              <InputLabel>{t('controllers.register.layoutLabel')}</InputLabel>
              <MuiSelect
                value={selectedLayout ?? ''}
                label={t('controllers.register.layoutLabel')}
                onChange={(e) => handleLayoutChange(e.target.value)}
              >
                {layouts.map(({ id, name }) => (
                  <MenuItem key={id} value={id}>
                    {name}
                  </MenuItem>
                ))}
              </MuiSelect>
            </FormControl>

            <FormControl fullWidth required disabled={!selectedLayout}>
              <InputLabel>{t('controllers.register.sizeLabel')}</InputLabel>
              <MuiSelect
                value={selectedSize ?? ''}
                label={t('controllers.register.sizeLabel')}
                onChange={(e) => handleSizeChange(e.target.value)}
              >
                {sizes.map(({ id, name, description }) => (
                  <MenuItem key={id} value={id}>
                    {name} {description}
                  </MenuItem>
                ))}
              </MuiSelect>
            </FormControl>

            <FormControl fullWidth required disabled={!selectedSize}>
              <InputLabel>{t('controllers.register.setsLabel')}</InputLabel>
              <MuiSelect
                multiple
                value={selectedSets}
                label={t('controllers.register.setsLabel')}
                onChange={(e) => handleSetsChange(e.target.value as number[])}
              >
                {sets.map(({ id, name }) => (
                  <MenuItem key={id} value={id}>
                    {name}
                  </MenuItem>
                ))}
              </MuiSelect>
            </FormControl>

            <Button
              variant="contained"
              type="submit"
              disabled={isSaving}
              startIcon={isSaving ? <CircularProgress size={16} /> : undefined}
              fullWidth
            >
              {isSaving ? t('controllers.register.submitting') : t('controllers.register.submit')}
            </Button>
          </Box>
        </DialogContent>
      </Dialog>

      <ApiKeySuccessModal
        isOpen={!!successApiKey}
        apiKey={successApiKey || ''}
        controllerName={successControllerName}
        onClose={handleSuccessClose}
      />
    </>
  );
}
