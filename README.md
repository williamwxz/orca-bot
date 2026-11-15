# Bot Deck

A team of bots inside Orca. Bot Deck is being rebuilt on
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) and does nothing useful yet:
the panel only shows a status message and a Retry button.

Planned design:

- OpenMausBot does the work, running bots locally on your agent CLIs.
- Its web UI in an Orca browser tab is the chat.
- Claude and Codex use its MCP server.
- The plugin starts or finds the server, opens the tab and shows a roster.
- A pinned, tested OpenMausBot version is raised by an automatic check.

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
