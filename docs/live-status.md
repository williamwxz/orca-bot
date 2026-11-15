# Live status in Bot Deck

Read-only research for WIL-48, 2026-11-14. Source:
`/Applications/Grok Bot.app/Contents/Resources/app.asar`.
SHA-256: `2ce3b335f3d92c7be6ad59da397f8f6bf16c6d29474041ec5cc1e508b65b8e48`.
This differs from the archive fingerprint in `server-api.md`. Treat aliases as
specific to this inspected build. No account files, keychain, plugin execution,
or network requests were used. Only this document was created.

Every backtick anchor below is searchable in the archive unless a repository
file is named. Function names such as `Axn`, `wX`, `Dk`, and `X3` are **minified
aliases**, not public API names. An alias can occur in several bundled modules;
use its adjacent literal to identify the right occurrence. Schemas are translated
from the bundle's compact protobuf descriptors. Examples are invented.
**Inferred** marks conclusions not established directly by the source.

## Result

The custom sentence comes from `agentState.live[].activity.detail`, when
`activity.kind` is `"tool"` and `activity.tool` is `"SetStatus"`. The desktop
formats that sentence locally. Other tools map to local phrases. The UI does
not derive this line from transcript `rows` or pointer-action frames.
Anchors: `GrokBotAgentLiveActivity|`, `function Kie(n)`,
`case yb.SetStatus`, `sand-activity-mark__label`.

**Polling exists.** `ListGrokBotAgentStatuses` returns the same live-state
message type at `statuses[].live`. Prefer validating this unary route before
building a stream just for a status label. Its schema and unary method are
confirmed; live endpoint availability and JSON acceptance were not tested.
Anchors: `ListGrokBotAgentStatusesRequest|`, `GrokBotAgentStatus|`,
`listGrokBotAgentStatuses:{name:`.

Bot Deck currently renders `Working…` with animated dots while its local
waiting state is `working`. It suppresses that bubble when any bot entry is
streaming, and displays `Writing…` on streaming entries. Its `slow` state says
`Still working. The reply will appear here.`
Anchors in `panel/app.ts`: `function replyState`, `function renderMessages`,
`entry.role === 'bot' && entry.streaming`, `function bubble`.

## 1. Trace from the label to the wire

The one-to-one activity component `Axn` renders a small avatar beside `wX`.
`wX` renders `sand-activity-mark__label`, calls `mxn`, and wraps the text in
`Mw` (`sand-shimmer-text`). It supplies `isPaused: !isShimmering` to the shimmer.
Anchors: `function Axn(e){Axn.d=914`, `function wX(e){wX.d=916`,
`function mxn({translate:`, `sand-shimmer-text`.

The upstream chain is:

1. Watch frame `agentState` is filtered to accepted agents and passed to
   `onAgentState`; the coordinator calls `Y.ingest(k)`.
   Anchors: `case"agentState":`, `onAgentState:k=>`.
2. State store `X3` consumes `live[]`. `Wie` maps the wire record to a local
   record. `Kie` maps `activity` to `currentActivity`, accepting only kinds
   `thinking` and `tool`. Empty optional activity strings are omitted locally.
   Anchors: `function X3(n)`, `function Wie(n){let e=n.isRunning`,
   `function Kie(n){let e=n.activity`.
3. `K3` aggregates sessions. `_Lr` merges live state into a temporal roster
   agent; `n4n` selects activity for the viewed session. The transcript passes
   `currentPresence.activity` into `E2`, then `F1n`, then the activity component.
   Anchors: `function K3(n)`, `function _Lr(e,t)`, `function n4n(e,t`,
   `agentActivity:r.currentPresence.activity`, `function F1n(e){let t=(0,Q.c)(38)`.
4. `mxn` calls `XP(Dk(activity, options), phraseDraw)`. `Dk` chooses a tool
   label or the `SetStatus` sentence. `XP` translates standard phrase keys;
   a custom `status` falls through to its formatted text.
   Anchors: `function mxn({translate:`, `function Dk(e,t={})`, `function XP(e,t=0)`.

