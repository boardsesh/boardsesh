export const isCapacitor = (): boolean =>
  typeof window !== 'undefined' && window.Capacitor !== undefined;

export const isNativeApp = (): boolean =>
  isCapacitor() && window.Capacitor?.isNativePlatform?.() === true;

export const hasCapacitorPlugin = (pluginName: string): boolean =>
  typeof window !== 'undefined' &&
  window.Capacitor?.Plugins?.[pluginName] !== undefined;

export const getPlatform = (): 'ios' | 'android' | 'web' => {
  if (!isCapacitor()) return 'web';
  const platform = window.Capacitor?.getPlatform?.();
  if (platform === 'ios' || platform === 'android') return platform;
  return 'web';
};
