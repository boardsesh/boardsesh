// Metro resolves a static image import to an asset id (a number) at runtime.
// Declare the common asset extensions so `import img from './x.png'` type-checks:
// Expo's bundled types only cover CSS modules, and this project has no
// expo-env.d.ts pulling in `expo/types`.
declare module '*.png' {
  const asset: number;
  export default asset;
}
declare module '*.jpg' {
  const asset: number;
  export default asset;
}
declare module '*.jpeg' {
  const asset: number;
  export default asset;
}
declare module '*.webp' {
  const asset: number;
  export default asset;
}
declare module '*.gif' {
  const asset: number;
  export default asset;
}