For `SetStatus`, the feature gate `sand_side_model_status` must be true for the
desktop to show the custom detail. The formatter trims `detail`, strips a
leading case-insensitive `is `, capitalizes its first character, collapses
whitespace, and truncates through `G_` with limit 60. `G_` avoids splitting a
grapheme at the truncation boundary and appends `…`. It does not parse tool
arguments here. Anchors: `function Wie(e){return e?.sand_side_model_status`,
`case yb.SetStatus`, `function dut(e){let t=e.replace`, `var uut=60`,
`function Tk(e)`, `function G_(e,t){if(e.length<=t)`.

Examples of local mapping: `WebSearch` → search phrase; `WebFetch` → read-web
phrase; `Task` with target `computerUse` → computer phrase; unknown/missing
tool → generic working phrase. These are not a universal rule to display
`detail` for every tool. `Dk` uses detail differently for MCP connectors and
some file tools. Anchors: ``case`WebSearch` ``, ``case`WebFetch` ``,
``case`Task` ``, `function fut(e)`.

### Wire records

Types below use protobuf JSON spelling. `int64`/`uint64` are decimal strings
on JSON transport; `uint32` is a JSON number. `?` means optional presence;
arrays default empty. The full live record is included so session and expiry
logic need not be guessed. Each row's anchor is its schema name followed by `|`.

| Record | Fields and types |
| --- | --- |
| `GrokBotTranscriptWatchAgentState` | `live: GrokBotAgentLiveState[]`, `snapshot: boolean`, `client: GrokBotAgentClientState[]` |
| `GrokBotAgentLiveState` | `agentId: string`, `isRunning: boolean`, `isComposingMessage: boolean`, `isRetrying: boolean`, `activity?: GrokBotAgentLiveActivity`, `awaiting?: GrokBotAgentAwaitingState`, `updatedAtMs: int64`, `staleAfterMs: int64`, `boxHandoffRequestId?: string`, `boxHandoffInstruction?: string`, `sessionId: string`, `activeGroupMemberId?: string`, `hasRunningSubagents: boolean`, `surfaceTaskId?: string`, `workingTaskIds: string[]`, `lastTurnSettlement?: GrokBotTurnSettlement` |
| `GrokBotAgentLiveActivity` | `kind: string`, `tool: string`, `detail: string`, `target: string`, `callId: string` |
| `GrokBotAgentAwaitingState` | `tabId: string`, `reason: string`, `sinceMs: int64` |
| `GrokBotTurnSettlement` | `turnId: string`, `outcome: string`, `settledAtMs: int64`, `clientNonce: string` |
| `GrokBotAgentClientState` | `agentId: string`, `lastViewedAtMs?: int64`, `unreadCount: uint32`, `lastActivityAtMs?: int64`, `lastEntryId?: string`, `lastEntryKind?: string`, `lastMessageId?: string`, `lastMessagePreview?: string`, `notificationsEnabled: boolean`, `notifyOnUpdatesEnabled: boolean`, `hiddenFromSidebar: boolean`, `updatedAtMs: int64`, `lastEntryPreview?: GrokBotAgentEntryPreview`, `lastMessageTaskId?: string`, `removedFromSidebar?: boolean`, `unreadThreadCount: uint32`, `lastEntryPreviewEntryId?: string` |

`client` is read/unread/sidebar/preview state, not the current activity.
`lastEntryPreview` is an unrelated preview union; its nested schemas are not
needed to draw status. Anchor: `GrokBotAgentClientState|`.

Made-up JSON message inside a Connect envelope:

```json
{
  "agentState": {
    "snapshot": false,
    "live": [{
      "agentId": "00000000-0000-4000-8000-000000000001",
      "sessionId": "",
      "isRunning": true,
      "isComposingMessage": false,
      "isRetrying": false,
      "activity": {
        "kind": "tool",
        "tool": "SetStatus",
        "detail": "is checking the NVDA shares",
        "target": "",
        "callId": "example-call"
      },
      "updatedAtMs": "2000000000000",
      "staleAfterMs": "90000"
    }],
    "client": []
  }
}
```

