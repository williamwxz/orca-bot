# Grok Bot gateway protocol (macOS)

This describes the installed MIT-licensed `grok-bot-cli` 0.12.5 bundle at
`/opt/homebrew/lib/node_modules/grok-bot-cli/dist/bin/gbot.mjs` (CLI entry point version string `version: "0.12.5"`). References below are identifiers in that file; line numbers refer
to this installed build. The package README and CHANGELOG were also reviewed.
The original review read source only. No CLI, keychain operation, session file,
or network request was executed for this document. Additions marked **observed**
come from reviewer-reported real `gbot --json` output or app/gateway behavior,
not source inspection.
This is not a complete server schema.
All example account keys, ids, tokens and route hosts below are invented. Example
responses marked **inferred** illustrate accepted shapes, not captured traffic.

## 1. Desktop session

On macOS the data directory is `~/Library/Application Support/Grok Bot`.
The client reads these files there (`grokBotAppDataPath`, `activeAppAccount`,
`loadGrokBotGatewaySession`, `desktopStatusAppVersion`):

| File | JSON fields used | Encryption |
| --- | --- | --- |
| `gateway-descriptor.json` | `version`, `encrypted`, or `entries` whose values have `encrypted` | Outer JSON is clear; `encrypted` is base64 Safe Storage ciphertext. |
| `sand-secrets.json` | `version`, `cursor-accounts` | Outer JSON is clear. `cursor-accounts` is itself a JSON **string**. The selected account's token and optional team id are encrypted individually. |
| `desktop-status.json` | `appVersion` | Read directly as clear JSON. |

These are the files this client consumes, not an inventory of every app file.
Descriptor versions absent/1 use top-level `encrypted`. Versions 2/3 use
`Object.values(entries)`: exactly one entry is required. Zero is `EMPTY_ENTRIES`;
more than one is `AMBIGUOUS_ENTRIES`. The client does not select among entries
by account key. Other versions are `UNSUPPORTED_VERSION`; empty ciphertext is
`MISSING_ENCRYPTED_PAYLOAD` (`encryptedPayload`, 44295–44319).

The decrypted descriptor is JSON with required truthy `baseUrl` and `token`,
and optional `headers`. It becomes `{gatewayUrl, gatewayToken, headers}`;
one trailing slash is removed from `baseUrl`. Missing fields produce
`INCOMPLETE_DESCRIPTOR` (`loadGrokBotGatewaySession`).

`cursor-accounts` parses to an object shaped like this (**inferred** example
from `activeAppAccount`):

```json
{"active":"example-account","accounts":{"example-account":{"cursor-access-token":"<base64 ciphertext>","cursor-selected-team-id":"<base64 ciphertext>"}}}
```

`sand-secrets.json.version` must be absent or 1. `active` must be a string and an
own property of `accounts`. Only that account is used; there is no fallback to
another saved account. Its `cursor-access-token` must be a nonempty encrypted
string. Decrypted access token is trimmed and must remain nonempty. Optional
`cursor-selected-team-id` is decrypted without trimming and must match
`^[1-9][0-9]*$` and convert to a safe integer; it remains a string for headers.
A supplied `expectedAccountKey` must match or loading fails with `ACCOUNT_CHANGED`
(`activeAppAccount`, `loadGrokBotAppCredentials`, 44472–44540).

### macOS Safe Storage algorithm

The source invokes `/usr/bin/security find-generic-password -w -s
"Grok Bot Safe Storage"`, then `trimEnd()` on its UTF-8 output. **It specifies
no account name (`-a`)**. An exact keychain account name cannot be recovered
from this source. The command is described here only; it was not run
(`readKeychainPassword`, 44429–44452).

