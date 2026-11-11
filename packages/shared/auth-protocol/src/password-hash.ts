/**
 * The bcrypt cost every new password hash is written at. Web and backend hash
 * through this one number.
 *
 * Keep it equal to the cost of ABSENT_PASSWORD_HASH below until every stored
 * hash has been rehashed. Stored hashes are never rehashed today, so raising
 * this alone leaves old accounts at the old cost while the comparison for an
 * unknown address stays at the new one, and the timing gap reopens.
 */
export const PASSWORD_HASH_COST = 12;

/**
 * What a sign-in compares the submitted password against when no stored
 * password belongs to the address. It must cost what the stored hashes cost: a
 * cheaper comparison answers sooner, and the gap tells a caller which addresses
 * have accounts (native sign-in answered in 50 ms here against 198 ms for a
 * wrong password while this was a cost-10 hash).
 *
 * Its cost follows the hashes already stored, not PASSWORD_HASH_COST, which
 * only governs new writes. It is the cost-12 hash of a discarded random string,
 * so no submitted password matches it.
 */
export const ABSENT_PASSWORD_HASH = '$2b$12$3qFGDie2IfjRh92IVzRFQeHL0ovw3iRwVMfkudP3XYTfMmfFrmUt6';