**Inferred example:** in an active one-to-one session, before its freshness
expires, with `sand_side_model_status` enabled, this produces
`Checking the NVDA shares`. It may wait for the UI's minimum display duration.
This is not a captured frame. Anchors: `case yb.SetStatus`, `function dut(e)`,
`function Abn(e,t,n`.

`agentStateChanged` only supplies `agentId: string`, `families: string[]`,
`changedAtMs: int64`. It triggers family refresh; it does not carry the sentence.
`computerActions.actions[]` supplies `agentId/type/button: string`,
`x/y: double`, `count: uint32`, `atMs: int64`; it describes mouse actions.
Anchors: `GrokBotTranscriptWatchAgentStateChanged|`,
`onAgentStateChanged:k=>`, `GrokBotComputerAction|`.

## 2. Lifecycle and exact fallbacks

### Running, changing, and stopping

A live record is locally busy when `isRunning || hasRunningSubagents`.
Activity is discarded when neither is true. Composing and retry flags are
accepted only while the root `isRunning` is true. Session selection also
suppresses ordinary running presence while awaiting user response.
Anchors: `function Wie(n){let e=n.isRunning`, `function n4n(e,t`.

`M1n` selects `typing` when running and composing, `working` when running
without composing, and `none` otherwise. `F1n` mounts on a non-none mode and
uses a 140 ms exit when it becomes none. There are additional usage-refusal
holds, group rules, setup/greeting states, and suppression under cards.
Anchors: `function M1n({isAgentRunning:`, `exitUntilMs:S+140`,
`function N1n(e){return M1n`, `function F3n(e)`.

Activity changes are coalesced: a shown activity normally stays for at least
800 ms; a newer one is queued until then. Equal display keys preserve the
original shown time. With the status gate on, a transition to missing activity
can retain the preceding typing/activity display for 800 ms. Elapsed text
appears after 60 seconds for a shown activity. This elapsed text is not a
turn timeout. Anchors: `function Abn(e,t,n`, `n-e.shownAtMs>=800`,
`let F=M?(N??S)+800:null`, `function Mbn(e,t)`.

The avatar can appear while its text is quiet. Generic working text is hidden
for the first 5 seconds; thinking text has a 2.5-second quiet period when the
status gate is on. The clock can use the recorded turn start. A specific
SetStatus detail has no such generic-text delay. Anchors: `var T1n=5e3,E1n=2500`,
`function P1n(e,t)`, `isStatusQuiet:q`, ``if(a===`quiet`)return null``.

The store rejects older `updatedAtMs` per agent/session. A snapshot removes
sessions/client state absent from that snapshot; a delta updates its supplied
records. A running record expires after positive `staleAfterMs`, or 90 seconds
if that value is nonpositive, minus its age since `updatedAtMs`. Expiry clears
running/activity/composing state but retains awaiting/handoff information.
Anchors: `H!==void 0&&U<H`, `O.snapshot?R(O):new Set`, `var Fie=9e4`,
`j=G>0?G:Fie`, `J.live={...z3`.

A finished reply is not itself a universal stop signal: the bot can send a
message and continue working. Running state, composing state, session/card
rules, and freshness drive this component. **Inferred**: a current idle live
record is a stronger completion signal than merely finding a new transcript
message. Anchors: `function M1n`, `function F3n`, `function Wie(n)`.

`turnFailed` is forwarded as `server-turn-failed`; renderer handlers add failure
state, call `noteTurnFailure(agentId)`, and handle usage-limit refusal. I did
not establish that every failure immediately clears the roster's running flag.
Do not claim that this frame alone is the desktop's universal unmount trigger.
Anchors: `onTurnFailed:k=>`, `"server-turn-failed":e=>`, `noteTurnFailure:e=>`.

### Immediately after send

The desktop has local send overlays and tracks pending sends separately from
server presence. The transcript receives both `sendStates` and running state;
its row placement can hold a prior indicator during a send. Anchors:
`onOptimisticReconciled`, `for(let e of m?.values()??[])Lwe(e)`,
`isHeldForSend:Qe`.