Decode ciphertext from base64. First three bytes must be ASCII `v10`
(hex `76 31 30`). macOS rejects `v11`. Derive a 16-byte key using
PBKDF2-HMAC-SHA1(password, UTF-8 `saltysalt`, 1003 iterations). Decrypt bytes
after the prefix with AES-128-CBC and IV `Buffer.alloc(16, 32)` (sixteen ASCII
spaces, hex `20`). Concatenate `decipher.update` and `decipher.final`, then decode
UTF-8. Default Node decipher padding is retained: PKCS#7 padding is **inferred**
from `createDecipheriv` without disabling auto-padding. There is no separate MAC
in this decoder. Apply the same algorithm to descriptor, token, and selected
team id (`safeStorageKey`, `decryptSafeStorageString`, `decryptAppSecret`,
44320–44339; `loadGrokBotAppCredentials`).

## 2. Gateway route and refresh

`connectGateway` uses this precedence (48036–48223):

1. Both nonempty `GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN`: use them.
2. A usable desktop descriptor: use its cached route, token and headers.
3. Otherwise `CURSOR_ACCESS_TOKEN`, trimmed, requests a fresh route. If absent,
   decrypt the active desktop account and use its access token and optional team.

A malformed descriptor normally throws before fallback. It is suppressed when
`CURSOR_ACCESS_TOKEN` is present (`sessionFromApp`). A missing descriptor allows
active-account fallback. The cached descriptor has no expiry field consumed by
this client. Refresh changes the in-memory session; this code does not write
fresh routes to the descriptor (`loadGrokBotGatewaySession`, `refreshGateway`).

Our desktop reader deliberately differs from gbot for v2/v3 descriptors with
zero entries: it returns the signed-in account without a `route`, so the caller
can request a fresh route after the cloud computer sleeps. Without an account
it throws `not_signed_in`; multiple entries still throw `ambiguous_entries`.

Fresh route request (`ensureSandbox`, `ensureSandboxHeaders`):

```http
POST https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox
content-type: application/json
connect-protocol-version: 1
authorization: Bearer example-access-token
x-cursor-client-type: sand
x-cursor-client-version: 0.20.0
x-sand-box-namespace: prod
x-cursor-team-id: 42

{}
```

`x-cursor-team-id` is omitted unless a desktop selected team was loaded.
`CURSOR_API_BASE_URL` overrides the base URL (one trailing slash removed).
`SAND_BOX_NAMESPACE` overrides `prod`. Version precedence is `SAND_CLIENT_VERSION`,
installed app version, then `0.20.0`; this is **not** the gbot version.
App version comes first from `desktop-status.json.appVersion`, then on macOS
`~/Applications/Grok Bot.app/Contents/Info.plist`, then
`/Applications/Grok Bot.app/Contents/Info.plist`, reading
`CFBundleShortVersionString` with PlistBuddy. Valid versions match
`^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$`; invalid/missing status JSON is ignored
(`grokBotAppVersion`, `validAppVersion`, `macAppBundleVersion`,
`ensureSandboxHeaders`, 48792–48801).

Accepted response example (**inferred**, `ensureSandbox`,
`headersFromEnsureSandbox`):

```json
{"gatewayUrl":"https://example-gateway.cursorvm.com","gatewayToken":"example-gateway-token","gatewayHeaders":{"x-anyrun-network-token":"example-network-token"}}
```

`gateway_url` / `gateway_token` are also accepted. Both route and token must be
truthy. Headers come from nonempty normalized `gatewayHeaders` or
`gateway_headers`; otherwise `anyrunNetworkToken`, `anyrun_network_token`, or
`networkToken` becomes `x-anyrun-network-token`. Header names are lowercased;
null/empty values are dropped and others stringified. Descriptor headers receive
the same normalization. `GROK_BOT_GATEWAY_HEADERS` is a JSON object overriding
these headers (`normalizeHeaderMap`, `headersFromEnsureSandbox`,
`mergeGatewayHeaders`).

