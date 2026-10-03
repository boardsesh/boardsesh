// Reserved notification hash seeds: keep stable across deployments and assign
// new notification lock domains an unused seed here. These use PostgreSQL's
// single-bigint advisory lock space; the wall's two-integer space is separate.
export const NOTIFICATION_DEVICE_TOKEN_LOCK_SEED = 192704;
export const NOTIFICATION_DELIVERY_LOCK_SEED = 192705;
