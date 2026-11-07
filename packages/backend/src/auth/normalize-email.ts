/** Identity policy only: preserve dots, plus suffixes and the complete mailbox. */
export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}
