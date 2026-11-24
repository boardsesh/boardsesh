/** Exact current capture schema; historical capability receipts stay immutable. */
export default [
  {
    name: 'auth_password_change_evidence',
    shape: {
      columns: [
        ['user_id', 'text', true, '', '', null],
        ['password_fingerprint', 'text', true, '', '', null],
        ['changed_at', 'timestamp with time zone', true, '', '', null],
      ],
      indexes: [
        'CREATE UNIQUE INDEX auth_password_change_evidence_pkey ON public.auth_password_change_evidence USING btree (user_id)',
      ],
      constraints: [
        "CHECK ((password_fingerprint ~ '^[0-9a-f]{64}$'::text))",
        'PRIMARY KEY (user_id)',
        'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      ],
    },
  },
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
      indexes: ['CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'],
      constraints: ['PRIMARY KEY (id)'],
    },
  },
];
