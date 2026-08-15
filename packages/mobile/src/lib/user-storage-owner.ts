export type UserStorageOwner = {
  userId: string;
  authSessionId: string;
};

/** Browser persistence is login-scoped; native keeps its established device keys. */
export function setCurrentUserStorageOwner(_owner: UserStorageOwner | null): void {}

/** Native storage is device-scoped, so there is no owner key to capture. */
export function getCurrentUserStorageOwner(): UserStorageOwner | null {
  return null;
}
