# Publishing to npm

## Package name: `crew-mcp` (unscoped)

We publish under `crew-mcp`, not `crew`. The unscoped `crew` name is
**permanently locked** by npm — it was published 2014–2015 by an
unrelated project, then unpublished on 2024-10-18. Per npm policy
(post-left-pad, 2016), unpublished names are tombstoned and cannot be
re-registered, even though `npm view crew` returns 404. Attempting to
publish returns `E403 Forbidden` from the registry's deletion-protection
layer, not an auth error.

If we ever need an unscoped alternative, candidates worth checking:
`crewd`, `crewctl`, `crewkit`, `runcrew`, `crewmcp`. The scoped fallback
`@chasenstark/crew` is also always available.

## Current published state

| Version | Date       | Type        | Notes                                              |
|---------|------------|-------------|----------------------------------------------------|
| 0.0.1   | 2026-05-05 | placeholder | Name reservation only; stub README + package.json. |

The placeholder shipped from `/tmp/crew-placeholder` (not the repo). The
real package's `package.json` carries `0.2.0-dev` and is **not yet
published**.

## Real release: prerequisites

Before bumping past 0.0.1 and publishing the real package:

1. `package.json` cleanup:
   - Bump `version` to the real semver (e.g. `0.2.0`), drop `-dev`.
   - Add `license` (MIT or Apache-2.0; currently absent).
   - Add `repository`, `homepage`, `bugs` fields pointing at
     `https://github.com/chasenstark/crew-mcp`.
   - Confirm `bin.crew` points at `./dist/index.js` and `files` ships
     `dist` + `skills` only.
2. Repo root `README.md` — npm renders it on the package page. Make sure
   it explains install + first dispatch, not just architecture.
3. Pre-publish gates (run manually; `prepublishOnly` only runs `build`):
   ```bash
   npm run lint && npm run test:run && npm run build
   ```
4. Preview the tarball:
   ```bash
   npm pack --dry-run
   ```
   Should show `dist/`, `skills/`, `package.json`, `README.md`, and
   `LICENSE` (once added). Nothing else.

## Real release: publish

```bash
npm whoami                       # confirm; expect `chasenstark`
npm publish --dry-run            # last look
npm publish                      # ships under `crew-mcp`
```

`crew-mcp` is unscoped, so no `--access public` flag is needed (default
for unscoped is public). The `0.0.1` placeholder will remain in the
version history — that's fine, you can't unpublish it (and even if you
could within 72h, the name would be tombstoned exactly like `crew`).

## Post-publish

- `npm view crew-mcp` to confirm the new version is `latest`.
- `npx crew-mcp --help` from a clean directory to verify the bin works
  end-to-end via npm.
- Tag the commit: `git tag v<version> && git push --tags`.

## Things to know about npm name policy

- **Unpublishing is mostly one-way**: within 72h you can `npm unpublish
  <name>@<version>`, but the version-string is reserved for 24h, and
  unpublishing the *whole package* tombstones the name forever. Don't
  publish anything to `crew-mcp` you'd want to truly take back.
- **Pre-releases**: ship via `npm publish --tag next` to keep `latest`
  pointing at the prior stable. Users get the prerelease only with
  `npm install crew-mcp@next`.
- **Scoped packages** (`@chasenstark/crew-mcp`) are always available
  and orthogonal to the unscoped name. We don't need them today, but
  they're the escape hatch if we ever lose access to `crew-mcp`.