**Could not determine:** the complete ordinary-send path that first turns on
the avatar before the first server activity event, including whether it always
shows a local placeholder and its exact duration. The local overlay evidence
alone does not prove an optimistic running flag. The display rules above are
confirmed once running presence reaches the component. For Bot Deck, keeping
its existing immediate local `Working…` is a design recommendation, not a
claim of exact desktop parity.

### Exact English fallback wording

The visible fallback is not always `Working` or `Working…`. `mxn` calls `YP`
when activity is absent, or `XP` for an activity's text kind. A random
`phraseDraw` selects a phrase, which is retained across some updates. These
are alternatives, not a proven timer-driven rotation. Anchors: `function mxn`,
`function _X(e,t,n=Math.random)`, `function YP`, `var BDt=`, `VDt=`.

| Condition | Exact English text | Search anchors |
| --- | --- | --- |
| Missing activity or generic working | `Getting it done`, `Making progress`, `Working on it`, `Handling it`, `Chipping away` | `dfCCPD`, `ZVMmJH`, `RQqcwV`, `2z3X8R`, `p0demG` in English catalog; `VDt` |
| Thinking activity | `Thinking it through`, `Mulling it over`, `Putting it together` | `np8SXe`, `h3LL7E`, `Px2Nkv`; `BDt` |
| Typing without specific activity | `Typing…` | `PxYAul`, `function mxn` |

`Dk` internally returns `Working`/`Thinking`, but `XP` replaces those recognized
text kinds with the phrase lists. A disabled SetStatus gate or empty detail
falls back through the generic working path. Anchors: `case yb.SetStatus`,
`HDt={thinking:BDt,working:VDt`, `function XP`.

## 3. Polling sources

### Confirmed unary status schema

POST to:
`https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgentStatuses`.
The origin can be configured, as for the watch below. Use the backend account
headers and unary `content-type: application/json`; the body is ordinary JSON,
without a five-byte envelope. Anchors: `gA="https://api2.cursor.sh"`,
`typeName:"aiserver.v1.GrokBotService"`,
`listGrokBotAgentStatuses:{name:"ListGrokBotAgentStatuses"`, `kind:p.Unary`,
`function $G(n)`.

```json
{"agentIds":["00000000-0000-4000-8000-000000000001"]}
```

Request schema: `ListGrokBotAgentStatusesRequest {agentIds: string[]}`.
Response: `ListGrokBotAgentStatusesResponse {statuses: GrokBotAgentStatus[]}`.
Each status: `{agentId: string, live?: GrokBotAgentLiveState,
client?: GrokBotAgentClientState, isRunning: boolean}`.
The nested live/client types are exactly those used by the stream.
Anchors: the three schema names followed by `|`; the `GrokBotAgentStatus`
descriptor references `Hf,xa`, as does the corresponding watch-state schema.

Read custom text at `statuses[].live.activity.detail`, under the same formatter
conditions. **Inferred:** polling this RPC can supply the requested status
without a stream. The bundle contains its generated method/schema, but no
actual `listGrokBotAgentStatuses(...)` call was found. Thus it establishes
client protocol support, not backend implementation, rate limits, or a desktop
poll interval. Its top-level `isRunning` versus nested `live.isRunning`
aggregation semantics are unknown; preserve both and require the nested live
record for a specific activity sentence.

**Recommendation:** first test this one-agent unary read when live testing is
authorized. If it works, reuse Bot Deck's visible-chat polling cadence, use one
in-flight request, and stop on panel close/account change. Stream only if
polling misses short-lived activity or the RPC is unavailable.

### Transcript reads

`ListGrokBotTranscriptEntries` returns transcript rows and paging metadata,
not `live` activity. Its row body is UTF-8 JSON carried as protobuf bytes.
The gateway `getAgentTranscriptTail` documented in `protocol.md` returns
entries and pagination; no live-status field is established there.
`isStreaming` describes message progress, not this activity sentence.
Anchors: `ListGrokBotTranscriptEntriesResponse|`, `GrokBotTranscriptEntry|`,
`JSON.parse(h.decode(p))`; repository `docs/protocol.md`,
`getAgentTranscriptTail` and `isStreaming`.

