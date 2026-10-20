# Maintained fork

This fork tracks upstream releases with a small, reviewable patch set. `upstream`
points to `deepcoldy/botmux`; `origin` points to this fork. `maintained` is the
deployment source branch. The initial base is upstream `v3.47.0`
(`ba2ad453fde414845292d3e9fd5d165f6d63f7f1`). Keep `master` available for upstream
comparison. Never deploy a moving upstream branch directly.

## Cache isolation patch

The governed bytedcli wrapper receives the current caller's JWTs, but Bits can
consult its on-disk token cache before those JWTs. Reusing an operator or bot
profile therefore risks performing a later caller's request with an earlier
caller's cached identity.

The patch creates a fresh HOME and XDG tree for each governed bytedcli invocation,
clears ambient credential/profile overrides before loading the published identity,
and removes derived caches after the process exits. It retains the upstream
login flow, daemon-side per-user homes and JWT publication format. Ordinary
bytedcli use outside a governed Botmux session is unchanged.

Filesystem sandboxes seal the shared session-tmp root and grant access only to
the current session's subtree. Both allowlist and scratch policy compilers have
coverage. Codex/TraeX receive explicit temporary-directory environment overrides.

The supervisor and scratch carve logic are adapted from upstream
[PR #1796](https://github.com/deepcoldy/botmux/pull/1796), commit
`be1995c44818ae362189a42df57d0fce43c99f0c`. The PR's regional JWT redesign,
personal Lark apps, and larkdev integration are outside this patch.

### Boundaries

This addresses normal CLI cache reuse. The shared OS account, unwrapped absolute
CLI paths, same-session model history, and already-running commands require their
own trust boundaries. SIGKILL or machine failure can leave a temporary directory;
the session sandbox seal still applies, and session close retires its temp tree.
Existing persistent sandboxes retain their old policy until recreated. Use fresh
sessions for acceptance; retain history and avoid automatic historical replay.

## Synchronize and release

1. Develop in a linked worktree. Install Bun 1.4.3 dependencies in the canonical
   checkout, then share node_modules with the worktree when manifests match.
2. Review a fix branch against `maintained`, test, and publish it to `origin`.
3. Fast-forward both the Mac and Linux canonical checkouts to the same approved
   `origin/maintained` SHA. `git pull --ff-only origin maintained` must fail on a
   local divergence; reconcile it explicitly rather than overwriting edits.
4. Run `bun run build` on each required platform. Build Linux binaries on Linux
   with `BOTMUX_VERIFY_BAKED_VERSION=3.47.0-fork.<short-sha> bun run build:bun`.
   Keep package.json's upstream placeholder and use a private artifact directory.
5. Record source SHA, runtime build ID and artifact SHA-256. Deploy only that
   artifact after acceptance; preserve the prior executable for rollback.
6. Keep machine paths, bot configuration, JWTs, auth homes and credentials outside
   this public repository. Synchronize code through Git, never credential stores.

Use an explicit release gate rather than automatic official `botmux upgrade`:
an official binary would replace the local patch. Review upstream release diffs,
merge into an upgrade branch, rerun the cache and sandbox acceptance cases, and
retire this patch when an upstream implementation covers the same cases.

## Acceptance

Run the identity, session-temp, filesystem-policy and scratch test suites, plus
`test/bytedcli-cache-isolation.test.ts` and `test/cli-identity-bwrap.test.ts`.
On Linux, set `BOTMUX_TEST_BYTEDCLI_DIST` to the installed bytedcli dist directory
to run the offline real Bits SDK case. It uses dummy cache values and blocks
network access; it never logs in or submits an MR.

Before retiring a compatibility wrapper, verify the native wrapper directly
inside the real filesystem sandbox, successful and failed calls, cancellation,
and the original CLI's cache-first behavior. Then use two authorized humans in
fresh bot conversations: A's successful request, B's unauthenticated request,
B's own authorization, and the resulting MR authors. Keep login links private.
Document this human acceptance separately from automated fixtures.
