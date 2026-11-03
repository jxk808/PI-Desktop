# OpenAI Codex manual-reset extension

This is a local derivative of `czp0312/pi-desktop-quota-visualizer` v0.4.2, version
`0.4.3-reset.1`. It is not a release by the original author or OpenAI.

## Install and use

1. In PI-Desktop, open Plugins and choose **Install plugin package** from the
   overflow menu. Select `io.github.czp0312.subscription-quota-0.4.3-reset.1.piplug`.
   Review the existing network and external-browser permissions. The plugin ID
   is unchanged, so this is an upgrade of Subscription Quotas, not a second plugin.
2. Open the **Subscription Quotas** work-panel view. Exit demo mode.
3. Open **Manage accounts**, add or select the intended OpenAI account, and
   complete its browser authorization. The plugin does not reuse or decrypt
   PI-Desktop's own login; existing plugin OAuth authorizations are preserved.
4. On that OpenAI card, choose **Query reset credits**. Only available,
   nonexpired `codex_rate_limits` grants with usable IDs are offered. Each
   credit displays its full local expiry date and time if provided.
5. Choose **Use this credit**, check the authoritative account identity, account ID,
   selected credit ID and expiry, then explicitly
   confirm consuming one credit. Cancellation never redeems a credit.
6. The upstream result is shown and the plugin re-queries quota. `reset`,
   `already_redeemed`, `nothing_to_reset` and `no_credit` have separate messages.
   A refresh failure is shown separately and is not a reason to redeem again.

The account must have an official eligible Codex reset credit. This is not
unlimited quota clearing, a purchase, or a reset of API billing/all ChatGPT limits.
CLI, manually supplied tokens, manual quota windows and other vendors remain
read-only. No new permissions or network domains are introduced.

## Compatibility and credentials

Requires PI-Desktop 0.18.x or newer with `pi.net.getCapabilities()` reporting the
`error` fetch-redirect mode. Requests are refused on an older or incompatible
host rather than silently allowing redirects. The exact backend feature and
account eligibility are controlled by OpenAI and can change.

OAuth credentials retain the original plugin's storage behavior: AES-256-GCM
ciphertext and a local key stored together under the plugin data directory.
Protection relies on OS file permissions, not an OS keychain. Manually entered
tokens remain ordinary plugin settings. Never share that directory.

## Timeout and restart recovery

A local `openai-reset-operations.json` file records operation ID, selected credit,
plugin account ID, upstream account ID, confirmed account label, expiry, and state.
It contains **no access or refresh tokens**. Before dispatch, the operation is
persisted and account identity is checked again. Requests reject redirects and
are not retried automatically.

If a result is uncertain, query the credits and use **Resume last redemption**
on the original account card. This requires another confirmation. The operation
keeps the exact same `redeem_request_id` and `credit_id`, including after plugin
restart, relying on the upstream idempotency contract. If the credit is already
reported redeemed, recovery can complete without another POST. Missing or
ambiguous evidence never silently unlocks a fresh redemption.

Do not delete the operation file, downgrade this extension, or remove the original
plugin account while a redemption is unresolved. Duplicate plugin logins for the
same upstream account cannot start a second operation; return to the original
card. A changed account identity is rejected rather than consuming on a different
account. If the upstream never returns usable evidence, check its official usage
page before any further operation.

Selecting a different credit while another operation is pending fails explicitly;
the plugin never silently substitutes the original credit. Confirmation uses the
operation's saved account identity, not a potentially stale card or refreshed snapshot label.

## Protocol references

- Official client implementation:
  https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume`
- POST JSON: `{ "redeem_request_id": "stable UUID", "credit_id": "selected credit" }`

The endpoint is used by the official client; this is not a promise of a stable
public OpenAI API contract or universal availability to third-party clients.

## Tests

```powershell
node --check main.js
node --check lib/openai-reset.js
node --test tests/*.test.js
```

Panel tests require the `jsdom` development dependency (`package.json`). If it is
installed separately, set `NODE_PATH` to that installation's `node_modules`.
The new DOM tests enter through the real buttons, invoke the actual plugin routes,
and use mocked OAuth accounts and HTTP responses. They test confirmation,
account selection, cancellation, duplicate clicks, quota refresh, localized
results, and timeout recovery. Module tests also cover durable restart recovery,
expiry, account changes/removal, duplicate logins, persistence failure, malformed
responses, and credential redaction. No real OpenAI quota/reset request is required.

Package with PI-Desktop's `PluginPack`, which validates before producing the
uncompressed `.piplug` archive. Do not re-zip the package with a general ZIP tool.
