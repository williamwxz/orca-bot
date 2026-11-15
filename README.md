# Orca Bot

A team of bots inside [Orca](https://github.com/stablyai/orca).

## Summary

Orca Bot is an Orca plugin that runs the open-source
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) on your own computer
and puts it in Orca's sidebar. You get a list of bots, each one its own Claude,
Codex or Grok agent, and a chat window for each.

- **Nothing to set up.** Opening the panel installs and starts OpenMausBot for
  you. You never run a command.
- **Your existing sign-ins and tools.** Codex bots use your Codex setup. Claude
  bots use your Orca Claude login. Claude tools are shared and Orca agents are
  linked only after you approve in the setup card; change either in Orca's Settings.
- **Two places to chat.** A quick chat in the panel, and the full OpenMausBot
  page in an Orca browser tab, one click away.
- **Runs locally.** Orca Bot has no server of its own and collects nothing.

Unofficial. Not made by or affiliated with Orca, OpenMausBot or the makers of the models it runs. For now it runs on macOS only: it has not been tested on Windows or Linux, and Orca's mobile app does not show plugins yet.

## How to use

**You need** Orca 1.4.246 or newer, and Node.js 24 or newer with `node` and
`npm` on your PATH. To run bots you also need at least one of Claude, Codex or
Grok signed in on this computer.

1. Install Orca Bot in Orca and open the **Orca Bot** panel in the right
   sidebar. The first start downloads OpenMausBot (about 75 MB) and can take a
   minute. Until Orca Bot is in Orca's plugin catalog, load it from a copy of
   this repository with `orca plugin dev load .`.
2. The panel lists your bots. With none yet, press **Jump to Bot Dashboard** and
   create one there.
3. Click a bot to open its chat window. Type a message and press Enter. While
   the bot works you see a moving avatar and **Working · 3s**.
4. Press **Open bot** for the full chat in a browser tab: earlier history,
   approvals, attachments, routines, models and settings all live there.

Good to know:

- **Orca Bot: Bring in tools from my AI apps** in the command palette, or the
  matching setup-card row, copies tools from Claude Code, Claude Desktop, Cursor,
  Gemini CLI, Codex, opencode and Antigravity into OpenMausBot,
  switched off. Turn them on per bot in the Bot Dashboard.

- The panel shows the last 20 messages as plain text and sends messages of up to
  16,000 characters. Anything richer says "This needs the full chat."
