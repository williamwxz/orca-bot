# Bot Deck for Grok Bot

An [Orca](https://github.com/stablyai/orca) plugin that puts your Grok Bot bots in Orca's right
sidebar: pick a bot, read and send messages, create and delete bots, edit instructions, and
request scheduled tasks.

Unofficial. Not made or endorsed by xAI or Cursor.

Bot Deck uses its own client to connect directly to Grok Bot with the session of the
signed-in Grok Bot desktop app.

## Requirements

- Orca 1.4.246 or newer (desktop app)
- macOS
- The Grok Bot desktop app, signed in

## What it reads and sends

Bot Deck reads the Grok Bot app's Safe Storage key from the macOS keychain
(macOS may ask you to allow this) and the app's session files in its data folder.
It keeps the key and session data in memory only. It sends session credentials
and your requests only to Grok Bot's own servers: hosts under `cursor.sh`,
`cursor.com`, and `cursorvm.com`.

## What it does

| Feature | How |
| --- | --- |
| List and select bots | Reads your bots from Grok Bot and refreshes the list automatically |
| Read a conversation | Refreshes recent messages while the panel is visible |
| Send a message | Sends your message directly to the bot and shows a working indicator while it replies |
| Create, hide, delete a bot; edit instructions | Sends changes to Grok Bot |
| Schedule a task | Sends the bot a clearly worded request; Grok Bot creates routines from chat |
| See recent routine changes | Reads routine events from the latest messages; this is not a full routine list |

Bots that run on Grok Bot's server can be messaged and deleted through the
backend API. Conversation reads still use the gateway. Routines cannot be
listed, paused or edited directly (ask the bot in chat). Forms and attachments
open in the Grok Bot app. The bot's computer view is not shown.

## Panel appearance

The sidebar has round search/new controls, shape avatars, name/preview rows and a
Hidden Bots group. Search filters names locally, including hidden matches;
Escape or clearing the field closes it. Messages use the bot's colour with a
contrast-checked foreground, and the send button sits inside the composer.
Neutral surfaces follow Orca's light/dark theme.

Avatar shapes are original SVG drawings. Empty shape/colour values use the
desktop's ID defaults: UTF-16 FNV-1a, an integer mixer into eight shapes, and
the first Mulberry32 draw into ten colours. Bundle search anchors:
`function Dn(e)`, `function Nn(e)`, `function Pn(e)`, `function Mn(e)` in
`index.eager-common-DcDxc78C.js`; `function Pk(e)` / `function Fk(e)` in
`index.eager-app-Cji2jV06.js`. Unknown shape names draw a rounded square.

The main bot appears once as a centered, selectable header, identified by
`settings.mainAgentId` from `GetGrokBotUserRuntimeSettings` (ordinary request
`{}`). Each list reads that setting alongside any needed roster enrichment;
lookup failures leave all bots available in ordinary rows. Search also filters
the header. Names and roster roles are never used to guess the main bot.
Bundle anchors: `function oIt(e)` calls the RPC and passes `a.settings` to
`function eIt(e)`; `function Kp()` supplies that ID to the desktop sidebar.

## Layout

- `panel/`: the sidebar UI (HTML, CSS, TypeScript; Orca transpiles it, no build step)
- `src/worker.ts`: handlers for panel actions
- `src/session.ts`: reads the signed-in desktop app's session
- `src/connection.ts`: owns the connection route and refreshes it when needed
- `src/transport.ts`: shared HTTP transport, credential checks and backend headers
- `src/gateway.ts`: gateway calls and gateway/backend routing
- `src/server.ts`: backend roster, send and delete calls
- `shared/model.ts`: data shapes and message wording used by both panel and worker

## Develop

```sh
orca plugin validate .
orca plugin test .         # uses fake sessions and fake HTTP responses; never touches a real account
orca plugin dev watch .    # loads the folder into Orca and reloads on save
```

Protocol credit: learned from the MIT-licensed [grok-bot-cli (gbot) source](https://github.com/ScriptedAlchemy/grok-bot-cli); see [protocol notes](docs/protocol.md).

## License

MIT
