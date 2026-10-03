// Distinct hash seeds keep token ownership and delivery serialization separate
// from the spray wall's integer-key write lock namespace.
export const NOTIFICATION_DEVICE_TOKEN_LOCK_SEED = 192704;
export const NOTIFICATION_DELIVERY_LOCK_SEED = 192705;
