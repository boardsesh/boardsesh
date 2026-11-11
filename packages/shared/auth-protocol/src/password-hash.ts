/**
 * The bcrypt cost every stored password hash is written at. Web and backend
 * hash and compare through this one number so the sign-in comparison below
 * cannot fall out of step with the hashes it stands in for.
 */
export const PASSWORD_HASH_COST = 12;

/**
 * What a sign-in compares the submitted password against when no stored
 * password belongs to the address. It must cost what a stored hash costs: a
 * cheaper comparison answers sooner, and the gap tells a caller which addresses
 * have accounts (native sign-in answered in 50 ms here against 198 ms for a
 * wrong password while this was a cost-10 hash).
 *
 * bcrypt reads the cost from the string itself, so the cost field comes from
 * PASSWORD_HASH_COST. The salt and digest are those of a discarded random
 * string hashed at cost 12; no submitted password matches them at any cost.
 */
export const ABSENT_PASSWORD_HASH = `$2b$${String(PASSWORD_HASH_COST).padStart(2, '0')}$3qFGDie2IfjRh92IVzRFQeHL0ovw3iRwVMfkudP3XYTfMmfFrmUt6`;