No reliable reconstruction of current SetStatus from transcript entries was
found. This is a bounded negative finding, not proof that no server ever stores
a related tool record. `GetGrokBotSendStatus` concerns delivery/echo/rejection,
not activity text. Anchor: `GetGrokBotSendStatusResponse|1 status`.

## 4. Connect stream implementation reference

### Endpoint, headers, and codec

POST `https://api2.cursor.sh/aiserver.v1.GrokBotService/WatchGrokBotTranscripts`.
Configuration precedence is `sandBackendUrl`, `cursorApiBaseUrl`, default
origin. The desktop resolves transcript access and uses its supplied backend
headers on every call. This is not `/api/WatchGrokBotTranscripts` on the gateway.
Anchors: `gA="https://api2.cursor.sh"`, `function C6(e,t)`,
`HC.methods.watchGrokBotTranscripts.name`,
`resolveServerTranscriptTail`, `Object.entries(w.headers)`.

Proposed JSON headers (values below are placeholders):

```http
content-type: application/connect+json
connect-protocol-version: 1
authorization: Bearer <backend-account-access-token>
x-cursor-client-type: sand
x-cursor-client-version: <installed-app-version>
x-sand-box-namespace: prod
x-cursor-team-id: <selected-team-if-any>
x-request-id: <new-request-uuid>
```

The desktop also has OS/source/user-agent/privacy/checksum and conditional
experiment headers. Their sources are in `server-api.md` section 2; no live
validation establishes which may be omitted. Do not fabricate checksum or
account context. Reuse Bot Deck's validated credential-destination and account
checks. Header anchors: `Bearer ${r.accessToken}`, `ow="sand"`,
`"x-cursor-client-os":e.clientOS`, `function aw(e,t,n)`,
`I.header.get("x-request-id")==null`, `Connect-Protocol-Version`.

The inspected desktop watch constructs a transport without a JSON override;
`Y5` defaults `useBinaryFormat` to true. Thus this path sends protobuf by
default. It is not a protobuf-only client library: `GG` constructs both codecs,
`h5` uses `fromJsonString`/`toJsonString`, and `$G.stream` chooses input and
output codecs using `useBinaryFormat`. The content-type parser accepts
`application/connect+json`. **Inferred, unverified:** the remote watch endpoint
accepts that codec. Bundled client support and existing unary JSON use do not
prove server-streaming JSON acceptance. Anchors: `function Y5(n)`,
`(n.createTransport??eX)`, `function GG`, `function h5`, `async stream(e,t`,
`R5="application/connect+json"`.

### Request and envelope

Request schemas (anchors are each schema name plus `|`):

- `WatchGrokBotTranscriptsRequest`: `cursors: GrokBotTranscriptCursor[]`,
  `includeUnlistedAgents?: boolean`, `inlineBodyMaxBytes: uint32`.
- `GrokBotTranscriptCursor`: `agentId: string`, `generation: uint32`,
  `afterUpdatedSeq: uint64`, `sessionId: string`.

Made-up one-agent request, starting from a previously listed page:

```json
{
  "cursors": [{
    "agentId": "00000000-0000-4000-8000-000000000001",
    "generation": 1,
    "afterUpdatedSeq": "120",
    "sessionId": ""
  }],
  "includeUnlistedAgents": false,
  "inlineBodyMaxBytes": 262144
}
```

Use the page's actual generation and a correctly tracked update cursor, not
these illustrative numbers. **Inferred:** false plus one cursor restricts
subscription to the selected agent; exact server filtering is untested. The
desktop uses `includeUnlistedAgents: true`, a 262144-byte inline limit, and up
to 256 recent cursors. A status-only subscription mode is not declared.
Anchors: `Pq=256,upe=256*1024`, `includeUnlistedAgents:!0`, `xi=()=>`.

Encode the UTF-8 request JSON into one envelope:

