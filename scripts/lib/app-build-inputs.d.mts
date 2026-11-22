export type NativeAppInputScope = 'preview' | 'production';

export function isNativeAppAffecting(filePath: string, scope?: NativeAppInputScope): boolean;
export function nativeAppAffectingPaths(filePaths: Iterable<string>, scope?: NativeAppInputScope): string[];
export function hasNativeAppAffectingChanges(filePaths: Iterable<string>, scope?: NativeAppInputScope): boolean;
export function isBrowserAppAffecting(filePath: string): boolean;
export function browserAppAffectingPaths(filePaths: Iterable<string>): string[];
export function hasBrowserAppAffectingChanges(filePaths: Iterable<string>): boolean;
