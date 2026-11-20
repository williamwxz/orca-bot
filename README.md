# Bot Team for Orca

> **Retired.** Orca now has bots built in: [Orca Bots](https://orca.dev/bots) gives each bot a chat in Orca's sidebar, runs on your own Claude Code or Codex sign-in, works on paired servers, and can import bots from Hermes. Use that instead. This repository is archived and no longer maintained.

Your [Hermes Agent](https://github.com/NousResearch/hermes-agent) bots in [Orca](https://github.com/stablyai/orca)'s sidebar.

## Summary

Hermes' Bot Mode turns each Hermes profile into a bot with its own role, model, memory and skills. This plugin puts that roster in Orca: a list of your bots, and each bot's chat.

- **The list of bots** on this computer, or on an Orca server paired with it, with the last line of each chat.
- **Each bot's Bot Chat**, the same conversation Hermes Desktop shows. The newest messages load first and **Show earlier messages** pages back through the whole history.
- **Send a message** and watch the reply as it is written, with the name of the tool the bot is running.

That is all it does, on purpose. Models, skills, memory, schedules, connectors and messaging channels are set up in Hermes itself (the desktop app, `hermes dashboard`, or the CLI). The plugin runs no server and installs nothing on this computer. It keeps two things: which host you chose, and, for a paired server, the terminal it opened there (see below).

Unofficial. Not made by or affiliated with Orca or Nous Research. Tested on macOS only.

## Requirements

- Hermes Agent installed on the bot host, with `hermes` on the `PATH`. Tested with 0.23.1.
- Node.js 24 or newer on a paired server (Orca's worker runs the plugin there).

## How to use

1. Open **Bot Team for Orca** in Orca's sidebar. It connects to the Hermes gateway on this computer and starts it if it is not running.
2. Pick a bot. A bot is a Hermes profile: create one with `hermes profile create <name>` or in Hermes Desktop, and it appears here.
3. Type a message and press Enter (Shift+Enter for a new line).

With an Orca server paired, a picker above the list chooses where the bots run: **This computer** or the server. The plugin reaches the server through the same pairing Orca uses, by opening a terminal there titled "Bot Team for Orca". Add a project to Orca on that server first. The plugin's worker code is copied to that server under `~/.orca-bot/relay/<version>/` (older versions are replaced), and the terminal's handle is saved in the plugin's storage on this computer so it is reused instead of opened twice.

## What it does not do

- **Approvals and questions.** When a bot asks for approval or a clarification, answer it in Hermes. This panel declines such requests at once, so the bot is told there is no answer here and is never left waiting. Bots that should work unattended from here need an approval mode that allows it.
- **Anything but the Bot Chat.** Other sessions, group chats and cron runs are in Hermes.
- **Attachments, editing or deleting messages, changing models.**

## Security review

- The plugin talks only to the Hermes gateway on the bot host, over its local WebSocket, using a one-use ticket from `hermes gateway attach` for each bot. Tickets are never logged or shown.
- It sends your messages to the bot and reads the bot's stored chat. Nothing else leaves Hermes: profile paths, install IDs, and tool arguments and their previews in Hermes' replies are dropped before anything reaches the panel. A tool call shows as its name only, such as "Used terminal".
- Errors shown in the panel are wording written in this plugin; raw errors from Hermes or the system are replaced by a fixed line.
- On a paired server the same code runs there in a terminal Orca opens, and requests and replies travel through that terminal. Only four requests are accepted (status, list bots, read a chat, send a message).
- A bot acts with whatever access its Hermes profile gives it. A message sent from here can make it run commands, exactly as in Hermes.

Found a problem? See [SECURITY.md](SECURITY.md).

## Development

```sh
orca plugin types .      # Orca's typings, once
orca plugin validate .
orca plugin test .
node .github/scripts/check-imports.mjs
```

The Hermes side is three small files: `worker/hermes-gateway.ts` (one WebSocket per bot), `worker/hermes.ts` (roster, chat, send) and `shared/bots.ts` (what the panel is shown). They use these gateway methods: `profiles.list`, `session.list`, `session.create`, `session.resume`, `session.transcript` and `prompt.submit`, and the `message.*` and `tool.*` events. This is Hermes' own desktop protocol (`hermes-gateway-v1`), which can change between Hermes releases; `apps/shared/src/gateway-contract.openrpc.json` in the Hermes repository describes it.

## License and credits

Apache-2.0. The panel's look is adapted from OpenMausBot; see [NOTICE](NOTICE). Versions before 0.2.0 ran OpenMausBot instead of Hermes.
