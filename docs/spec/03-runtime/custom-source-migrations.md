# Custom branch: v5-v7 source migration

This document specifies the custom-branch behavior previously distributed as
compiled-resource patches. The migration targets `custom/main`, not upstream
`main`. It does not import unrelated upstream updates or change persisted data.
Previously issued v5-v7 installers are not evidence of a build from this source.

## Same-model OAuth account fallback

- Main resolves enabled, configured OAuth rows for the selected vendor and exact
  model ID, starting after the selected row and wrapping around the provider order.
- Candidates must have the same effective request model, endpoint, protocol,
  capabilities and custom headers. Display labels and reporting prices do not
  change wire compatibility. API-key, no-auth and extension-agent rows are excluded.
- Main binds the resolved candidate IDs to the session's existing OAuth allowlist.
  The launch payload contains no long-lived OAuth credentials; the sidecar resolves
  row-scoped auth through the existing authorized `provider.resolveAuth` path.
- Only exhausted `PROVIDER_RATE_LIMITED` recovery can advance to another account.
  Each account retains its initial request plus ten retries across setup/stream
  phases. Switching itself does not consume a retry on the new account.
- One user run visits each account at most once. A later run starts on the retained
  active account and can wrap through the pool again. No health/remaining-quota
  prediction or paid-API probing is introduced.
- The model and request context stay unchanged; completed tools are not replayed.
  Current transient/network retry, cancellation, error and usage semantics remain.
  Authentication, malformed request and local preparation errors do not rotate.
- If all accounts fail, finite mode exposes the existing terminal error. Infinite
  retry mode tries alternatives first, then continues on the last account under
  the existing abortable policy. No unbounded account-cycling loop is introduced.
- Changing the eligible account pool retires the idle runtime. Deleting/disabling
  a candidate must not allow a cached runtime to retain that account on the next
  prompt. Runtime-local active-account selection is not a persisted UI preference.
- Subagents retain their explicit model/fallback policy; this adds no implicit
  model override or delegation permission.

## Chinese `@` subagent completion

- The renderer uses the existing current-project subagent catalog. It never
  creates definitions or adds disabled/missing agents merely because an alias is
  known. English IDs remain stable and searchable.
- Chinese aliases cover the custom growth/product/project/intelligence roles and
  standard builtins; a bounded Chinese description prefix can label a custom role.
- Selecting a candidate inserts a localized, explicit plain-text instruction using
  the stable agent name. It is not a file-reference chip, direct executor or
  privileged command. Agent mode and tool/model permissions still govern execution.
- Existing file, slash and plugin completion, IME composition freeze, navigation
  and dismissal remain intact. Failed catalog reads cannot resurrect stale rows
  from another session/project, and file completion remains usable.

## Portable automation packaging

The custom build includes the quota plugin and helper source already maintained
on this branch. Complete automation builds also require a validated portable
Python/Node/browser runtime. See `custom/README.md` for provisioning and build-time
runtime configuration. Installed discovery is relative to the application resources,
not a developer drive, system virtualenv or credentials-file directory.

No account files, tokens, browser profiles, editable Python installs, generated
runtime binaries or dependency caches belong in Git. Build-time runtime validation
must fail rather than silently emitting an incomplete "complete" installer.

## Acceptance

- `provider-account-fallback.test.ts` checks compatibility, bounded traversal and
  runtime-pool identity; `provider-account-fallback-flow.test.ts` drives the real
  adapter/Agent loop against simulated responses, including completed tools, account
  attribution, full retry budgets, finite exhaustion, infinite retry and Stop.
- `provider-account-fallback-launch.test.mjs` exercises production launch wiring,
  enabled-model selection, fallback order, credential-free payload and OAuth binding
  refresh after account removal.
- Renderer component/user-path tests cover Chinese/English lookup, completion,
  stale catalogs, file references, keyboard/pointer handling and IME.
- Custom packaging tests verify allowlisted runtime assembly, relocated runtime
  discovery, missing-component failure and preservation of the quota plugin.
- No real account, paid provider or running user application is a test fixture.
  Full release builds and cross-machine OAuth login remain separate release gates.
