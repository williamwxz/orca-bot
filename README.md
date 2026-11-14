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
| List and select bots | Reads your bots from Grok Bot |
| Read a conversation | Refreshes recent messages while the panel is visible |
| Send a message | Sends your message directly to the bot |
| Create, hide, delete a bot; edit instructions | Sends changes to Grok Bot |
| Schedule a task | Sends the bot a clearly worded request; Grok Bot creates routines from chat |
| See recent routine changes | Reads routine events from the latest messages; this is not a full routine list |

Bots that run on Grok Bot's server (new bots do) cannot be messaged or deleted
from Bot Deck yet; use the Grok Bot app for those bots. Routines cannot be
listed, paused or edited directly (ask the bot in chat). Forms and attachments
open in the Grok Bot app. The bot's computer view is not shown.

## Layout

- `panel/`: the sidebar UI (HTML, CSS, TypeScript; Orca transpiles it, no build step)
- `src/worker.ts`: handlers for panel actions
- `src/session.ts`: reads the signed-in desktop app's session
- `src/connection.ts`: owns the connection route and refreshes it when needed
- `src/gateway.ts`: makes the HTTP calls to Grok Bot
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
