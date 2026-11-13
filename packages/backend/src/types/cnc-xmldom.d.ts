/// <reference types="cnc-xmldom" />

// Upstream declares its canonical ambient module name even when installed by alias.
// Re-export those exact types for the isolated CNC dependency.
declare module 'cnc-xmldom' {
  export * from '@xmldom/xmldom';
}