A read is retried once only when HTTP status is 417 and both headers match:
`x-anyrun-error-source: anyrun-proxy`,
`x-anyrun-failure-reason: pod_hibernated`. Eligible calls are `listAgents`,
`getAgentWorkflows`, `getAgentTranscriptTail`, `getAgentThread`. Refresh calls
EnsureSandBox, replaces route/token/headers, then repeats the read. Concurrent
refreshes share a pending promise and generation counter. Desktop account identity
is checked before and after refresh; account changes discard the route. Explicit
gateway overrides have no refresh credentials. Mutations are not retried
(`READ_ONLY_METHODS`, `gatewayCall`, `refreshGateway`).

## 3. Transport and errors

Gateway calls are HTTP POST to `${gatewayUrl}/api/${method}`, with one JSON
request body and one response body. Headers are `content-type: application/json`
and `authorization: Bearer <gatewayToken>`, followed by session headers (which
can override either). There is no JSON-RPC envelope, transport request id,
WebSocket framing, or streaming decoder here. `clientNonce` on send is an
application correlation value (`gatewayCall`, `requestHeaders`).

Each fetch has a 30,000 ms abort deadline, redirects set to `error`, and a
2 MiB response-body cap measured in bytes. Empty response becomes `{}`;
non-JSON text becomes `{raw: text}`. Non-2xx produces `GatewayError` with
`status` and `method`; detail precedence is `message`, `error`, `raw`, HTTP
status text. Gateway error detail is limited to 300 characters and redacted;
EnsureSandBox detail is redacted but has no corresponding 300-character slice.
Network/abort errors can propagate directly (`gatewayDeadline`, `readTextCapped`,
`readJson`, `gatewayCall`, `ensureSandbox`, `redactSecrets` in URL policy).

Cancellation is checked before transmission. Reads combine caller cancellation
with the deadline and check it after reading. Once `sendPrompt` is transmitted,
its fetch uses only the deadline, avoiding a misleading caller-cancelled result
for a possibly accepted send (`assertGatewayActive`, `gatewayCall`).

Default credential URL policy requires HTTPS: backend hosts are `cursor.sh`,
`cursor.com` or their subdomains; gateways also permit subdomains of
`cursorvm.com`. URL userinfo is rejected. `GROK_BOT_ALLOW_LOCAL_GATEWAY` allows
HTTP(S) loopback gateways, `GROK_BOT_ALLOW_ANY_GATEWAY` bypasses normal host
checks, and test mode permits only HTTP(S) loopback even with that override.
Retain credential destination checks in a replacement client
(`assertAllowedCredentialUrl`, `isCursorApiHostname`, `isCursorGatewayHostname`).

## 4. Agent and message calls

The JSON below is the **wire body**, not the CLI output wrapper. Response
examples are **inferred** from fields consumed by the named functions unless
marked **observed**. Unknown
server fields should be preserved where the client passes raw responses through.
The source does not establish a complete response schema.

### listAgents

Request: `{}`. Response accepts an array, `{agents: [...]}`, or `{agent: {...}}`
(`listAgents`, `unwrapList`, `asRecord`, 48301–48339).

```json
{"agents":[{"id":"example-bot","name":"Planner","title":"Planning","description":"Plan tasks","avatarShape":"egg","avatarColor":"blue","notifyOnUpdatesEnabled":true,"isHiddenFromSidebar":false,"isGroup":false,"memberAgentIds":[]}]}
```

Normalization uses `id || agentId`; profile strings default to `""`.
`memberIds || memberAgentIds || []` supplies membership. Notification aliases are
`notifyOnUpdatesEnabled ?? notifyOnAgentUpdates`; visibility aliases are
`isHiddenFromSidebar ?? hiddenFromSidebar`; defined values become booleans.
A group is `isGroup === true`, or absent/null `isGroup` with nonempty membership.
Records without ids are filtered. Reference resolution first matches id ignoring
case, then unique exact name/title ignoring case; ambiguous/missing names fail
(`asRecord`, `resolveFromList`).

### createAgent

All six fields below are sent. Missing description/title/avatar fields become
empty strings; origin is always `user` (`createAgent`, `assertAvatar`).

