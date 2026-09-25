export class FollowedAuthorsUnavailableError extends Error {
  constructor() {
    super('Followed authors need an online sync');
    this.name = 'FollowedAuthorsUnavailableError';
  }
}
