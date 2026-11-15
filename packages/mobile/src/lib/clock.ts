/** Application time. Presentation fixtures inject their own timestamps into views. */
export function nowMs(): number {
  return Date.now();
}

export function nowDate(): Date {
  return new Date(nowMs());
}
