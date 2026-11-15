# Bot Deck

Open the **Bot Deck** panel to see the bot list. Each row shows its avatar,
name, Main tag when applicable, model label and unread dot. Click a row to open
its chat window; use the back arrow to return to the list. **Open bot** opens
that bot's full chat in an Orca browser tab, reusing the existing server tab.
When there are no bots, **Open OpenMausBot** opens the browser UI where you can
create them. **Bot Deck: Open chat** remains available in the command palette.

The roster refreshes every five seconds while visible and retains the last list
when a refresh fails. Hidden bots stay hidden; **Add MausBot** restores a hidden
local MausBot using OpenMausBot's own welcome visibility settings.

For a server Bot Deck owns, a pairing screen is completed automatically, including
when a browser session expires. If that fails, press **Connect** in that browser tab.
For a server started elsewhere, sign in in the browser yourself; Bot Deck never
creates credentials or presses Connect for an external server.

Bot Deck reads the local fleet route used by OpenMausBot's CLI to obtain sidebar
visibility and stored avatars. Small stored images are passed to the panel as data
URLs; missing or oversized images use a stable generated SVG. Person-owned default
bots are omitted because the plugin does not know the browser's signed-in identity.

The panel is for a glance and a quick reply: view the last 20 entries as plain text and send a message of up to 16,000 characters. Tool steps are summarized; internal digests are hidden. Earlier history, long messages, approvals, attachments, routines, instruction editing and other rich content belong in **Open bot**. Sent messages appear immediately. While awaiting a reply or observing a working bot, a small avatar and **Working · 3s** line count elapsed time, changing to minutes after 60 seconds. Reduced motion keeps the avatar still and the elapsed text visible.

## Your existing tools

Codex bots use your Codex setup. Servers started by Bot Deck give Claude bots
your Orca Claude login and, by default, your whole Claude setup: connectors,
MCP servers, skills and instructions. More tools means more tokens per message.
Turn off **Give Claude bots my Claude tools** in Orca’s Settings to use only tools
you add in OpenMausBot. Bot Deck applies changes by restarting its server when
no bot is working or waiting; servers started elsewhere are left alone.
An existing `CLAUDE_CONFIG_DIR` environment variable takes precedence over Orca’s login.

## How it starts OpenMausBot

Install Node.js 24 or newer and make `node` and `npm` available on PATH. Bot Deck
also checks the usual Homebrew, local and Volta binary folders.

Opening the panel reuses an OpenMausBot server on port 8799, 18799 or 28799. If
none is running, it installs the tested npm package version (pinned in
`shared/omb-version.ts`) into `~/.bot-deck/openmausbot/<version>` and starts it on
the first free port. The first download is about 75 MB and can take a minute.
It keeps its own OpenMausBot workspace in `~/.bot-deck/data`, apart from any you already have in `~/.openmausbot`, so starting it never resumes routines or connections set up elsewhere. A server that is already running is reused with whatever workspace it has. Running servers with suffixed or
unknown versions are reused too; the panel notes when compatibility is unknown.

The detached server keeps running when the panel or plugin worker closes.
`~/.bot-deck/server.log` is truncated on each start and may contain a pairing
code; inspect it locally and keep it private. `~/.bot-deck/server.pid` records
the launcher PID, listening server PID and port. Use **Bot Deck: Stop the OpenMausBot server** in Orca's
command palette to stop a server this plugin started. Bot Deck checks its
listening server’s identity before signaling its launcher, waits up to 10 seconds
for health to disappear before removing the pid file, and does not stop servers
it merely reused.
Press Retry in the panel after resolving a startup error or stopping the server.

Develop with Orca 1.4.246 or newer; no dependencies or build step:

```sh
orca plugin types .        # generate local SDK types if missing
orca plugin validate .
orca plugin test .         # mounts the worker with a fake host
orca plugin dev watch .    # load locally and reload on save
```

Bot Deck is MIT licensed. Credit to milind-soni and the OpenMausBot contributors;
OpenMausBot is licensed under Apache-2.0. This plugin is unofficial and is not
affiliated with OpenMausBot or its engines.

The earlier Grok Bot client is preserved at the tag `grok-bot-final`.
