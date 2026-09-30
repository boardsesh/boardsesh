// Metro turns bundled media into numeric asset ids.
declare module '*.wav' {
  const asset: number;
  export default asset;
}
