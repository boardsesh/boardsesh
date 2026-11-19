// The users email key and CHECK exactly as 0329_account_email_uniqueness creates
// them, for owner-only catalog drift in the credential writer proofs. The trim set
// is the 25 JavaScript String.prototype.trim code points.
const jsTrimCharacters = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;

export const addUsersEmailKey = 'CREATE UNIQUE INDEX users_email_lower_key ON public.users USING btree (lower(email))';
export const dropUsersEmailKey = 'DROP INDEX IF EXISTS public.users_email_lower_key';
export const addUsersEmailCheck = `ALTER TABLE public.users ADD CONSTRAINT users_email_normalized CHECK (email = pg_catalog.lower(pg_catalog.btrim(email, ${jsTrimCharacters})))`;
export const dropUsersEmailCheck = 'ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_email_normalized';