```json
{"name":"Planner","description":"Plan tasks","title":"Planning","avatarShape":"egg","avatarColor":"blue","origin":"user"}
```

Response accepts a direct agent or `{agent: agent}` and normalizes it:

```json
{"agent":{"id":"example-bot","name":"Planner","description":"Plan tasks","title":"Planning","avatarShape":"egg","avatarColor":"blue"}}
```

On create, avatar strings are trimmed and empty strings are allowed. These are
the CLI's accepted create values, not server response limits. Shapes: `blob`, `pebble`,
`bean`, `egg`, `squircle`, `tablet`, `capsule`, `cylinder`, `hex`, `gem`, `crystal`,
`wedge`, `shield`, `dome`, `arch`, `cloud`, `teardrop`, `leaf`. Colors: `black`,
`brown`, `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `violet`, `magenta`,
`gray` (`AVATAR_SHAPES`, `AVATAR_COLORS`, 49199–49231; `unwrapOne`).

**Observed:** returned bots also use `heart`, `square`, and `sparkle`; many have
no shape or color. Our client must accept any string or a missing value for
either avatar field when reading.

### updateAgent

Resolve the record through listAgents first. Always send name and description:
use existing values when absent from the patch. A supplied name is trimmed and
cannot be blank. Title and avatars are included only if supplied (`updateAgent`).

```json
{"id":"example-bot","profile":{"name":"Planner Two","description":"Plan carefully","title":"Next steps","avatarShape":"leaf","avatarColor":"green"}}
```

The response is ignored; `{}` is an **inferred** usable response, not a guaranteed
server shape. Optional flags are separate POSTs:

```json
{"id":"example-bot","isEnabled":true}
```

That is `setAgentNotifyOnUpdates`. `setAgentHiddenFromSidebar` uses:

```json
{"id":"example-bot","isHidden":true}
```

Their responses are also ignored. Finally listAgents runs again and the wrapper
returns the matching fresh normalized record, or the old record if absent.
The sequence is not atomic (**inferred** from sequential awaits, `updateAgent`).

### deleteAgent

Resolve with listAgents, then send:

```json
{"id":"example-bot"}
```

The CLI ignores the response; `{}` is an **inferred** usable response. Its wrapper
returns the pre-delete normalized record, not the wire response (`deleteAgent`).

**Observed:** `POST /api/deleteAgent` can return HTTP 200 with the following
body while leaving the bot undeleted:

```json
{"transcript":[],"refusedAgentIds":["example-bot"]}
```

The gateway may also report `failedAgentIds`. Our client checks whether the
requested id appears in either array: `refusedAgentIds` raises `delete_refused`
("Grok Bot refused to delete this bot. Delete it in the Grok Bot app."), and
`failedAgentIds` raises `delete_failed` ("Grok Bot could not delete this bot.
Try again, or delete it in the Grok Bot app."). Other 2xx responses remain
successful; no deletion is retried automatically.

### getAgentTranscriptTail

Resolve the target, then send:

```json
{"id":"example-bot","limit":40}
```

Default limit is 40. Clamp integer limit to 1–200. Response is passed through as
`{target, transcript: response}`. Only `entries` is recognized as the transcript
container (`getTranscriptTail`, `transcriptEntries`). **Observed** shapes below
use invented values. Every entry has a string `id`, `seq`, and `timestampMs`; the transcript has
`nextBeforeSeq` and `precedingTimestampMs` beside `entries`.

```json
{
  "entries": [
    {"id":"t25s10","seq":1,"timestampMs":1000,"kind":"message","role":"user","content":"Plan tomorrow","richText":"Plan tomorrow","isStreaming":false,"clientNonce":"example-nonce","requestId":"example-request"},
    {"id":"t25s11","seq":2,"timestampMs":2000,"kind":"send-message","message":{"type":"text","content":"Here is a plan."}},
    {"id":"t25s12","seq":3,"timestampMs":3000,"kind":"send-message","message":{"type":"widget","widget":{"prompt":"Choose a plan","options":[{"label":"Morning","value":"morning"}],"allowCustom":true}},"respondedValue":"morning"},
    {"id":"t25s13","seq":4,"timestampMs":4000,"kind":"send-message","message":{"type":"user-form","formRequest":{}}},
    {"id":"t25s14","seq":5,"timestampMs":5000,"kind":"send-message","message":{"type":"email-draft","draft":{}}},
    {"id":"t25s15","seq":6,"timestampMs":6000,"kind":"send-message","message":{"type":"attachment","file_name":"plan.txt","url":"https://example.invalid/plan.txt","source_path":"example/plan.txt"}},
    {"id":"event-a1b2c3d4","seq":7,"timestampMs":7000,"kind":"event","event":{"type":"automation-changed","action":"created","automationId":"example-routine","automationName":"Daily plan"}}
  ],
  "nextBeforeSeq":1,
  "precedingTimestampMs":0
}
```

`formRequest` and `draft` contents are omitted here. The wrapper imposes no
entry-kind schema. `send-message` and `message.content` are read explicitly (`grokApproval`,
`entryTextRaw`). Text fallback order is a string `text || prompt || message`,
then string/array/object `content`, then object `message.content`, then `preview`.
Array content joins string parts or `part.text || part.content` with newlines.
Non-string values are normalized safely (`entryTextRaw`, `normalizeText`).

`--after` is local filtering, not a gateway parameter. `transcriptDelta` slices
the bounded tail, returns entries strictly after the matching `id`, and returns
`cursor`, `entryCount`, `gapReset`. Missing cursor returns the current snapshot
with `gapReset: true`; unchanged tail returns no entries. Missing final entry ids
also trigger reset handling (`transcriptDelta`, 49576 onward).

### getAgentThread

Resolve target, then send:

```json
{"id":"example-bot","rootId":"example-user-entry"}
```

Response passes through as `{target, thread: response}`. The shared transcript
reader expects `entries`; full metadata/pagination is not validated (`getThread`,
`transcriptEntries`). Example:

```json
{"entries":[{"id":"example-bot-entry","kind":"send-message","message":{"content":"Here is a plan."}}]}
```

### sendPrompt

Resolve target, then send (`sendPrompt`, 48553–48593):

```json
{"agentId":"example-bot","prompt":"Plan tomorrow","clientNonce":"00000000-0000-4000-8000-000000000001","replyToId":"example-user-entry"}
```

`replyToId` is optional and omitted if falsy. `clientNonce` is a supplied truthy
nonce or a new `crypto.randomUUID()`. No separate transport request id is sent.
Accepted response example:

```json
{"accepted":true,"messageId":"example-new-entry"}
```

Any string `messageId` confirms delivery. If missing and `accepted === true`,
read `getAgentTranscriptTail` with `{id: "example-bot", limit: 20}` and look for
an entry with matching `clientNonce` and a nonempty string `id`. Failed lookup
is swallowed. The wrapper returns `{target, result: response, delivery:
"accepted", messageId}` only when it finds an id; otherwise `delivery` is
`unknown`. Submission acceptance is not bot completion (`sendPrompt`,
`transcriptEntryIdForNonce`).

On errors, explicit delivery is preserved. Otherwise HTTP errors below 500 mean
`rejected`; server errors, transport loss and timeouts mean `unknown`. Errors
include `targetId`; unknown delivery warns to check the thread before resending.
Do not automatically replay a send (`sendPrompt`, `gatewayCall`).

**Observed:** `POST /api/sendPrompt` for a bot running on Grok Bot's server
returns HTTP 409 with the JSON `message`: "This Bot runs on the server, and this
version of the app can't message it. Update the app and try again."
Bot Deck maps every HTTP 409 from `sendPrompt`, regardless of response wording,
to code `server_bot` and preserves status 409. The worker's client then makes
one backend send with the same nonce (see [server-api.md](server-api.md)).
This is fallback after definite rejection, never replay after an unclear outcome.

## 5. Routines and workflow skills

**gbot has no direct scheduled-routine create, pause, resume, update or delete
call, and no dedicated routine-list call.** This statement concerns this client,
not proof that the server lacks such APIs. The complete `gatewayCall` call sites
in `gateway.js` (48333–48662) expose agent/group CRUD, messages, transcripts,
skills and approvals only. Routine requests can be conveyed as ordinary prompts;
that is not a distinct routine protocol.

**Observed:** routine changes appear in transcript entries with `kind: "event"`
and `event: {type: "automation-changed", action: "created" | "updated",
automationId, automationName}`. This is the only routine data we can read today,
and the panel already uses it. Other `action` values are unknown.

`getAgentWorkflows` sends `{"id":"example-bot"}`. `anyBotId` picks the first
non-group from listAgents; at least one bot is required. `asSkills` accepts an
array or `{workflows: [...]}` and filters entries without truthy ids. It returns
`id` (stringified), `name`, `description`, `source` (default `workflow`), and
optional truthy `sourceRef` and `pluginId` (stringified). Recognized source labels
are `workflow` (library), `managed` (team), `plugin`, `automation` (scheduled
automation). No schedule, enabled/paused state or run metadata is read
(`SKILL_SOURCES`, `asSkill`, `asSkills`, `listSkills`, 48402–48436).

Example response (**inferred**):

```json
{"workflows":[{"id":"example-skill","name":"Daily plan","description":"Prepare a plan","source":"automation","sourceRef":"example-routine"}]}
```

Related **skill**, not routine, mutations are `importAgentWorkflowText` with
`{id, markdown}` and `deleteAgentWorkflow` with `{id, workflowId}`. Import rejects
empty text or text over 100000 characters; it reads `result.imported[0]`, or
`result.skipped[0].reason` on failure. Removal refuses every source other than
`workflow`, including `automation`. It ignores the delete response (`addSkill`,
`removeSkill`). These must not be repurposed as routine controls.

## 6. Live updates and working state

There is no Grok gateway subscription, SSE, WebSocket, or bot-working-state call
implemented in this bundle's `gateway.js` or `openBackend`. It offers bounded
HTTP transcript reads and local cursor filtering. The replacement can poll these
reads (**inferred implementation choice**); the source supplies no Grok push
endpoint or event framing. WebSocket / notification / watch machinery elsewhere
in this bundle belongs to Codex's separate app-server integration and is not
evidence of a Grok subscription (`gatewayCall`, `openBackend`, `transcriptDelta`;
`./src/core/codex…` modules). Whether the server offers an undocumented stream
cannot be determined here.

**Observed:** `message` entries carry `isStreaming`. This is the one working-state
signal a polling client can use.

## 7. Approvals

`gbot approvals list` resolves the target, calls `getAgentTranscriptTail` with
limit 200, and requires an `entries` array of at most 200 entries. It does not
call a dedicated approvals-list endpoint (`listGrokApprovals`, 48633–48642).
`grokApproval` recognizes only `kind: "send-message"` and either:

```json
{"id":"example-approval-entry","kind":"send-message","message":{"type":"auto-review-approval","approval":{"status":"pending","requestId":"example-request","reason":"Run the proposed command"}}}
```

or `message.type: "local-tool-permission"` with the card in `message.ask`.
Entry and request ids must each be strings of length 1–1024. Output cards contain
`entryId`, `requestId`, `type`, `truncated`, plus string fields among `reason`,
`command`, `summary`, `action`, `description`, `target`, `machineId`, `surface`,
`workingDirectory`. Each detail is redacted and limited to 2048 characters;
longer detail sets `truncated`. Output is `{target: {id, name}, approvals: [...],
coverage: "Latest 200 transcript entries only; older requests require the owning Grok UI."}`
(`grokApproval`, `grokApprovalResponseSchema`, `listGrokApprovals`).

`gbot approvals respond` accepts target, entryId, requestId (same length bounds)
and decision `accept` or `decline`. It re-lists pending cards and requires exactly
one matching entry/request pair. Stale, foreign or unsupported requests fail.
Truncated cards cannot be accepted (`respondGrokApproval`). Wire examples:

```text
POST /api/resolveAutoReviewApproval
{"agentId":"example-bot","entryId":"example-approval-entry","requestId":"example-request","resolution":"approved"}

