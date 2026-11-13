/** Code-owned public Expo-web qualification gate. Environment variables cannot
 * enable selected consumers before the complete browser contract is reviewed. */
export function publicExpoBrowserConsumersReady(): boolean {
  return false;
}