```js
const payload = new TextEncoder().encode(JSON.stringify(request));
const body = new Uint8Array(5 + payload.length);
body[0] = 0; // uncompressed data message
new DataView(body.buffer).setUint32(1, payload.length, false);
body.set(payload, 5);
// fetch(url, {method: 'POST', headers, body, signal, redirect: 'error'})
```

This is an implementation sketch, not executed code. The wire format is one
flag byte, then four bytes of unsigned big-endian payload length, then exactly
that many bytes. The bundled encoder uses DataView's default big-endian order.
Anchors: `setUint8(0,n),o.setUint32(1,e.length)`, `function r5`,
`protocol error: incomplete envelope`.

Decode incrementally across arbitrary fetch chunks. Neither a chunk nor a
newline is a frame boundary. Buffer five header bytes, bound the length, then
buffer that payload. Flag bit 0 indicates compression; bit 1 (`0x02`) marks
EndStreamResponse. For a minimal client, do not request Connect compression;
reject unsupported compression instead of decoding it as JSON. Ordinary
messages with flag 0 are UTF-8 JSON. These recommendations follow the bundled
split/decompress/parse pipeline. Anchors: `function c5(n)`, `function u5(n,e)`,
`var x5=2`, `function n5`, `unsupported response encoding`.

EndStreamResponse is JSON even for protobuf streams:

```json
{"metadata":{"example-trailer":["example-value"]}}
```

or:

```json
{"error":{"code":"unavailable","message":"Example failure","details":[]},"metadata":{}}
```

An empty `{}` trailer is valid. `metadata` maps header names to string arrays.
Error details have `type: string`, `value: base64 string`, and optional debug
information. Check trailer errors even after HTTP 200. Require one end trailer;
EOF without it is a protocol error, as are a second trailer or messages after
it. Anchors: `function Sle(n)`, `function qG(n,e,t)`,
`protocol error: missing EndStreamResponse`,
`protocol error: received extra EndStreamResponse`,
`protocol error: received extra message after EndStreamResponse`.

The JSON oneof is `{ "agentState": {...} }`, not
`{ "frame": { "case": "agentState", "value": {...} } }`.
The latter is the generated JavaScript representation used by the dispatcher.
Anchor: `GrokBotTranscriptWatchFrame|1 connected #0 frame` and the bundled
protobuf JSON serializer. **Inferred example encoding:** sample frames here
use the descriptor's protobuf JSON field names; no server JSON was captured.

### Frame handling and reconnection

| Frame/event | Desktop behavior / implementation consequence | Anchor |
| --- | --- | --- |
| `connected` | Payload is `streamId: string`, `serverTimeMs: int64`, `absoluteLifetimeMs: int64`. Marks the link answered/connected; invokes onConnected. Processing of other frames waits for connected. | `GrokBotTranscriptWatchConnected|`, `Ue!==null&&await RO`, `i.noteAnswered()` |
| `heartbeat` | Payload `serverTimeMs: int64`. Resets silence watchdog. First heartbeat switches from 60 s initial silence allowance to 30 s live allowance. | `GrokBotTranscriptWatchHeartbeat|`, `Pt.frame.case==="heartbeat"&&(Tt=!0)`, `kpe=6e4,bpe=3e4` |
| `agentState` | Replace missing records on snapshot; otherwise merge by agent/session and updatedAtMs. Apply per-record freshness timer. | `function X3(n)`, `O.snapshot?R(O):new Set` |
| `rows` | Carries agentId, generation, entries, deletes, replay, sessionId. Track updatedSeq, including deletes, if maintaining resumable transcript cursors. Do not treat row sequence as the update sequence. | `GrokBotTranscriptWatchRows|`, `GrokBotTranscriptEntryDelete|`, `function Ope` |
| `cursorTooOld` | Carries agentId, generation, sessionId. Reset to authoritative generation and rehydrate from list. | `case"cursorTooOld":`, `Wt(ue,B,{authoritative:!0}),await Io(ue,x)` |
| `cleared` | Carries agentId, newGeneration, sessionId. Reset the corresponding transcript generation/state. | `GrokBotTranscriptWatchCleared|`, `case"cleared":` |
| `turnFailed` | Carries agentId, sessionId, turnId, enum code, summary, failedAtMs, optional errorDetails, enum account. Forward failure for the matching turn/session. | `GrokBotTranscriptWatchTurnFailed|`, `onTurnFailed:k=>` |
| Clean trailer/EOF | Reconnect; completion of a watch is not completion of the bot's turn. | `M==="clean"`, `server-transcript-tail-clean-reconnect` |

