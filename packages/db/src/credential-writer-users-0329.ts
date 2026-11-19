// Exact canonical0329 users relation: 0329_account_email_uniqueness adds the
// case-insensitive unique key and the validated stored-form email CHECK (the 25
// JavaScript trim code points, which PostgreSQL prints as raw characters).
// Reviewed static source receipt; never a runtime catalog attestation.
// Canonical profiles use it in place of the historical0312 users shape that
// private-web-v1 and private-browser-v1 keep in credential-writer-private-web-v1.ts.
export default [
  {
    name: 'users',
    shape: {
      columns: [
        ['id', 'text', true, '', '', null],
        ['name', 'text', false, '', '', null],
        ['email', 'text', true, '', '', null],
        ['emailVerified', 'timestamp without time zone', false, '', '', null],
        ['image', 'text', false, '', '', null],
        ['created_at', 'timestamp without time zone', true, '', '', 'now()'],
        ['updated_at', 'timestamp without time zone', true, '', '', 'now()'],
      ],
      indexes: [
        'CREATE UNIQUE INDEX users_email_lower_key ON public.users USING btree (lower(email))',
        'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
      ],
      constraints: [
        "CHECK ((email = lower(btrim(email, '\t\n\v\f\r                  　﻿'::text))))",
        'PRIMARY KEY (id)',
      ],
    },
  },
];
