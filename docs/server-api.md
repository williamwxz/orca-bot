# Grok Bot server API

Read-only bundle research for WIL-56, 2026-11-14. Source:
`/Applications/Grok Bot.app/Contents/Resources/app.asar`.
SHA-256: `4f1c458f85448a5e307c2330b92cb8d17f1f75ddc470fbb67a53815700339ffe`.
The bundled client-version fallback is `0.79.4` (search `Y3("0.79.4")`).
No session files, keychain, running plugin, or network were used.

The JavaScript is minified. Names such as `Obt`, `Il`, `p8`, and `j3` below are
**minified aliases**, not stable public names. Backtick snippets are short search
anchors in that archive. Schema names are also searchable. Examples are invented;
responses illustrate shapes, not captured traffic. **Inferred** marks conclusions
that the client code alone does not establish.

## What Bot Deck needs first

Implement this smallest set in order:

1. Know each bot's harness, runtime id, and server record id
   ([section 1](#1-routing-identity)). The inspected code consumes roster
   `harness`, but does not establish that raw gateway `listAgents` rows always
   carry it or the server record id. `ListGrokBotAgents` is the confirmed source
   for all three fields; use it to fill gaps rather than assuming gateway rows
   are sufficient. Whether it is required for every gateway build is unsettled.
   Evidence: `raw:l.harness,previous:r.get(d)`, `function cA(e,t,n)`, `serverId:e.id`.
2. Send with `SendGrokBotUserMessage` ([section 3](#3-sending-a-message)).
3. Delete with `DeleteGrokBotAgent` ([section 4](#delete)).
4. Read with `ListGrokBotTranscriptEntries` if the gateway tail does not serve
   server-run bots ([section 5](#5-transcript-reads-and-live-updates)).
5. Add `ListGrokBotAgentAutomations`, `SetGrokBotAgentAutomationEnabled` for
   pause/resume, and `DeleteGrokBotAgentAutomation`
   ([section 6](#6-routines-and-automations)).

## 1. Routing identity

The coordinator records each roster row's `id` and `harness`. `"temporal"` means
server-run; `"box"` means gateway-run. An omitted harness preserves the previous
value, defaulting to `"box"`. Any other supplied value becomes `"unsupported"`.
Do not convert an unknown supplied value to box. Evidence:
`Wue({raw:r,previous:e})` and `raw:l.harness,previous:r.get(d)`.

Gateway `listAgents` rows use `id`. Backend `ListGrokBotAgents` rows have both
`agentId` (the runtime id) and `id` (the server record id). The server roster
adapter maps `agentId` to local `id`, and backend `id` to local `serverId`.
It keeps only rows with `harness === "temporal"`. Evidence:
`n.agents.filter(a=>a.harness==="temporal")`, `function cA(e,t,n)`,
`serverId:e.id`. Keep both identifiers: messaging uses `agentId`; profile
updates below use `serverId`.

Backend roster request: `ListGrokBotAgents` with `{}`. Optional wire fields are
`role: string`, `includeTeamAgents: boolean`, `addedTeamAgentsOnly: boolean`.
Response: `{agents: GrokBotAgent[], slackConnections: [], truncated: boolean,
teamsConnections: []}`. The local adapter returns `{status:"ready", agents,
boxAgentCount}` or `{status:"disabled"}` when its feature gate is off. These are
local roster states, not the action status wrapper. Evidence:
`ListGrokBotAgentsRequest|1 role`, `ListGrokBotAgentsResponse|1 agents`,
`function aM(e)`.

Made-up backend row and its local counterpart (partial fields):

```json
{"agentId":"00000000-0000-4000-8000-000000000001","id":"example-record","name":"Planner","harness":"temporal"}
{"id":"00000000-0000-4000-8000-000000000001","serverId":"example-record","name":"Planner","harness":"temporal"}
```

## 2. Transport and authentication

`performServerAgentAction({method,args})` is local IPC. It is **not** an HTTP
endpoint, and its envelope must not be POSTed to `/api/performServerAgentAction`.
`Obt` constructs typed clients and dispatches each method to a separate RPC.
Evidence: `createServerAgentActionPerformer`, `function Obt(`,
`case"deleteAgent":return await v(ee.args)`.

The default backend is `https://api2.cursor.sh`; configuration can override it.
Precedence is `sandBackendUrl`, `cursorApiBaseUrl`, default. RPC paths are
`/aiserver.v1.GrokBotService/<PascalCaseMethod>`, unless another service is named
below. Evidence: `wh="https://api2.cursor.sh"`,
`new URL(e??t??wh)`, `typeName:"aiserver.v1.GrokBotService"`,
`name:"SendGrokBotUserMessage"`, `function vh(e,t,n)`.

The desktop uses Connect over HTTP/1.1, POST, binary protobuf by default.
Unary request and response bodies are individual protobuf messages. Streaming
uses Connect framing, not a sequence of gateway JSON responses. The bundled
transport also supports JSON serialization; using JSON for a new plugin client
is **inferred** to work from that transport for the methods below.

**Observed** (reviewer-reported existing Bot Deck behavior, not a new test):
Bot Deck already calls `EnsureSandBox` on this same GrokBotService with
`content-type: application/json`, `connect-protocol-version: 1`, and only the
five auth/context headers listed in
[protocol.md section 2](protocol.md#2-gateway-route-and-refresh): `authorization`,
`x-cursor-client-type`, `x-cursor-client-version`, `x-sand-box-namespace`, and
`x-cursor-team-id` when selected. The server answers. Unary JSON therefore works
for at least this method without the additional optional headers below; it
remains untested for every other method documented here. Header construction
is shared by `ensureSandbox` and the backend calls in `src/transport.ts`.

The examples here use protobuf-JSON field names for readability: camelCase;
64-bit integers as decimal strings; bytes as base64; enum numbers shown where
useful. Evidence: `useBinaryFormat:e.useBinaryFormat??!0`,
`httpVersion:e.httpVersion??"1.1"`, `function a5(e)`,
`method:(u=c.init.method)!==null&&u!==void 0?u:"POST"`,
`application/proto`, `application/connect+proto`, `application/connect+json`.

Header sources:

| Header | Value/source | Search anchor |
| --- | --- | --- |
| `authorization` | `Bearer` backend access token, not gateway token | `u3t(e,e.backend.backendUrl)`, `Bearer ${r.accessToken}` |
| `x-cursor-team-id` | Selected team, only a positive safe integer; account scope checked during selection | `async function ni(e)`, `expectedAccountScope:` |
| `x-cursor-client-type` | `sand` | `uL="sand"` |
| `x-cursor-client-version` | App semantic version; dev/lab suffix outside prod | `function q3(e,t)`, `function X3(e)` |
| `x-sand-box-namespace` | `prod`, `dev`, or `lab` from backend configuration | `function pL(e,t,n)` |
| `x-cursor-client-os` | Platform, e.g. `darwin` | `"x-cursor-client-os":e.clientOS` |
| `x-cursor-client-source` | Desktop source becomes `sand-desktop` | `function iwe(e)` |
| `user-agent` | Generated Mozilla-style string containing `Sand/<version>` | `function cwe(e)` |
| `x-request-id` | Existing id or a new UUID | `n.header.set("x-request-id",c)` |
| `x-cursor-checksum` | Time-dependent prefix plus machine id, if machine id exists | `function $_(e)`, `i.set("x-cursor-checksum",$_(o))` |
| `x-ghost-mode` | Privacy-mode result; fallback is privacy-safe | `async function iOe(e,t)`, `privacy-safe fallback` |
| `x-cursor-timezone` | Send-message device time zone if available | `Nzn="x-cursor-timezone"` |
| Connect headers | Content type, protocol version and timeout from transport | `function $U(`, `Connect-Protocol-Version`, `Connect-Timeout-Ms` |

The backend token is the same **kind of account access token** used for
EnsureSandBox in [protocol.md](protocol.md#2-gateway-route-and-refresh).
The app's GrokBotService client uses `getAccessToken({backendUrl})`; its special
`getGrokBotAccessToken` substitution applies only to `InferenceService/Stream`.
Thus reusing Bot Deck's loaded account access token is **inferred**, with high
confidence; no token was inspected or authenticated. Evidence:
`async function u3t(e,t)`, `n.service.typeName==="aiserver.v1.InferenceService"`.
Do not substitute the EnsureSandBox response's gateway token.

Additional experiment, lineage, trace, and workload headers are conditionally
added. They are not proof of server requirements. Evidence:
`x-dev-experiment-overrides`, `IPe(e.lineage)`, `function p3t(e,t)`.
Which optional headers a standalone client may omit for methods other than
EnsureSandBox remains untested.

For unary binary calls, content-type is `application/proto`; for a JSON
implementation use `application/json`. Both use `connect-protocol-version: 1`
and the RPC request itself as body, with no method/args envelope. Streams use
`application/connect+proto` or `application/connect+json`. Evidence:
`function gT(e,t,n,r,o)`, `a.set(VU,zU)`, `function $U(`.
A JSON request example (**inferred** server compatibility):

```http
POST https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgentAutomations
content-type: application/json
connect-protocol-version: 1
connect-timeout-ms: 20000
authorization: Bearer example-access-token
x-cursor-client-type: sand
x-cursor-client-version: 0.79.4
x-sand-box-namespace: prod
x-cursor-client-os: darwin
x-cursor-client-source: sand-desktop
x-cursor-team-id: 42

{"agentId":"00000000-0000-4000-8000-000000000001"}
```

The example team and token are invented; omit team when none is selected.
The example leaves out dynamic checksum/privacy/request-id headers described
above and is not a tested minimal-header recipe.

Timeouts in the app are per call: send/status and automation calls 20 s;
create 45 s; delete 60 s; profile update 30 s; transcript list and blob presign
15 s; blob fetch 30 s. Watch uses a caller abort signal without a fixed call
timeout at its call site. Evidence: `qo=2e4`, `timeoutMs:45e3`, `FYn=6e4`,
`U1n=3e4`, `qte=15e3,Fte=15e3,Vte=3e4`,
`watchGrokBotTranscripts(g,{signal:E})`.
Bot Deck's existing 30 s cap is a separate project policy, not this app's policy.

### Local action results versus wire results

`Hn`/`Il` convert backend RPC results and Connect errors to these IPC replies.
They are not an HTTP success-body schema. Evidence: `function Hn(e,t)`,
`function Il(e,t)`, `function HM(e)`.

| Local result | Meaning / fields |
| --- | --- |
| `{status:"ok",value:...}` | Successful mapped result; value can be null, array, or object |
| `{status:"unimplemented"}` | Connect Unimplemented |
| `{status:"unimplemented",scope:"agent"}` | Connect NotFound plus `x-grok-bot-refusal: box_harness` |
| `{status:"refused",message,failureCode}` | Business rejection; failureCode may be null; some paths add `retryAfterMs` |
| `{status:"unavailable",kind,message}` | Transport/access failure |

`unavailable.kind` maps ordinary exceptions to `network`; Connect Unavailable
and ResourceExhausted to `network`; DeadlineExceeded to `timeout`;
Unauthenticated/PermissionDenied to `access_denied`; Internal/Unknown/DataLoss
to `http_5xx`. Other Connect errors normally become `refused`, with method-specific
exceptions. Evidence: `case D.Code.DeadlineExceeded`, `kind:"access_denied"`,
`Npe="x-grok-bot-refusal",u1n="box_harness"`.

Connect error JSON has `code`, optional `message`, and optional `details`
containing typed/base64 values. Streaming termination can carry `error` and
`metadata`. Evidence: `code:(0,BU.codeToString)(e.code)`,
`function UU(e)`. Preserve HTTP/Connect failure separately from local mappings.

## 3. Sending a message

Local action: `sendPrompt`. Required practical args are `agentId`, `prompt`,
`clientNonce`. It maps to **SendGrokBotUserMessage**, not gateway `sendPrompt`.
The nonce becomes `messageId`; text becomes `text`; the app adds current
`sentAtMs`. Evidence: `case"sendPrompt":{let{args:o}=t`,
`messageId:o.clientNonce,text:o.prompt`.

Wire fields:

- `agentId`, `messageId`, `text`, `sentAtMs`.
- Optional strings: `richText`, `replyToId`, `replyQuote`, `traceparent`,
  `mcpConfigJson`, `machineId`, `taskId`, `language`.
- `sessionId` is omitted by the mapper when empty; protobuf default is `""`.
- `isFork` boolean; `attachmentPaths` and `attachmentNames` string arrays.
- Optional int64 `enterEpochMs`, `composedAtMs`, `firstSentAgeMs`. The last is
  elapsed age, computed from local `firstSentAtMs`, not an epoch timestamp.
- `source` enum from desktop/mobile; `initiator` from user/template_import/
  template_share/card_action/plugin_setup/teach_recording; `sendSource` from
  chat/push/app_intent/action_button_dictation, or unspecified.
- Optional booleans `onePasswordAppInstalled`, `rendersMcpElicitationForms`;
  string array `renderedCardKinds`.

Evidence: `SendGrokBotUserMessageRequest|1 agent_id`, `function nft(e,t,n)`,
`function lo(e)`, `function eft(e)`, `function Qzn(e)`, `function Vzn(e)`,
`function zzn(e)`. Only advertise UI capabilities Bot Deck actually supports.
The desktop injects its own capabilities; that is not a plugin requirement
(`rendersMcpElicitationForms:!0`).

Invented minimal request and partial response:

```json
{"agentId":"00000000-0000-4000-8000-000000000001","messageId":"00000000-0000-4000-8000-000000000002","text":"Plan tomorrow","sentAtMs":"1800000000000","sessionId":"","isFork":false,"attachmentPaths":[],"attachmentNames":[]}
{"dispatched":true,"mode":3,"delivery":2,"workflowId":"example-workflow"}
```

Response fields: `dispatched: boolean`, `mode: GrokBotTemporalHarnessMode`,
optional `workflowId`, `delivery: GrokBotUserMessageDelivery`, optional `refusal`.
The refusal mapper consumes `message` and `failureCode` strings and converts
an empty failureCode to null (`function fi(e,t)`).
Delivery values are 0 unspecified, 1 accepted box, 2 accepted temporal,
3 duplicate, 4 refused. Mode values are 0 unspecified, 1 off, 2 shadow,
3 live, 4 box. The adapter accepts deliveries 1/2/3 as
`{status:"ok",value:{accepted:true}}`; refusal is mapped; unspecified/unknown
is rejected. It does not return the nonce as a confirmed transcript entry id.
Evidence: `SendGrokBotUserMessageResponse|1 dispatched`,
`"GrokBotUserMessageDelivery",[[0,"UNSPECIFIED"]`, `unknown-delivery:`.

**GetGrokBotSendStatus** takes `{agentId,messageId,sessionId?,taskId?,firstSentAgeMs?}`.
Response: `status` enum, optional `echoEntryId`, `rejectionCode`, `acceptedAtMs`.
Statuses: 0 unspecified, 1 not found, 2 accepted, 3 rejected, 4 pending,
5 unknown durability. Example:
`{"agentId":"00000000-0000-4000-8000-000000000001","messageId":"00000000-0000-4000-8000-000000000002"}`
→ `{"status":2,"echoEntryId":"example-entry","acceptedAtMs":"1800000000100"}`.
Evidence: `GetGrokBotSendStatusRequest|1 agent_id`,
`GetGrokBotSendStatusResponse|1 status`, `function lft(e)`.

The desktop has a narrow send recovery: after Connect Unavailable without
`retry-after`, or a non-Connect exception, query status; resend only when
not found; treat a found non-rejected record as accepted. Other failures use
`Il`. Evidence: `function qzn(e)`, `function dft(e,t=()=>{})`.
This does not establish nonce retention or safe replay for Bot Deck.
Keep the repository's no-write-retry rule; a status read can report uncertainty
without resending.

## 4. Creating, updating, deleting

### Create

Local `resolveAgentCreation {}` is a feature-gated local decision, not a wire
method. It returns `{kind:"box"}` or `{kind:"temporal",scope}`; scope binds
backend URL and account scope. Local create requires that temporal route plus
`clientNonce`. The nonce is the new runtime agent id. Evidence:
`async resolve(){return await e.isEnabled()`,
`A scoped Temporal creation identity is required`, `agentId:n.clientNonce`.

Wire RPC: **CreateGrokBotTemporalAgent**. It shares CreateGrokBotAgentRequest:
`agentId`, `name`, `description`, `title`, `avatarShape`, `avatarColor`, optional
`avatarDataUrl`, `harness` enum (2 = TEMPORAL), `kickstartRequested`,
`introductionSuppressed`, optional `language`, `createdAutomatically`,
`visibility` (2 = TEAM), `teamId`, `botBuilderRequested`.
The desktop maps missing title/avatar strings to empty, PNG bytes to a data URL,
and suppresses introduction unless kickstart is requested. The schema also
has `legacyAgentId`, `purpose`, `origin`, `createIntent`, `createCaller`, but
this path does not set them. Evidence: `function hat(e)`,
`createGrokBotTemporalAgent:{name:"CreateGrokBotTemporalAgent",I:cl`,
`CreateGrokBotAgentRequest|1 legacy_agent_id`.

Example:

```json
{"agentId":"00000000-0000-4000-8000-000000000003","name":"Planner","description":"Plan tasks","title":"Planning","avatarShape":"egg","avatarColor":"blue","harness":2,"kickstartRequested":false,"introductionSuppressed":true}
{"agent":{"agentId":"00000000-0000-4000-8000-000000000003","id":"example-record-new","name":"Planner","harness":"temporal"},"harness":2}
```

Wire response is `{agent?,harness}`. The app requires matching `agent.agentId`
and string `agent.harness === "temporal"`, then returns local
`{agent: normalizedAgent, transcript:[]}`. Evidence:
`CreateGrokBotAgentResponse|1 agent`,
`The server did not confirm the Temporal creation identity`.

### Update identity/instructions

This is a sibling API, not `performServerAgentAction("updateAgent")`.
The UI uses the server identity path when a row has `serverId`; otherwise it
uses the ordinary local update path. Backend RPC: **UpdateGrokBotAgent**.
Request: `{id: serverId, partialUpdate:true, name?,description?,title?,
avatarShape?,avatarColor?, avatarDataUrl? | clearAvatar?:{}}`.
`avatarDataUrl` and `clearAvatar` are mutually exclusive protobuf oneof fields.
Response: `{agent}`; missing agent is an error. Timeout 30 s.
Evidence: `updateIdentity:async(g,{avatarPngBase64:y,...A})`,
`partialUpdate:!0`, `function s$n(e)`,
`UpdateGrokBotAgentRequest|1 id`, `UpdateGrokBotAgent returned no agent`,
`runTeammateIdentityWrite`.

Example: `{"id":"example-record","partialUpdate":true,"description":"Plan carefully"}`
→ `{"agent":{"id":"example-record","agentId":"00000000-0000-4000-8000-000000000001","description":"Plan carefully","harness":"temporal"}}`.
Do not send gateway's nested `{profile:{...}}` to this endpoint.

### Delete

Local `deleteAgent {id: runtimeAgentId}` maps directly to
**DeleteGrokBotAgent** `{id: runtimeAgentId}`. The result is ignored on success;
local value is null. NotFound is also success; PermissionDenied is refused.
Evidence: `function E_t(e)`, `deleteGrokBotAgent({id:n},{timeoutMs:FYn})`, `DeleteGrokBotAgentResponse`.

Example: `{"id":"00000000-0000-4000-8000-000000000001"}` → empty successful
RPC response; local result `{"status":"ok","value":null}`.
For bulk deletion the coordinator partitions temporal and box ids, deletes
server ids individually, and mirrors successful server deletions to gateway
`deleteAgents` in the background. It combines refused/failed id arrays.
It does not fall back to gateway deletion after server failure. Evidence:
`server_agent_delete_failed`, `box_delete_mirror_deferred`,
`Ce.status==="refused"?Re.push(Pe):ee.push(Pe)`.

## 5. Transcript reads and live updates

These bypass `performServerAgentAction`. `resolveServerTranscriptTail` supplies
`{enabled,legacyEnabled,baseUrl,headers}` locally using the backend auth headers.
Signed-out returns disabled. Temporal ids are required server transcript sources,
even if legacy server-tail support is off. Evidence:
`resolveServerTranscriptTail:async()=>`, `function j3(r)`,
`E.legacyEnabled===!1&&!w`, `requiredAgents`.

### Read a page

**ListGrokBotTranscriptEntries** request:
`{agentId, generation?: uint32, beforeSeq?: uint64, limit: uint32,
sessionId: string, unreadBoundaryMs?: int64}`.
Response: `{entries, generation, cloudAgentPeerIds, cloudAgentPeerIdsKnown,
unreadAnchor?, updatedSeqLocked}`. Each entry has `seq`, `entryKind`, optional
`body` bytes, optional `blobHash`, `updatedSeq`, optional `entryId`, `bodyOmitted`.
Unread anchor has `hasNewerRows`, `entryId`, `seq`, `newerRows`.
Evidence: `ListGrokBotTranscriptEntriesRequest|1 agent_id`,
`ListGrokBotTranscriptEntriesResponse|1 entries`, `GrokBotTranscriptEntry|1 seq`,
`GrokBotTranscriptUnreadAnchor|1 has_newer_rows`.

Example empty page:

```json
{"agentId":"00000000-0000-4000-8000-000000000001","sessionId":"","limit":40,"beforeSeq":"120"}
{"entries":[],"generation":1,"cloudAgentPeerIds":[],"cloudAgentPeerIdsKnown":true,"updatedSeqLocked":false}
```

`body` decodes to UTF-8 JSON transcript entries, then the app validates it and
uses outer `seq`. Invalid bodies are dropped. JSON transport represents body
bytes as base64. Evidence: `JSON.parse(h.decode(p))`,
`server transcript row body is not JSON`, `seq:Number(R)`.

A missing inline body is not an empty message. For `blobHash`, call
**PresignSandBoxStoreReads** with `{relPaths:["blobs/<hash>"]}`; response
`instructions` supplies `relPath` and signed `url`; GET the blob bytes.
For `bodyOmitted`, re-list with same generation/session, `beforeSeq = seq + 1`,
`limit = 1`, and select the matching seq. Evidence:
`presignSandBoxStoreReads({relPaths:g.map(B=>`, `mL="blobs/"`,
`beforeSeq:we+BigInt(1),limit:1`, `function Wte(r,e)`.
Signed-URL destinations and validity were not observed. Do not forward the
account bearer token to blob URLs (**implementation recommendation**).

The app pages with `limit + 1`, determines whether another page exists, and
reverses the returned rows for display. It carries generation to avoid mixing
histories. Evidence: `limit:C+1`, `gW(N.entries,C)`, `se.toReversed()`.
The specific `getAgentThread {id,rootId}` gateway call still exists, but I found
no matching server RPC or complete rootId-to-session mapping. A server page is
not proven equivalent to that thread call. See open questions.

### Watch

**WatchGrokBotTranscripts** is server-streaming Connect. Request:
`{cursors:[{agentId,generation,afterUpdatedSeq,sessionId}],
includeUnlistedAgents?:boolean,inlineBodyMaxBytes:uint32}`.
Example: `{"cursors":[{"agentId":"00000000-0000-4000-8000-000000000001","generation":1,"afterUpdatedSeq":"120","sessionId":""}],"inlineBodyMaxBytes":65536}`.
The byte limit here is illustrative, not the desktop's proven default.
Evidence: `kind:i.ServerStreaming`, `GrokBotTranscriptCursor|1 agent_id`,
`WatchGrokBotTranscriptsRequest|1 cursors`.

Frames are a protobuf oneof. Relevant fields:

| Frame | Payload | Search anchor |
| --- | --- | --- |
| `connected` | streamId, serverTimeMs, absoluteLifetimeMs | `GrokBotTranscriptWatchConnected|` |
| `rows` | agentId, generation, entries, deletes, replay, sessionId | `GrokBotTranscriptWatchRows|` |
| `cleared` | agentId, newGeneration, sessionId | `GrokBotTranscriptWatchCleared|` |
| `cursorTooOld` | agentId, generation, sessionId | `GrokBotTranscriptWatchCursorTooOld|` |
| `heartbeat` | serverTimeMs | `GrokBotTranscriptWatchHeartbeat|` |
| `agentState` | live[], snapshot, client[] | `GrokBotTranscriptWatchAgentState|` |
| `agentStateChanged` | agentId, families[], changedAtMs | `GrokBotTranscriptWatchAgentStateChanged|` |
| `rosterChanged` | kind, agentId, changedAtMs, optional agent, changedFields[] | `GrokBotTranscriptWatchRosterChanged|` |
| `turnFailed` | agentId, sessionId, turnId, code, summary, failedAtMs, optional errorDetails, account | `GrokBotTranscriptWatchTurnFailed|` |

There are also `computerActions`, `boxState`, and `pageTitleChanged` frames
(`GrokBotTranscriptWatchFrame|`). Invented partial JSON frame:
`{"rows":{"agentId":"00000000-0000-4000-8000-000000000001","generation":1,"entries":[],"deletes":[{"seq":"120","updatedSeq":"121","entryId":"example-entry"}],"replay":false,"sessionId":""}}`.

Updates are ordered by `updatedSeq`, not just `seq`; stale versions are ignored.
Deletions have seq/updatedSeq/optional entryId. Evidence:
`J.updatedSeq>=R.updatedSeq`, `GrokBotTranscriptEntryDelete|1 seq`.
A minimal first implementation can poll ListGrokBotTranscriptEntries
(**implementation recommendation**). Streaming reconnect/backoff and generation
reset behavior need a fuller port; do not treat the stream as SSE text or assume
it never expires (`absoluteLifetimeMs`, `cursorTooOld`).

## 6. Routines and automations

### Direct server methods

All RPCs in this table use GrokBotService and a 20 s desktop timeout.
Local ids called `id` become wire `agentId`. Time zone is optional and comes
from the app's user override/detection. Evidence: `function Eft(e)`,
`let c=e.resolveTimeZone()`, `timeoutMs:2e4`.

| Local action | Wire RPC and exact request fields | Wire response |
| --- | --- | --- |
| getAgentAutomations `{id}` | ListGrokBotAgentAutomations `{agentId,timeZone?}` | `{automations: GrokBotAgentAutomation[]}` |
| listAccountAutomations `{agentIds}` | ListGrokBotAccountAutomations `{agentIds,timeZone?}` | `{agents:[{agentId,automations,unavailable,readIndividually}]}` |
| setAgentAutomationEnabled `{id,automationId,isEnabled}` | SetGrokBotAgentAutomationEnabled `{agentId,automationId,isEnabled,timeZone?}` | `{automations:[...]}` |
| deleteAgentAutomation `{id,automationId}` | DeleteGrokBotAgentAutomation `{agentId,automationId,timeZone?}` | `{automations:[...]}` |

Search anchors for the table are each exact RPC name plus `Request|` or
`Response|`, for example `SetGrokBotAgentAutomationEnabledRequest|`.
`GrokBotAgentAutomation` is `{automationId,recordJson,viewerPermissions}`;
`viewerPermissions.allowedActions` supplies OPEN/TOGGLE/EDIT/DELETE capabilities.
The adapter parses `recordJson`; it does not return the wrapper unchanged.
Evidence: `GrokBotAgentAutomation|1 automation_id`, `function CA(e)`,
`function Fpe(e)`.

The parsed record must have string `id`, `name`, `prompt`, `schedule`,
`triggerDescription`, `filePath`; object `trigger`; boolean `isEnabled`;
number `createdAt`; array `runs`. Invalid records are dropped. Extra record
fields are preserved except viewerCapabilities, which is derived from permissions.
Sorting is nextRunAt then createdAt. Evidence: `function y1n(e)`,
`let{viewerCapabilities:n,...r}=t`, `function t2(e)`.

Invented wire calls and results (empty arrays are valid shape examples):

```text
ListGrokBotAgentAutomations
{"agentId":"00000000-0000-4000-8000-000000000001","timeZone":"America/Los_Angeles"}
=> {"automations":[]}
ListGrokBotAccountAutomations
{"agentIds":["00000000-0000-4000-8000-000000000001"]}
=> {"agents":[{"agentId":"00000000-0000-4000-8000-000000000001","automations":[],"unavailable":false,"readIndividually":false}]}
SetGrokBotAgentAutomationEnabled
{"agentId":"00000000-0000-4000-8000-000000000001","automationId":"example-routine","isEnabled":false}
=> {"automations":[]}
DeleteGrokBotAgentAutomation
{"agentId":"00000000-0000-4000-8000-000000000001","automationId":"example-routine"}
=> {"automations":[]}
```

Pause uses false; resume uses true. Local successful list/toggle/delete returns
the parsed record array, wrapped in `{status:"ok",value:[...]}` by `Hn`.
Do not confuse outer server `automationId` with parsed `recordJson.id`: the
webhook path explicitly looks up a record by its inner id and then uses the
outer id. Ordinary toggle/delete forward their supplied automationId unchanged.
Evidence: `CA(C)?.id===c.automationId`, `automationId:A.automationId`,
`automationId:c.automationId`.

### All-routine merging and fallbacks

`listAllAutomations` is a coordinator aggregate, not a backend RPC. With no
known temporal ids it reads gateway only. Otherwise it requests server batches
through listAccountAutomations. A globally unimplemented batch method falls
back to individual getAgentAutomations reads (four concurrent reads).
Per-agent `readIndividually` also triggers that route. Evidence:
`request:{method:"listAccountAutomations"`, `await Promise.all([Re(),Re(),Re(),Re()])`.

Successful server rows replace gateway rows for those agent ids, including
successful empty lists. Unavailable/unimplemented reads retain gateway rows.
If gateway listing fails but some server reads succeeded, server rows alone are
returned. Aggregate shape is `[{agentId,automation: parsedRecord}]`.
Evidence: `filter(ee=>!oe.has(ee.agentId))`,
`listAllAutomations keeps the box rows`,
`listAllAutomations serves the server rows alone`.
This is a read fallback; it is not permission to replay mutations on gateway.

### Create, edit, and ordinary run-now

This build exposes gateway commands for these operations, but they are absent
from the server-action whitelist `Wb` and dispatcher `Obt`:

| Command | Exact local/gateway args | Declared reply |
| --- | --- | --- |
| createAgentAutomation | `{id,spec}` | record array |
| updateAgentAutomation | `{id,automationId,spec}` | record array |
| runAgentAutomationNow | `{id,automationId,sessionId?}` | void |
| rerunAutomationFromCard | `{id,automationId,entryId}` | record |

Evidence: `createAgentAutomation:(0,b.rpcMethod)()`,
`runAgentAutomationNow:(0,b.rpcMethod)()`,
`createAgentAutomation:{args:"object",reply:"array"}`,
`runAgentAutomationNow:{args:"object",reply:"void"}`,
`if(Y===null)`, `return await le()` in `p8`.
No direct server create/update/run-now RPC was found. Whether those gateway
commands can operate on temporal bots is unknown; source routing is not proof
of backend success. Do not invent CreateGrokBotAgentAutomation or equivalent.

`spec` is `{name:string,prompt:string,trigger,isEnabled?:boolean}`. A cron
trigger is `{type:"cron",schedule:string,firesAt?:string,
window?:{earlyMinutes:number,lateMinutes:number},timing?:"exact"|"flexible"}`.
Other trigger tags are slack, github, origin, microsoftTeams, linear, sentry,
pagerduty, email, webhook; group has at least two listener triggers.
Their provider-specific values need validation beyond this reference.
Evidence: `DZe=(0,b.rpcObject)`, `P_n=(0,b.rpcObject)`,
`(0,ke.payloadParsed)("at least two triggers"`, `VZe=(0,b.rpcUnion)`.

Invented gateway examples, **not server HTTP methods**:

```json
{"id":"00000000-0000-4000-8000-000000000001","spec":{"name":"Daily plan","prompt":"Plan today","trigger":{"type":"cron","schedule":"0 9 * * *"},"isEnabled":true}}
{"id":"00000000-0000-4000-8000-000000000001","automationId":"example-routine","spec":{"name":"Daily plan","prompt":"Plan tomorrow","trigger":{"type":"cron","schedule":"0 10 * * *"}}}
{"id":"00000000-0000-4000-8000-000000000001","automationId":"example-routine","sessionId":""}
```

The sample cron's interpretation/timezone is **inferred** and untested.
Create/update return arrays consumed by the routine store; run-now then
refreshes routines. Evidence: `await t.createAgentAutomation({id:e,spec:n})`,
`t.runAgentAutomationNow(m?`, `t=await n(e)`.

### Webhook run is a separate operation

`getAutomationWebhookCredential {id,automationId}` first lists routines and
requires a webhook trigger. It calls DashboardService
**CreateAutomationWebhookApiKey** `{automationId: outerServerAutomationId}`
→ `{apiKey}`. Local result is `{url,key}`. URL is backend origin plus
`/automations/webhook/<encoded outer automation id>`. Evidence:
`Routine is not webhook-triggered`, `createAutomationWebhookApiKey`,
`new URL(\`/automations/webhook/`.

`runAutomationWebhook {id,automationId,context,page?}` POSTs JSON
`{context,page?:{canvasId,slots:string[]}}` to that URL, authenticated with
`Bearer <webhook apiKey>`, not the account token. It returns local
`{runId: response.runUuid or null}`. Timeout 20 s. Evidence:
`name:"sand-automation-webhook-run"`, `authorization:\`Bearer ${A}\``,
`function _1n(e)`.
Example body `{"context":"Prepare a plan","page":{"canvasId":"example-page","slots":["summary"]}}`
→ `{"runUuid":"example-run"}` → local `{"runId":"example-run"}`.
This does not implement ordinary run-now for cron/event routines.

The desktop stores webhook credentials securely and checks account continuity;
this research did not access that storage. Deletion also removes the local
cached key. Evidence: `Account changed while accessing webhook credentials`,
`await a().remove(u)`.

### Team routine sibling API

The team UI has another 20 s API. List NotFound/PermissionDenied/Unimplemented
becomes local `{kind:"off"}`. Evidence: `function Tft(e,t,n=`, `R1n=`.

| RPC | Request | Response |
| --- | --- | --- |
| ListGrokBotAgentRoutines | `{agentId,timeZone?}` | `{routines: GrokBotAgentRoutine[],routinePolicy?}` |
| SetGrokBotAgentRoutineEnabled | `{agentId,automationId,isEnabled,timeZone?}` | `{routine}` |
| SetGrokBotAgentRoutineForTeam | `{agentId,automationId,forTeam,timeZone?}` | `{routine}` |
| SetGrokBotAgentAllowCollaboratorAutomationCreation | `{id,allow}` | `{routinePolicy}` |

Anchors: `Gpe={list:"listGrokBotAgentRoutines"`, and each RPC's `Request|`.
Example: `{"agentId":"00000000-0000-4000-8000-000000000001","automationId":"example-routine","forTeam":true}`
→ `{"routine":{"automationId":"example-routine","routineId":"example-local-routine","name":"Daily plan","isEnabled":true,"isTeamRoutine":true}}`
(partial record).

Routine fields are automationId, routineId, name, triggerDescription,
triggerPresentationJson, schedule, isEnabled, optional nextRunAtMs, createdAtMs,
runAsUserId, runAsDisplayName, runAsIsViewer, optional recordJson,
viewerPermissions, isTeamRoutine, viewerCanSetForTeam. Policy fields are
allowCollaboratorCreation and viewerAllowedActions (CREATE/CHANGE_POLICY).
The adapter returns `{kind:"available",automations,policy}` for list and
`{kind:"updated",automation}` or `{kind:"updated",policy}` for writes.
NotFound becomes refused/not-found; permission denial with
`x-grok-bot-refusal: routine_not_manageable` becomes refused/not-manageable.
Evidence: `GrokBotAgentRoutine|1 automation_id`,
`GrokBotAgentRoutinePolicy|1 allow_collaborator_creation`, `function Cft(e)`.
These permission controls do not create or edit a routine's prompt/schedule.

## 7. Routing rules to preserve

| Action | App route / failure behavior | Evidence |
| --- | --- | --- |
| Send | temporal → server; box → gateway; temporal unimplemented throws, unavailable throws | `The server does not support ${D} for Temporal agents`, `function Sn(r,e)` |
| Transcript | Separate server list/watch source for required temporal ids | `requiredAgents`, `resolveServerTranscriptTail` |
| Delete | temporal → server first, then successful ids mirrored; box → gateway | `box_delete_mirror_deferred` |
| Create | resolve route; box → gateway; temporal → backend; unsupported temporal creation fails, no fallback | `Server-owned Temporal creation is not supported by this server` |
| Update profile | row with serverId → sibling backend identity API; otherwise ordinary update | `updateGrokBotAgent({serverId:n.serverId,changed:r` |
| Routine list/toggle/delete | temporal → server action; box → gateway | `function Wb(r)`, `function Q4(r)` |
| All routine list | server/gateway merge with read fallbacks above | `listAllAutomations keeps the box rows` |
| Routine create/edit/run-now | gateway command in this build; temporal success unproven | whitelist `Wb`, `if(Y===null)` |

The generic dispatcher refuses unsupported harnesses for supported routed
methods. Unimplemented for a required temporal action is generally an error,
not a fallback; non-required server attempts may use their explicit fallback.
Unavailable is not a gateway retry signal. Notification toggles have an explicit
background gateway mirror; routine mutations do not. Evidence:
`Unsupported agent harness`, `if(Et.status==="unimplemented")`,
`case"setAgentNotifyOnUpdates":return{scope:"temporal",mirrorGateway:!0}`.

For Bot Deck, add backend methods beside gateway methods, preserve raw harness
and both ids, and keep the existing credential destination policy, redaction,
body cap, account checks, and no-write-retry rule. This is an implementation
recommendation, not behavior recovered from the app.

## 8. Open questions

- JSON requests against these endpoints other than the reviewer-reported
  EnsureSandBox call were not tested. The bundled Connect
  transport supports JSON, but this desktop path defaults to protobuf. Required
  optional headers and current server compatibility remain unknown.
- No direct backend routine create/edit/ordinary-run-now mapping was found.
  Those commands bypass the server-action whitelist. Their behavior for temporal
  bots cannot be established without server source or authorized live testing.
- No backend equivalent of gateway getAgentThread/rootId was found. Session
  ids exist in transcript RPCs; the complete UI thread mapping was not traced.
- The full GrokBotAgent record, refusal detail union, provider trigger schemas,
  automation runs, and agentState live/client record schemas are not reproduced.
  This reference records fields consumed by the relevant adapters and the core
  wire schemas; it is not a generated schema package.
- The exact default watch inline-body size, reconnect policy, cursor reset
  algorithm, and all retention limits were not established. Wire frames expose
  lifetime and cursor-too-old events, so a production stream must handle them.
- Nonce deduplication lifetime and ambiguous-send durability are unknown. The
  status API and desktop recovery code do not establish a general replay guarantee.
- Current feature gates, account/team permissions, hosted configuration overrides,
  rate limits, and actual endpoint availability remain unknown. No account state
  or network was inspected.
- Whether delete accepts server record id as well as runtime id is unknown.
  The coordinator supplies runtime id; profile update supplies serverId. Preserve
  this distinction rather than assuming interchangeability.
- Parsed routine id versus outer automation id equality is not guaranteed by
  the inspected code. Webhook operations explicitly translate; preserve both.

## Ten-line research summary

1. High confidence: roster `harness` distinguishes temporal and box; omitted values preserve history/default box.
2. High confidence: performServerAgentAction is local IPC dispatch to typed GrokBotService RPCs.
3. High confidence: default backend is api2.cursor.sh; desktop uses Connect POST/protobuf with account bearer and optional selected team.
4. High confidence in token source; inferred compatibility with Bot Deck's existing account token and a JSON-only client.
5. High confidence: SendGrokBotUserMessage and GetGrokBotSendStatus expose delivery/status enums and nonce correlation.
6. High confidence: CreateGrokBotTemporalAgent, UpdateGrokBotAgent, and DeleteGrokBotAgent exist; update uses server record id.
7. High confidence: server transcript pages and WatchGrokBotTranscripts exist; complete thread mapping/reconnect behavior remains open.
8. High confidence: server automation list, batch list, pause/resume, delete, webhook run, and team-policy RPCs are mapped.
9. High confidence in gateway routing, unknown success: routine create/edit/ordinary-run-now have no server mapping in this build.
10. No new live validation; existing EnsureSandBox JSON success is reviewer-reported, while other methods and optional-header requirements remain untested.


## Implemented in Bot Deck

- Unary Connect JSON for ListGrokBotAgents, SendGrokBotUserMessage and
  DeleteGrokBotAgent, with the existing EnsureSandBox headers and 30 s deadline.
- Gateway roster harness takes precedence; missing harness is filled from one
  backend roster read by runtime agentId. Failed enrichment leaves serverRun
  false; backend-only bots are not added. The harness map is replaced per list.
- Known temporal sends/deletes use the backend. Other bots use the gateway;
  definite send HTTP 409 or delete refusedAgentIds allows one backend attempt.
  Send fallback preserves the nonce. No timeout, dropped connection or 5xx
  triggers another write, and no gateway delete mirror is performed.
- Delivery numbers 1/2/3 and names ACCEPTED_BOX, ACCEPTED_TEMPORAL, DUPLICATE
  (also with GROK_BOT_USER_MESSAGE_DELIVERY_ prefix) mean accepted. Number 4,
  REFUSED (also prefixed), or a refusal object means rejected; other delivery
  values mean unknown. Names are compatibility choices because this reference
  only reproduces the numeric values and the UNSPECIFIED enum search anchor.
  Acceptance does not turn the nonce into a transcript entry id.
- Connect authentication/permission failures map to sign-in for reads and
  refusal for writes; Unimplemented means unsupported version; delete NotFound
  counts as already deleted. Errors are redacted with the account token.
- Scope follows WIL-56 part 3: only temporal is serverRun; other supplied
  harnesses retain gateway routing, unlike the desktop unsupported-harness
  guard. No backend create/profile, transcript, routines, status polling,
  streaming, optional headers, or desktop mutation replay is implemented.

These calls have fake-fetch coverage only; live JSON compatibility remains
unverified. Runtime agentId is used for delete, not the server record id.