`absoluteLifetimeMs` exists in the schema, but all occurrences found were
schema/constructor declarations. The inspected watch loop does not schedule
an expiry timer from it. It waits for stream termination and reconnects.
**Recommendation:** accept finite stream lifetimes, preserve cursors, and
reconnect on clean end. Do not interpret the lifetime field as a turn deadline.
Its exact server enforcement and whether the value is relative to opening or
server time remain unknown. Anchors: `absoluteLifetimeMs`, `Wr=async(g,x)=>`,
`return M.signal.reason===Bq`.

The actual loop's reconnect policy:

- Clean end resets failures, then uses full jitter on a 3000 ms range with a
  minimum-delay hint of 500 ms. The helper makes the resulting range
  **500–3000 ms**, not exactly 500 ms. Anchors:
  `server-transcript-tail-clean-reconnect`, `delayMs:ppe`, `function vee`,
  `ppe=500,vq=3e3`.
- Failure retries start at 1000 ms and double to 60000 ms; this retry policy
  uses the helper's default no jitter. Successful clean completion resets
  failures; frames received at least 5 seconds after connected also reset
  them. Anchors: `server-transcript-tail-retry`, `initialDelayMs:fpe`,
  `n.backoffFactor??2`, `n.jitter??"none"`, `Epe=5e3`, `Ci&&x()`.
- Three consecutive failures trigger recoverable gateway fallback for legacy
  box transcripts; required temporal agents keep the server path. Recovery
  timer is 60 seconds. This is transcript routing, not a status polling API.
  Anchors: `xpe=3`, `x>=xpe&&Ve`, `falling back to the gateway for BOX agents`,
  `G8=6e4`, `pe()?!1`.
- Network return/team change replaces the stream and reconnects with full
  jitter up to 250 ms. Network-return replacement respects a 3-second minimum
  open duration. Backend-return detection may interrupt a failure delay.
  Anchors: `server-transcript-tail-network-return-reconnect`, `q8=250`,
  `mpe=vq`, `g.lifetime.abort(Bq)`, `retrying now`.

On reconnect the desktop resumes each cursor at its acknowledged update
sequence, or zero when it needs rehydration. Pending row bodies can lower that
cursor to before the missing update. It does not blindly acknowledge bodies
it has not loaded. Anchors: `B.needsRehydrate?BigInt(0):B.streamAckUpdatedSeq`,
`q.row.updatedSeq-BigInt(1)`.

## 5. Minimal Bot Deck design

This section is a recommendation, not recovered app behavior.

First validate `ListGrokBotAgentStatuses`; it avoids a streaming parser and
reconnect machinery for one short text field. The same normalization and
panel update contract can serve either source. Anchor for the opportunity:
`ListGrokBotAgentStatusesResponse|`.

If streaming is chosen, the worker owns one watch for the selected bot and
session. Open it while that conversation is visible. Cancel on selection,
account/team change, panel disposal, or worker shutdown. Keep credentials out
of the panel. Preserve the existing transport's destination policy. Read the
initial transcript generation before constructing a resumable cursor.

Normalize to a small worker-to-panel record, for example
`{agentId, sessionId, selectionEpoch, phase, text, updatedAtMs, expiresAtMs}`.
Forward through `orca.panels.post`; verify the installed Orca SDK's exact
post/listener signatures during implementation. That signature was outside
this bundle-only research. Use the selection epoch to discard late events.
Store status separately from transcript entries; include it in the render
signature so a changing sentence redraws the line. Current integration
anchors: `panel/app.ts`'s `state.drawn`, `JSON.stringify([state.selected`,
`src/worker.ts` in the repository layout.

