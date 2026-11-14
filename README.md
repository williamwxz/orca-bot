# Bot Deck for Grok Bot

An [Orca](https://github.com/stablyai/orca) plugin that puts your Grok Bot bots in Orca's right
sidebar: pick a bot, read and send messages, create and delete bots, edit instructions, and
schedule tasks.

Unofficial. Not made or endorsed by xAI or Cursor. It is only a front end: every action goes to
the real Grok Bot through the [`gbot` CLI](https://github.com/ScriptedAlchemy/grok-bot-cli),
which uses the Grok Bot desktop app you are signed in to. The plugin stores no credentials and
makes no network requests of its own.

## Requirements

- Orca 1.4.246 or newer (desktop app)
- The Grok Bot desktop app, signed in
- `npm install --global grok-bot-cli` (needs Node.js 22.19+)

If `gbot` is installed somewhere unusual, set **gbot path** under the plugin in Orca's Settings.

## What it does

| Feature | How |
| --- | --- |
| List and select bots | `gbot bots list` |
| Read a conversation | `gbot thread`, refreshed while the panel is visible |
| Send a message | `gbot send` |
| Create, hide, delete a bot; edit instructions | `gbot bots create / update / delete` |
| Schedule a task | Sends the bot a clearly worded request; Grok Bot creates routines from chat |
| See a bot's routines | Read from routine events in the last 200 messages |

Limits, because `gbot` has no command for them: routines cannot be listed, paused or edited
directly (ask the bot in chat), forms and file attachments must be opened in the Grok Bot app,
and the bot's computer view is not shown.

## Layout

- `panel/`: the sidebar UI (HTML, CSS, TypeScript; Orca transpiles it, no build step)
- `src/worker.ts`: the worker that turns each panel action into one `gbot` call
- `shared/model.ts`: data shapes and message wording used by both

## Develop

```sh
orca plugin validate .
orca plugin test .         # runs against a fake gbot; never touches a real account
orca plugin dev watch .    # loads the folder into Orca and reloads on save
```

## License

MIT
