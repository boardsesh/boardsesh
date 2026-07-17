export function createExpoWebStartArgs(port: number): string[] {
  return [
    'run',
    '--filter=@boardsesh/mobile',
    'start',
    '--',
    '--web',
    '--no-dev',
    // Expo public variables are inlined during Metro transforms, but Metro's
    // persisted transform cache does not vary with those values. A dev-server
    // restart may allocate a different backend port or Tailscale hostname, so
    // reuse could leave HTTP requests pointed at the previous session.
    '--clear',
    '--port',
    String(port),
    '--host',
    'localhost',
  ];
}