Render the selected bot's small avatar and a plain-text shimmer label. Display
custom SetStatus detail after the documented formatting. For other tools,
either port the small phrase map or use `Working…`; do not expose arbitrary
tool arguments. Retain the local immediate waiting indicator after send.
When the stream is unavailable or fresh activity is absent, fall back to the
existing fixed `Working…` only while local waiting still warrants it. A lost
stream must not imply success. Keep the existing slow/error behavior.

Use current idle/settled state and matched failures to retire live text. Avoid
letting an old idle snapshot race with a newly submitted message; compare the
send start/nonce with update/settlement information. Keep per-agent/session
state, and apply expiry even if the connection remains alive. A heartbeat
proves transport liveness; it is not a fresh update of every activity.

Risks: JSON watch acceptance is untested; unary status deployment is untested;
one-cursor server filtering is untested; box and temporal harnesses may expose
different state; multiple sessions/subagents require correct scoping; status
feature gates vary; old snapshots can flicker after a send; stream rows add
traffic even if only activity is displayed. Reconnects require length caps,
trailer/error handling, cancellation, and freshness timers. None of these
require importing the desktop's full animation/state framework.

## 6. Open questions

- Does the deployed unary status RPC work for this account and both harnesses?
  Only generated method/schema declarations were found; no network was allowed.
- Does the deployed watch accept JSON? The client implements it, but the app
  uses protobuf by default and no JSON watch was opened.
- Which optional desktop headers are actually required? Client construction
  cannot prove server validation rules.
- Does one cursor with includeUnlistedAgents false restrict all live frames,
  including snapshots, to one agent? The desktop requests unlisted agents;
  server filtering was not available to inspect.
- How does unary `isRunning` relate to `live.isRunning`, and which session is
  returned in its singular live field? The request has only agentIds and there
  is no located caller implementing session selection.
- What exactly appears before the first server frame on an ordinary send?
  Local send overlays/indicator holds exist, but the full first-mount path
  was not traced. Do not promise exact optimistic desktop parity.
- Does turnFailed synchronously stop every activity line? Failure dispatch
  is confirmed; the complete roster/presence clearing chain was not established.
- How does the backend produce/persist SetStatus detail, and how long does it
  retain it between tools? This desktop bundle shows the consumer, not the
  model/server implementation.
- Is a related SetStatus tool record recoverable through transcript polling?
  No reliable current-status reconstruction was found; historical tool rows
  would not by themselves prove freshness.
- What does absoluteLifetimeMs mean operationally? Its schema is present,
  but no timer consumption or server implementation was found.
- What are current feature gates, rate limits, permissions, and supported bot
  types? No account state or live server was inspected.
- Exact Orca post/listener API and plugin cleanup hooks need implementation-time
  verification; this task did not load the plugin or inspect Orca runtime APIs.

## Ten-line research report

1. High confidence: custom text is live.activity.detail with kind tool and tool SetStatus.
2. High confidence: agentState.live supplies it; the app maps it to currentActivity and formats it locally.
3. High confidence: ListGrokBotAgentStatuses declares the same live type; polling viability on the deployed server is unverified.
4. High confidence: transcript list/tail has no established live-status field; reconstruction from rows was not found.
5. High confidence: the status gate, shimmer renderer, phrase alternatives, 800 ms coalescing, and freshness expiry are mapped.
6. Partial confidence in full lifecycle: running/composing/idle behavior is traced; immediate pre-frame send placeholder remains unknown.
7. High confidence: Connect envelope, JSON trailer, cursor reset, watchdogs, and desktop reconnect rules are documented.
8. High confidence: desktop watch defaults to protobuf; server-streaming JSON acceptance is inferred, not tested.
9. Recommendation: validate unary polling first; if streaming, use one selected-bot worker watch and fixed Working… fallback.
10. Open: deployed support/headers/filtering, unary session semantics, failure clearing, pre-frame UI, and absolute lifetime semantics.
