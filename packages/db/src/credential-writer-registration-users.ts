/**
 * Current registration profile's exact users shape. This starts at current main
 * before BA-02 uniqueness. Its reviewed upgrade belongs with the uniqueness
 * change; historical private-web/browser receipts must never accept both.
 */
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
      indexes: ['CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)'],
      constraints: ['PRIMARY KEY (id)'],
    },
  },
];
