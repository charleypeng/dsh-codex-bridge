# Codex models and quota

Use the account signed into your local Codex CLI in DSH. Open **Settings → Codex**
for the cached quota, live model directory, and per-model enable switches.

## Automatic model directory

The plugin queries the authenticated Codex models endpoint on startup and every
five minutes while running. Opening the page also quietly refreshes it. The CLI's
cached client version is used when available; a compatible fallback is supplied.
Model ids, display names, default context capacities, accepted inputs, reasoning
levels, and default reasoning level come from that endpoint, not a hand-written
list. Instructions or system prompts returned by the endpoint are never imported.

New models are enabled by default. Use each row's switch to hide a model from the
DSH model picker. This choice is durable, scoped to the signed-in account, and
survives directory refreshes and application restarts. Disabled models remain on
the settings page, so they can be re-enabled. All switches can be off without
unregistering the provider or deleting conversation history. These are picker
preferences, not account entitlement or a security access policy.

The model's selectable reasoning levels and default follow Codex metadata.
The Codex-only `ultra` orchestration mode is excluded; it is not mapped to `max`.
The public DSH pi-ai adapter is reused for durable history, tool calls, replay,
and images.

## Migration and manual settings

Setup saves the former `openai-codex` pi-ai profile, including explicit model
capacity/name/input/compatibility overrides, in the plugin's storage domain. It
then removes only that provider from the shared pi-ai configuration and registers
the live adapter under the same provider id. Other providers and the current
default model selection are not changed. Manual models remain available alongside
the discovered catalog. For discovered models, reasoning levels/defaults always
follow Codex, rather than a stale canonical level list.

The plugin must stay enabled to serve this route. Disabling the plugin removes
its model adapter, but does not delete credentials, saved preferences, the former
profile, or conversations. Re-enabling reloads the saved directory immediately.

## Quota and display caching

Quota windows, reset times, credit balance, and reset coupons come from the
account's usage endpoint. The full Host response has a 30-second cache, single-flight
refresh, and retry backoff. A failed refresh retains the last good usage data and
its original timestamp; an empty/failed model directory never clears the catalog.

The page renders an in-memory/sessionStorage display cache immediately, then
refreshes quietly. This display-only cache expires after 24 hours, masks the
account id, and never saves OAuth tokens or raw responses. First use without a
cache shows skeletons. While open and visible the page refreshes once per minute.
Manual refresh keeps the old display until a new response arrives. Switch saves
show row-local progress/errors; failure keeps the old checked state.

The Host's schema-validated storage domain keeps the normalized directory and
per-account switch preferences across restarts. Account identities are hashed in
storage keys. OAuth grants remain in DSH's credential service, not this cache.

## Credentials and tools

The credential file is `~/.codex/auth.json`, or `CODEX_HOME/auth.json`. Setup
imports the OAuth grant into DSH's `llm-pi-ai/openai-codex` credential record.
A newer stored grant is not replaced by a stale file. The Host resolves and
refreshes the token; concurrent refreshes share one token rotation. Refreshed
grants are mirrored to the Codex file with owner-only permissions when writable.
The page and operation responses never return tokens.

The `codex_quota` tool exposes the same quota/model/setup/switch operations as the
page. A model switch only controls picker visibility; account quota availability
is shown separately and may not be disclosed for every model.

## Limits

Codex's backend endpoints are not the public OpenAI API contract and can change.
On failure the plugin reports the error and retains the last successful data.
Having a model in the catalog or enabling its switch does not guarantee quota or
server entitlement. A new Codex reasoning level is passed through faithfully;
its special server behavior remains owned by Codex.
