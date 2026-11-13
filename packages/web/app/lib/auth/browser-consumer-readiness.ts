/** Only a reviewed code change can enable public selected-browser readers.
 * Bootstrap, rolling publication, recovery and consumer QA remain open. */
export function publicBrowserConsumersReady(): boolean {
  return false;
}
