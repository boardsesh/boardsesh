// The browser build has no app cache directory: a rendered photo is a blob or
// data URL that the page releases when it is no longer referenced.
export function discardLocalPhoto(_uri: string | null | undefined): void {}
