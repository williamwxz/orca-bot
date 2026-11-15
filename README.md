# Bot Deck

Open the **Bot Deck** panel and press **Open chat**. OpenMausBot's chat UI opens
in an Orca browser tab; an existing tab for that server is reused. You can also
use **Bot Deck: Open chat** in the command palette after the server is ready.

On the first open of a server Bot Deck starts, press **Connect** once in the
browser to sign in. If the browser loses its session, press **Sign in again**.
For a server started elsewhere, its owner handles pairing; both buttons open
its ordinary sign-in page without creating credentials.

The panel lists bots with their engine/model, Working or Waiting state, unread
indicator, and Main badge. The main bot appears first. The roster refreshes every
five seconds while visible and keeps the last list if a refresh fails.
Click a bot to open chat, then select its conversation in OpenMausBot: this version
has no verified bot-ID-only link. **New bot** opens the same UI, where you create bots.

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