POST /api/resolveLocalToolPermission
{"agentId":"example-bot","entryId":"example-approval-entry","requestId":"example-request","resolution":"allow-once"}
```

Decline maps to `denied` for auto-review and `deny` for local tools. Wire responses
are ignored; `{}` is an **inferred** usable response. After successful HTTP
completion the wrapper returns `{target, entryId, requestId, decision,
delivery: "accepted"}`. Chat replies are not approval authorization
(`respondGrokApproval`, `grokApprovalNotice`).

## 8. Windows and Linux differences

Linux uses `$XDG_CONFIG_HOME/Grok Bot` or `~/.config/Grok Bot`. The same CBC
scheme uses **one** PBKDF2 iteration. Prefix `v10` uses password `peanuts`;
`v11` uses Secret Service via `secret-tool lookup xdg:schema
chrome_libsecret_os_crypt_password_v2 application "Grok Bot"`. Windows uses
`%APPDATA%/Grok Bot` or `~/AppData/Roaming/Grok Bot`; `Local State` contains
`os_crypt.encrypted_key` (base64). Remove its five ASCII `DPAPI` prefix bytes,
then unprotect with DPAPI CurrentUser, null optional entropy, through PowerShell.
For each encrypted value, decode base64, require `v10`, use bytes 3–14 as a
12-byte IV, final 16 bytes as authentication tag, and intervening ciphertext
with AES-256-GCM and the unprotected key; decode plaintext UTF-8. No PBKDF2 is
used on that path. Linux/Windows have no app-bundle version fallback
(`grokBotAppDataPath`, `safeStorageKey`, `decryptSafeStorageString`,
`readKeychainPassword`, `readWindowsSafeStorageKey`, `unprotectWithDpapi`,
`decryptWindowsSafeStorageString`, `grokBotAppVersion`).

## Open questions

- **Observed:** server-managed ("temporal" harness) bots reject gateway sends
  and may refuse gateway deletion. Bot Deck now uses the backend send/delete
  contracts in [server-api.md](server-api.md); server transcripts and routines
  remain outside this implementation.

- **Observed:** `nextBeforeSeq` suggests the server pages backwards, but gbot
  never sends a matching request field. How should a client request older pages?

- What is the macOS keychain account name? `readKeychainPassword` selects only
  service `Grok Bot Safe Storage`; no account selector appears.
- What are the complete server response and transcript schemas, including
  mutation acknowledgments and pagination? `readJson` is permissive and several
  wrappers ignore or pass through responses; no authoritative schema is bundled.
- Does the server offer direct routine controls or a Grok live/working-state
  subscription? No such call appears in the gateway client; server source is absent.
- How does the app choose among multiple v2/v3 descriptor entries or invalidate
  cached routes? `encryptedPayload` rejects multiple entries and reads no expiry;
  the app's writer/selection logic is not included.
- Does `clientNonce` guarantee server-side deduplication, and for how long?
  `sendPrompt` uses it for transcript receipt lookup only; no replay guarantee
  or retention period is defined.

## Rules our client must keep

- Require HTTPS and the host allow-list for every request carrying a credential
  (backend: `cursor.sh`, `cursor.com` and their subdomains; gateway: also
  subdomains of `cursorvm.com`).
- Refuse redirects.
- Never retry a write.
- Keep the 30 s deadline and 2 MiB response-body cap.
- Redact secrets from error text.
- Re-check the active account before and after a refresh; discard the route if
  it changed.

WIL-42 and WIL-43 must keep these rules.
