// Exact generated0315 renewal relation, captured from an owned PostgreSQL catalog.
// Static source receipt only; runtime qualification still reads the actual catalog.
export default [
  {
    name: 'auth_browser_renewals',
    shape: {
      columns: [
        ['operation_hash', 'text', true, '', '', null],
        ['preparation_hash', 'text', true, '', '', null],
        ['nonce_hash', 'text', true, '', '', null],
        ['binding_id', 'text', true, '', '', null],
        ['binding_version', 'integer', true, '', '', null],
        ['intent_revision', 'integer', true, '', '', null],
        ['actor_credential_hash', 'text', true, '', '', null],
        ['user_id', 'text', true, '', '', null],
        ['auth_session_id', 'text', true, '', '', null],
        ['projection_id', 'text', true, '', '', null],
        ['normalizer_version', 'text', true, '', '', null],
        ['authority', 'text', true, '', '', null],
        ['epoch', 'integer', true, '', '', null],
        ['preparation', 'jsonb', true, '', '', null],
        ['metadata_hash', 'text', true, '', '', null],
        ['prepared_at', 'timestamp with time zone', true, '', '', null],
        ['expires_at', 'timestamp with time zone', true, '', '', null],
        ['candidate_hash', 'text', false, '', '', null],
        ['result_version', 'integer', false, '', '', null],
        ['completed_at', 'timestamp with time zone', false, '', '', null],
        ['acknowledge_until', 'timestamp with time zone', false, '', '', null],
      ],
      indexes: [
        'CREATE INDEX auth_browser_renewals_binding_idx ON public.auth_browser_renewals USING btree (binding_id, binding_version)',
        'CREATE INDEX auth_browser_renewals_expiry_idx ON public.auth_browser_renewals USING btree (expires_at)',
        'CREATE UNIQUE INDEX auth_browser_renewals_pkey ON public.auth_browser_renewals USING btree (operation_hash)',
      ],
      constraints: [
        "CHECK ((authority = ANY (ARRAY['current-store'::text, 'better-auth'::text])))",
        "CHECK (((expires_at > prepared_at) AND (expires_at <= (prepared_at + '00:01:00'::interval))))",
        "CHECK (((operation_hash ~ '^[a-f0-9]{64}$'::text) AND (preparation_hash ~ '^[a-f0-9]{64}$'::text) AND (nonce_hash ~ '^[a-f0-9]{64}$'::text) AND (binding_id ~ '^[a-f0-9]{64}$'::text) AND (actor_credential_hash ~ '^[a-f0-9]{64}$'::text) AND (metadata_hash ~ '^[a-f0-9]{64}$'::text)))",
        'PRIMARY KEY (operation_hash)',
        "CHECK ((((candidate_hash IS NULL) AND (result_version IS NULL) AND (completed_at IS NULL) AND (acknowledge_until IS NULL)) OR ((candidate_hash IS NOT NULL) AND (candidate_hash ~ '^[a-f0-9]{64}$'::text) AND (result_version IS NOT NULL) AND (result_version = (binding_version + 1)) AND (completed_at IS NOT NULL) AND (acknowledge_until IS NOT NULL) AND (acknowledge_until > completed_at) AND (acknowledge_until <= (completed_at + '00:05:00'::interval)))))",
        'CHECK (((binding_version >= 0) AND (intent_revision >= 0) AND (epoch > 0)))',
      ],
    },
  },
];