- **Add MausBot** brings back the main bot if you hid it.
- The **Set up Orca Bot** card asks before sharing Claude tools or linking your
  Claude, Codex, opencode and Antigravity agents to the bots. Change either choice later in Orca's Settings.
  Read [Security review](#security-review) before allowing access.
- **Orca Bot: Stop the OpenMausBot server** in the command palette stops the
  server. It keeps running after you close the panel, so that routines and long
  tasks can finish.
- If an OpenMausBot server is already running on port 8799, 18799 or 28799, Orca
  Bot uses it as it is and never changes or stops it.

## Security review

Reviewed on 15 November 2026 against OpenMausBot 0.1.158. This describes what
the plugin does; OpenMausBot and the model providers have their own terms.

### Where your data goes

| Data | Where it goes |
|---|---|
| Messages, replies, files a bot reads | To the model provider of that bot (Anthropic, OpenAI or xAI), under your own account. This is how any bot works. |
| Chat history, bot settings, memory | Stays on this computer in `~/.orca-bot/data`, readable only by your user account. |
| Anything a tool or connector touches | To that service (for example Gmail or Linear) when a bot uses the tool. |
| Orca Bot itself | Sends nothing anywhere. It has no analytics, no account and no server. |

The panel cannot reach the network at all. The plugin's worker talks only to
`127.0.0.1`, to npm once to download OpenMausBot, and to Orca's own command
line tool to open the browser tab.

### What Orca Bot does to protect you

- **Asks first.** Nothing is shared with bots, linked to your agents or
  imported until you approve it in the setup card. You can change each choice
  later in Orca's Settings.
- **Imported tools stay on this computer.** Imported tool definitions, including
  any tokens in them, are copied into OpenMausBot's settings in `~/.orca-bot/data`;
  sources include Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex,
  opencode and Antigravity, and tools arrive switched off. Orca Bot uses an internal OpenMausBot route for this,
  which a new OpenMausBot version may change.
- **Usage analytics are off.** OpenMausBot's page sends anonymous usage events
  to PostHog by default. For a server Orca Bot starts, it switches this off
  before the page first loads. If you turn it on yourself in OpenMausBot's
  Settings, Orca Bot leaves your choice alone.
- **Local only.** The server listens on `127.0.0.1`, so other computers on your
  network cannot reach it.
- **Its own workspace.** Orca Bot uses `~/.orca-bot/data` and never opens an
  existing `~/.openmausbot`, so it cannot wake routines or connections you set
  up elsewhere.
- **A pinned version.** It installs one tested OpenMausBot version (in
  `shared/omb-version.ts`) from npm, without running install scripts. It never
  updates by itself.
- **Secrets stay out of sight.** The browser sign-in link is used once and is
  never shown, logged or returned by the plugin. Your message text is passed to
  OpenMausBot privately, not on a command line that other programs can read.
  Error messages never include raw output.
- **No logins stored.** Orca Bot does not read, copy or keep your Claude,
  Codex or Grok login. It only tells Claude which Orca login folder to use.
  The one exception is a tool import you start yourself, described above.

### Risks you should know about

1. **Bots act with your access.** A new OpenMausBot bot starts at "Full access":
   it can run commands and read files as you, without asking. Lower this per
   bot in the full chat if you want to approve each step.
2. **Shared tools give bots more access.** Claude tools are shared and Orca
   agents are linked only after you approve in the setup card. With sharing on,
   Claude bots can use your connectors, MCP servers, instructions, skills and
   hooks. A malicious page or document could trick a bot into misusing those
   tools. Change sharing and agent linking in Orca's Settings.
3. **Any program on this computer can talk to the server.** OpenMausBot trusts
   local programs as the owner. This is its design, and it means other software
   running under your account can read chats and message your bots.
4. **A reused server is trusted as it is.** If something else is already
   answering as OpenMausBot on one of the three ports, Orca Bot talks to it and
   your messages go there. Orca Bot does not switch off analytics on a server it
   did not start.
5. **The download is trusted.** The pinned version comes from npm, and npm
   checks it against its own records. Orca Bot does not add a second check.
6. **`~/.orca-bot/server.log` can contain a sign-in code.** It is readable only
   by you and is emptied on each start. Do not share it.
7. **Linked agents can drive your bots.** With agent linking on, Claude,
   Codex, opencode and Antigravity on this computer get tools to message bots, read their replies and
   create bots. Bots that share those setups get the same tools, so one bot can
   message another. The link is an entry named `orca-bot` in each agent's MCP
   settings; turn the setting off before uninstalling, or remove that entry
   yourself, because uninstalling the plugin does not remove it from any of
   these agents, including opencode and Antigravity. If opencode’s config cannot
   be safely updated, the plugin asks you to remove its entry by hand.
8. **OpenMausBot checks for updates.** It asks GitHub for its own latest release
   and npm for the latest Codex version. These requests reveal your IP address
   to those services; we found nothing else in them.

To remove everything: turn off **Let my Orca agents talk to the bots**, stop
the server from the command palette, uninstall the
plugin, and delete `~/.orca-bot`.

Found a problem? See [SECURITY.md](SECURITY.md).

## Development

No dependencies and no build step.

```sh
orca plugin types .        # generate local SDK types if missing
orca plugin validate .
orca plugin test .         # every test uses fakes; none reaches a real server
orca plugin dev watch .    # load locally and reload on save
```

## License and credits

Orca Bot is licensed under [Apache-2.0](LICENSE), the same license as
OpenMausBot, which is by milind-soni and contributors. The panel adapts its colours and layout values; see
[NOTICE](NOTICE).

The earlier Grok Bot client is kept at the tag `grok-bot-final`.
