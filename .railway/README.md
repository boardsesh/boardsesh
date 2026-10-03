# Railway configuration

This project defines its Railway infrastructure in code.

```txt
.railway/railway.ts
```

Use this file to describe the Railway project you want: services, databases, buckets, custom domains, replicas, groups, and environment variables.

The TypeScript file imports `railway/iac`. The root `package.json` pins the SDK;
use `vp install` from the repository root to install it.

## Common commands

Create the configuration files:

```bash
railway config init
```

Import an existing Railway project into code:

```bash
railway config pull
```

Preview what Railway would change:

```bash
railway config plan
```

Apply only after an operator reviews and explicitly approves the complete plan:

```bash
railway config apply
```

## Notes

- `railway config plan` is safe and does not change Railway.
- `railway config apply` mutates the linked project after its plan is reviewed.
- Do not auto-confirm destructive changes. Review any destructive plan and get explicit approval before applying it.
- CI can pin a plan (`railway config plan --out railway-plan.json`) for human review, then apply that exact approved artifact (`railway config apply --plan railway-plan.json --yes`). On GitHub Actions, use https://github.com/railwayapp/config.
- Services already managed by `railway.json` must be migrated before `.railway/railway.ts` can manage them.
- Keep one `.railway` file for the whole project. A named `export const partial` (or `PARTIAL` / `const Partial`) is a last resort for separate repos that cannot share that file. Do not add it unless omit=delete across repos is a blocker.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import. `railway config pull --include-variables` decrypts and inlines non-sealed values (including secrets that were never sealed).
- `railway config migrate` finds every `railway.json` / `railway.toml` in the repository and writes them into this one file.
- Keep every live project resource in this file; omitting a resource can delete it on apply. Review the complete plan and resolve unrelated changes before applying.
- The forwarder service settings are captured here, but its image source, persistent volume, credentials, and runtime variables remain a separate provisioning step.
