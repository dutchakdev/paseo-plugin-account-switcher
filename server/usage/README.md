# Account quota monitoring

`createUsageService({ getAccounts, fetchUsage?, cachePath?, now? })` reads quota
windows for every configured account. `getAccounts` supplies the real provider CLI
command, isolated home, exact environment, identity key and an authentication
generation. Normal `getAccounts()` calls read stored metadata only: they must not
start a provider CLI or read Keychain credentials. The scheduler calls
`getAccounts({ verifyAccountId })` for one account immediately before and after an
actual quota request. Expensive checks therefore follow the quota cadence; idle
five-second timer ticks and UI list calls do not spawn credential readers.

For known identities the controller sets `requireIdentityVerification: true`.
Its targeted check reads the credential hash, probes the official CLI, then reads
the hash again. Only a successful identity probe between equal `present:` hashes
sets `identityCredentialVersion`. A changing hash gets one bounded retry; failed
or unstable probes supply no proof. The scheduler compares this proof with
`credentialVersion`, so previously stored identity metadata cannot establish that
replacement credentials belong to the same account. Existing account probes are
drained before the targeted verification begins.

`readCredentialVersion(account)` returns only `present:<sha256>`, `absent`, or
`unavailable`. Preserve the prior version on `unavailable`, but revoke its proof:
inaccessible storage does not establish a signed-out account. Credential reads
use only the selected profile, including the exact Claude Keychain item.
Codex identity keys are ChatGPT `account_id` values; Claude identities
are supplied by the profile owner because its usage response has no account ID.

- Call `start()` once. Polling begins immediately, then runs every five minutes.
- `list({ visible: true })` extends a 90-second visible lease; during that lease
  polling runs every 60 seconds. Listing returns available cached data immediately.
- `refresh(accountId?)` requests one or all accounts. Provider backoff also applies
  to manual refresh and is checked before expensive verification. There are at
  most two account workflows in flight and one per account; each slot includes
  the before-probe, quota request and after-probe.
- `invalidate(accountId)` clears saved identity data and cancels its current read.
  `close()` stops polling, cancels collectors and waits for pending cache writes.
- A successful response retains every reported quota window. Temporary failures
  preserve the last successful snapshot as `stale`. Missing authentication clears
  old data. A passed reset timestamp never invents a new quota value.
  A reported reset triggers one new read (within five seconds), respecting backoff.
- HTTP 429 respects `Retry-After`; otherwise repeated errors back off from one
  minute to at most 30 minutes. HTTP 401 needs authentication; 403 is unavailable.
- Credential rotation preserves last-success data and retry deadlines only when
  both credential versions are proven to belong to the same identity. A native
  successful response survives such rotation when its identity is bound to the
  request. Unproven replacement credentials clear old quota data. A new account
  identity or generation always invalidates the previous response.
- With `cachePath`, only last-success snapshots and identity fingerprints are saved
  using atomic replacement with mode `0600`. Restored data is marked stale. Tokens,
  environment variables, raw commands and provider error bodies are never cached.
  After controller restart, the cache remains hidden and staged until targeted
  identity verification can match it. An offline quota request can then retain
  the verified cached data as stale. Retry deadlines are in memory, not persisted
  across server restarts.
  When profile identity cannot be verified (for example, a system Codex Keychain
  login without a profile `auth.json`), only fresh responses are shown: no saved
  quota is restored or retained after a failure for that unknown identity.

## Provider behavior

**Codex:** a short-lived instance of the supplied real CLI runs `app-server` with
the exact account environment. It sends `initialize`, `initialized`,
`account/read` (`refreshToken: false`), then `account/rateLimits/read`. It never
creates a thread or sends a prompt. The native quota operation can itself refresh
OAuth credentials; this module performs no custom refresh or forced refresh. The
quota response account ID is checked against a known profile identity. If an older
response omits that ID and credentials rotated during the call, it cannot replace
the previous snapshot. The process is terminated on success, failure or cancellation.

**Claude:** on macOS the exact Keychain service/account is preferred. A missing
or inaccessible item falls back only to `.credentials.json` in the supplied home,
matching the native CLI's read behavior. Inaccessible Keychain plus a missing file
remains `unavailable`, since that does not prove the user is signed out. Existing Keychain
credentials with no OAuth token do not fall through to a different file identity.
The installed Claude Code 2.1.263 source was checked for its directory hash and
credential precedence: a custom directory uses the first eight SHA-256 hex digits
of the NFC-normalized home. `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides
`CLAUDE_CONFIG_DIR`; profile preparation must remove or correctly bind it. The
system CLI may have separate settings and credential homes; quota collection
uses its effective credential home, including an empty override for the default.
There is no global profile search. Only the OAuth usage GET endpoint is requested; no
token refresh or inference request is sent. Before HTTP, the actual selected token
must still match the credential hash used to verify a known account identity.

Tests use synthetic credentials and a synthetic stdio CLI. They establish local
protocol, parsing, isolation, scheduling and cache behavior. They do not establish
live access to a user's subscription or real multi-account acceptance.

Protocol reference: [OpenAI Codex app-server account types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs).
