# Homelab worker deploys

How a new `boardsesh-worker` image goes from a merge on `main` to running on
the homelab, and what to do when it doesn't.

## What triggers a deploy

`background-worker-image.yml` builds and pushes
`ghcr.io/boardsesh/boardsesh-worker:sha-<sha>` on every `push` to `main` that
touches a worker input. See the workflow's `paths:` filter for the exact list
(`packages/backend`, `packages/db`, the `*-sync` packages, `Dockerfile.worker`,
and a few others). Once that build finishes, its `dispatch-homelab` job sends
a `repository_dispatch` event to the private `marcodejongh/blackheathdc-ansible`
repo with the new image's digest. A workflow there, running on the homelab's
own runner, receives that event and deploys the digest to the two worker VMs.
Nothing on the monorepo side ever touches the homelab network directly.

A pull request build never dispatches. `dispatch-homelab` only runs on `push`
to `main`.

There is also no manual redeploy trigger from this repo. The workflow keeps
`workflow_dispatch` for the `image` job (so a maintainer can rebuild the image
by hand), but `dispatch-homelab` is deliberately excluded from that trigger:
its `if:` only matches `push`. A manual redeploy of a given digest happens on
the ansible side instead, by `workflow_dispatch` there (see "Rolling back a
bad deploy" below).

Re-running an old workflow run on `main` (GitHub's "Re-run all jobs") rebuilds
and dispatches the digest for whatever commit that run was originally for,
not the current tip of `main`. If that commit is older than what's already
deployed, the ansible receiver checks the commit ordering and refuses to move
the pinned digest backwards, so a stale re-run cannot silently downgrade the
homelab. Use the ansible repo's own `workflow_dispatch(digest)` to roll back
on purpose.

## Trust model

The public `boardsesh/boardsesh` repo does not host a self-hosted runner and
never will for this workflow. `dispatch-homelab` runs on GitHub-hosted
`ubuntu-latest`, carries no permissions (`permissions: {}`), and touches one
secret: `HOMELAB_DISPATCH_TOKEN`. That token can tell the ansible repo a new
image exists and nothing more. It cannot read homelab secrets or reach a VM.

`HOMELAB_DISPATCH_TOKEN` is a fine-grained GitHub PAT scoped to just the
`blackheathdc-ansible` repo, with `Contents: write` (the minimum scope
`repository_dispatch` needs). It is stored as an environment secret on the
`Homelab` environment, whose branch policy restricts deploys to `main` with no
required reviewers, so the job never blocks on a wait timer or an approval.

The token itself never appears on a command line. If it did, any other
process on the runner could read it via `ps` or `/proc/<pid>/cmdline`.
Instead it's piped into `curl --config -` on stdin, as a header line that
never becomes an argument.

Everything downstream of the dispatch lives in the private ansible repo and
runs on the homelab's own runner. The database credentials come from
1Password; the ansible inventory carries its own SSH keys. None of it ever
reaches this repo.

## Kill switch

The `dispatch-homelab` job is gated on the repository variable
`HOMELAB_DEPLOY_ENABLED == 'true'`. This is a *repository* variable, not an
environment one: a job's `if:` is evaluated before its environment is
resolved, so a variable scoped to the `Homelab` environment would never be
visible there. If the variable is unset (the default) or set to anything
else, the job is skipped. The image still builds and publishes; nothing is
dispatched. This is the switch to flip off if the homelab deploy path needs
to pause without touching the workflow itself.

Turning the variable on without also setting `HOMELAB_DISPATCH_TOKEN` does
not leave the job harmlessly skipped: the job now runs, and the dispatch
request fails with a 401. Set both together.

## Rolling back a bad deploy

The monorepo has no rollback command. That lives in the ansible repo, which
is where the deployed digest is recorded. Two ways to roll back there:

1. Run the ansible repo's `Boardsesh worker deploy` workflow by
   `workflow_dispatch`, passing the previous known-good digest.
2. In the ansible repo, edit `inventories/boardsesh_workers.yml` to restore
   the previous digest line, then re-run the deploy playbook. The automated
   deploy job commits the digest it deploys, so that file's history is the
   deploy log.

## Finding a digest for a given commit

```
gh api --paginate /orgs/boardsesh/packages/container/boardsesh-worker/versions \
  --jq '.[] | select(.metadata.container.tags[]? == "sha-<full 40-char sha>") | .name'
```

Use the full 40-character commit SHA in the tag, not a short prefix. The image
is tagged `sha-<sha>` with the whole thing. `--paginate` matters once
the package has enough versions that the first page doesn't include the one
you want. `.name` is the `sha256:<64 hex>` digest that both
`docker/build-push-action`'s output and the ansible workflow expect. The
`gh` call needs a token with the `read:packages` scope; `gh auth status`
shows what your current token has.

## What's next

`sync-deploy.yml` and `hold-detector-image.yml` build their own images today
without a homelab dispatch step. They're expected to get the same
`dispatch-homelab` job shape once their consumers move to the homelab, as
part of the rest of the pg-boss worker rollout (#5800).
