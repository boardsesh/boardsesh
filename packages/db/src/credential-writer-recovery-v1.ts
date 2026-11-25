/** Exact additive reset ledger; no historical profile accepts this capability implicitly. */
export default [
  {
    name: 'auth_pre_enforcement_password_reset_events',
    shape: {
      columns: [
        ['operation_id', 'uuid', true, '', '', null],
        ['user_id', 'text', true, '', '', null],
        ['previous_generation', 'integer', true, '', '', null],
        ['generation', 'integer', true, '', '', null],
        ['kind', 'text', true, '', '', null],
        ['domains', 'text[]', true, '', '', null],
        ['context_phase', 'text', true, '', '', null],
        ['prepared_projection_id', 'text', false, '', '', null],
        ['prepared_writer_epoch', 'integer', false, '', '', null],
        ['revoked_through', 'timestamp with time zone', true, '', '', null],
        ['recorded_at', 'timestamp with time zone', true, '', '', null],
      ],
      indexes: [
        'CREATE UNIQUE INDEX auth_pre_enforcement_password_reset_events_generation_idx ON public.auth_pre_enforcement_password_reset_events USING btree (user_id, generation)',
        'CREATE UNIQUE INDEX auth_pre_enforcement_password_reset_events_pkey ON public.auth_pre_enforcement_password_reset_events USING btree (operation_id)',
      ],
      constraints: [
        "CHECK ((((context_phase = 'absent'::text) AND (prepared_projection_id IS NULL) AND (prepared_writer_epoch IS NULL)) OR ((context_phase = 'prepared'::text) AND (prepared_projection_id IS NOT NULL) AND (length(prepared_projection_id) > 0) AND (prepared_writer_epoch IS NOT NULL) AND (prepared_writer_epoch > 0))))",
        "CHECK ((domains = ARRAY['first-party'::text, 'partner'::text]))",
        'CHECK (((previous_generation >= 0) AND (generation = (previous_generation + 1))))',
        "CHECK ((kind = 'password-reset'::text))",
        'PRIMARY KEY (operation_id)',
      ],
    },
  },
];
