# Bot Team for Orca

A team of bots inside [Orca](https://github.com/stablyai/orca).

## Summary

Bot Team for Orca is an Orca plugin that runs the open-source
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
- **Runs locally.** Bot Team for Orca has no server of its own and collects nothing.

Unofficial. Not made by or affiliated with Orca, OpenMausBot or the makers of the models it runs. For now it runs on macOS only: it has not been tested on Windows or Linux, and Orca's mobile app does not show plugins yet.

## When to use it

Use OpenMausBot with this plugin when:

- **You want a standing team, not one more chat.** Each bot keeps its own role,
  memory, skills and schedules between conversations, and bots can hand work to
  each other. For a single task in a repository, an ordinary Orca agent is
  simpler.
- **You already pay for Claude or Codex.** Bots run the real Claude Code and
  Codex with your existing sign-ins, so they follow those tools as they improve
  and you need no new account or API key.
- **You work in Orca.** The team sits in the sidebar, your Orca agents can
  message the bots, and nothing leaves your computer except what the models
  and connectors themselves send.
- **You want to be able to leave.** Skills are standard `SKILL.md` folders and
  memory is plain Markdown; **Export bots** writes them in the layout Hermes
  Agent, Claude Code and Codex read.

Look elsewhere when:

- You want to reach an assistant from Telegram, Discord or WhatsApp. OpenMausBot
  has its own phone app and Slack; [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  connects to many chat apps.
- You need a product with a company's support behind it. OpenMausBot is young
  and changes quickly; this plugin pins a version it was tested with.
- You are on Windows or Linux (not tested yet).

## How it is organised

OpenMausBot has one **workspace** per installation: everything under
`~/.orca-bot` on the bot host. Inside it:

| Level | What it holds | Where you set it |
|---|---|---|
| Workspace | The connector catalog, the defaults new bots start with, and switches such as **Learn skills on their own** | Settings |
| Group (OpenMausBot calls it a department) | A folder of bots in the sidebar, with shared instructions. It is not a wall: any bot can talk to any other | Drag bots, or a bot's context menu |
| Bot | Its model, **which connectors it may use**, computer, skills, memory and schedules | The gear in its chat |
| Conversation | One thread with a bot: its own transcript and context, on the bot's model unless you pick another | Full chat |

So connectors are turned on once for the workspace and then **allowed per bot**;
a newly enabled connector starts with no bots. There is no per-group or
per-conversation connector list.

## What each message costs

Every message a bot handles starts with a fixed prompt: the engine's own
instructions and tools, OpenMausBot's, and whatever you share. Measured on one
setup with a one-word message to a Claude bot:

| Setup | Tokens sent before your message |
|---|---|
| **Bots can use my tools** off | about 40,000 (estimated, not measured) |
| On (the default once you allow it) | about 52,000 |
| On, with **Include my claude.ai connectors** | about 70,000 |

Most of it is cached by the model provider after the first message of a
conversation, so later messages are billed at a fraction, but it still fills
the context window and counts toward plan limits. To spend less:

- Leave **Include my claude.ai connectors** off. That account catalog (every
  tool of every connected app) was about 18,000 tokens here, and none of it was
  assigned to a bot. Give a bot the connectors it needs under **Connectors**.
- Turn **Bots can use my tools** off for bots that need none of your Claude
  plugins, skills or instructions.
- Disable Claude Code plugins you do not use; each adds its skills and tools to
  every bot that shares your setup.

Your numbers depend on your plugins, connectors and instructions.

## How to use

**You need** Orca 1.4.246 or newer, and Node.js 24 or newer with `node` and
`npm` on your PATH. To run bots you also need at least one of Claude, Codex or
Grok signed in on this computer.

1. Install Bot Team for Orca in Orca and open the **Bot Team for Orca** panel in the right
   sidebar. Click **Install OpenMausBot** to approve downloading
   `openmausbot@0.1.171` from npm (about 75 MB) into `~/.orca-bot`.
   Opening the panel alone does not install it. Until Bot Team for Orca is in
   Orca's plugin catalog, load it from a copy of
   this repository with `orca plugin dev load .`.
2. The panel lists your bots. With none yet, press **Jump to Bot Dashboard** and
   create one there.
3. Click a bot to open its chat window. Type a message and press Enter. While
   the bot works you see a moving avatar and **Working · 3s**. Press **+**,
   paste or drop to send photos (PNG, JPEG, GIF, WebP up to 10 MB) and other
   files (up to 25 MB), at most ten per message, when bots run on this computer.
4. Right-click a bot and choose **Open native OpenMausBot** for the full chat in
   a browser tab: earlier history, approvals, routines and settings all live
   there. It is offered only when bots run on this computer.

In a panel 720px or wider, the bot list stays on the left and the open chat
fills the right, as in OpenMausBot.

Good to know:

- Open **Settings → Connectors → Manage** to discover connectors from Claude Code,
  Claude Desktop, Cursor, Codex, Gemini CLI, opencode and Antigravity on the chosen host.
  Connectors that enabled Claude Code plugins bring are listed under **Claude plugins**;
  OpenMausBot signs in to those services itself.
  Each provider's list folds; a list of more than five starts folded.
  Use **Providers** to turn connectors on and **By Bot** to audit and toggle each bot’s
  access. In a bot’s chat, the gear's **Model** and **Connectors** rows let you switch ready AI
  models and assign enabled connectors without leaving the conversation; both pickers
  are also available in the bot context menu. Model changes wait until the bot is idle
  and update its active thread. Provider and approval restrictions still apply.
  The computer icon in a chat (or **Backend** in the bot context menu) opens the
  Backend panel: where the bot may use a computer (Auto, Cloud desktop, Private
  desktop, This computer, Browser or Off), with what OpenMausBot reports about each.
  With **Private desktop** chosen, the panel shows OpenMausBot's setup steps and the
  next action (prepare, create, start, stop, or delete and recreate); **Browser** offers
  **Turn on the browser**. **Settings → Private desktops → Set up** holds the same setup plus
  Isolation (Shared or Per bot) and the idle stop time. Cloud desktops, and putting a
  full-access bot on This computer, stay in native OpenMausBot.
  Newly enabled connectors start with no bots assigned. Existing custom servers appear
  under **OpenMausBot**. Disable keeps credentials there; Remove deletes the server and
  its stored credentials and clears its bot assignments. First-run setup never imports tools.
  Codex-backed bots still load `~/.codex/config.toml` directly, independently of these mappings.
- The gear at the top right of a bot's chat opens that bot's settings, from the right:
  - **Model**, **Connectors** and **Computer**, each opening its picker. The chat
    header shows the model under the bot's name.
  - **Skills**, with a switch for each and a tag for where it comes from (**Learned**
    by the bot, **Claude Code**, **Codex** or **Agents folder** for skills its engine
    loads from your own folders, **Project**, **Library**, **Team package** or **Added**;
    Project and Library skills are switched where they come from). Writing
    skills stays in the full chat; type `/learn` there to save what a bot just did.
  - **Memory** (`MEMORY.md`), with how many of its lines load each turn, and **Edit
    memory**. A save is refused if the bot changed its memory while you were editing,
    so its newer note is never overwritten. Topic notes and daily logs stay in the
    full chat.
  - **Schedules**: the bot's OpenMausBot routines, each with a switch to pause it,
    **Run now** and **Delete**. **New schedule** adds one that runs every day or on
    weekdays at a time, every 5 to 1,440 minutes, or once. Schedules made in the
    full chat with custom timing show here and keep their timing.

- The panel shows the last 20 messages as plain text and sends messages of up to
  16,000 characters. A settled card, such as "Skill … enabled" after a bot learns a
  skill, shows as one line; anything richer says "This needs the full chat."
- **Add MausBot** brings back the main bot if you hid it.
- The **Set up Bot Team for Orca** card asks before sharing Claude tools or linking your
  Claude, Codex, opencode and Antigravity agents to the bots. Change either choice later in Orca's Settings.
  Read [Security review](#security-review) before allowing access.
- **Bot Team for Orca: Stop the OpenMausBot server** in the command palette stops the
  server. It keeps running after you close the panel, so that routines and long
  tasks can finish.
- If an OpenMausBot server is already running on port 8799, 18799 or 28799, Orca
  Bot uses it as it is and never changes or stops it.

## Settings

The gear button in the panel header opens Settings, in four parts:

- **Bot host**: **Bots run on** this computer or a paired Orca server (see below),
  and whether **OpenMausBot** is running there, with **Stop**.
- **Bots**:
  - **Connectors** → **Manage** opens the connector list (see above).
  - **Private desktops** → **Set up** opens OpenMausBot's setup steps for the
    bots' own desktops, with **Isolation** (Shared or Per bot), the per-bot
    maximum and the idle stop time.
  - **Learn skills on their own** (off by default in OpenMausBot). After a task
    with many tool steps, a bot looks back over it and may save or improve a
    skill. The review uses the bot's own AI and counts toward its usage. It
    applies to every bot on the selected host.
- **Permissions**: the choices from the setup card, which you can change at any
  time: whether bots can use your Claude tools and whether your Orca agents can
  talk to the bots. Under the first, **Include my claude.ai connectors** (off by
  default) also loads every connector of your claude.ai account into each Claude
  bot; see [What each message costs](#what-each-message-costs). They apply to the selected bot host. Remote changes also
  sync with Orca on that host.
- **Updates and export**:
  - **Updates**: the version you have and whether a newer one is out. By
    default the panel shows a banner and asks before updating; **Install
    updates automatically** updates by itself, once per new version. An update
    that asks for new access always waits for your approval in Orca. A
    development folder updates with git instead.
  - **Export bots** writes each bot's persona (`SOUL.md`), memory
    (`memories/`) and own skills (`skills/`) as plain files to a new folder in
    Downloads on the bot host, with `team.json` and a README. Each bot folder is
    laid out like a Hermes Agent profile, and the skills use the `SKILL.md`
    format Claude Code and Codex read. Each skill is the `SKILL.md` OpenMausBot
    serves; any other files a skill has are named as not exported. Chats,
    files, credentials, connector settings and library skills are not included, and anything that could not be read is
    listed when the export ends and in `team.json`. The export runs in the
    background on the bot host. For a full backup use OpenMausBot's own **Export
    full backup**.

## Use bots on a paired Orca server

When this computer has a server saved in Orca's Remote Orca Servers, Settings
shows **Bots run on** with **This computer** and each paired server. Choose one
and the panel switches at once; the choice is remembered. The first time, the
panel asks before it starts anything, so OpenMausBot is not installed here when
you only want the server's bots. With no paired servers the picker stays hidden
and the bots run on this computer.

The server needs Orca, Node.js 24 or newer, and at least one project added in
Orca there. It does not need Bot Team for Orca installed. Use **Install
OpenMausBot** in the panel to approve a download on the selected server;
connecting or polling alone never grants installation consent.
When you choose the server, the plugin opens a terminal named **Bot Team for Orca** in that
project, through Orca's existing pairing. It copies the plugin's own worker
code to `~/.orca-bot/relay` on the server and runs it there. It closes that
terminal after 10 minutes without use and opens a new one, in a few seconds,
the next time the panel needs it. OpenMausBot keeps running on the server.

The server keeps its files, bots and chat history, and starts OpenMausBot there
if it is not running yet. The client does not copy model logins, create SSH
connections, expose a bot port or ask for a second pairing
code. An unavailable server never falls back to a different bot team on this
computer.

From a paired client you can manage bots, change permissions, manage connectors from
apps on the server, and install or stop OpenMausBot. The panel does not open
native OpenMausBot or send files for bots on a paired server.
Permissions and installation consent persist in `~/.orca-bot/preferences.json`
on the bot host, shared by its local plugin and paired clients. Existing host
preferences take precedence over a stale `paired-client.json` cache on startup;
a persisted sync snapshot also preserves native Settings changes made while the
worker was closed. Subsequent changes in either Settings view sync on the next
request. Stopping the server persists across reconnects until Retry, installation
explicitly starts it again. Lifecycle operations share a host
lock, and installation uses unique staging directories.
These paths have fake-dependency coverage; two-computer live verification is pending.

Right-click a bot row to pin, rename, assign or create a group, or delete with
inline confirmation. Drag a bot onto a group heading, or onto a bot in that group,
to move it there; dropping on **Pinned** pins it. MausBot offers **Hide from list** instead of deletion.
Pinned bots and named groups get headings; an ungrouped roster stays flat.

## Security review

Reviewed on 17 November 2026 against OpenMausBot 0.1.169. This describes what
the plugin does; OpenMausBot and the model providers have their own terms.

### Where your data goes

| Data | Where it goes |
|---|---|
| Messages, replies, files a bot reads | To the model provider of that bot (Anthropic, OpenAI or xAI), under your own account. This is how any bot works. |
| Chat history, bot settings, memory | Stays on this computer in `~/.orca-bot/data`, readable only by your user account. |
| Anything a tool or connector touches | To that service (for example Gmail or Linear) when a bot uses the tool. |
| Bot Team for Orca itself | No analytics, no account and no server. It asks GitHub for the newest public release, every six hours (retrying network failures after one minute) while its panel is open; the request carries nothing about you. |

The panel cannot reach the network at all. In local mode the worker talks to
`127.0.0.1`, npm to download OpenMausBot, Orca's CLI, and GitHub's API to
check for a newer release. With a paired server
it uses Orca's CLI to type requests into its terminal there, through the
already-authorized pairing. Message text then appears briefly in the arguments
of that `orca` command on this computer.

### What Bot Team for Orca does to protect you

- **Asks first.** Nothing is shared with bots, linked to your agents or
  imported automatically. Sharing and agent linking require setup consent; connector
  imports require enabling selected connectors in Settings → Connectors.
- **Imported tools stay on the selected host.** Imported tool definitions, including
  any tokens in them, are copied into OpenMausBot's settings in `~/.orca-bot/data`;
  sources include Claude Code, Claude Desktop, Cursor, Gemini CLI, Codex,
  opencode and Antigravity, and only selected connectors are copied when enabled. Bot Team for Orca uses an internal OpenMausBot route for this,
  which a new OpenMausBot version may change. Preferences retain only provider, original
  name and a per-host keyed HMAC-SHA256 fingerprint; definitions and credentials never cross panel or relay RPC.
  Before enabling connectors, unrestricted bots receive explicit allowlists preserving
  previously enabled access. New-bot defaults restrict MCP access without changing other
  template fields; background polls reconcile later unrestricted bots, and a failed
  post-enable reconciliation switches the connector back off. Busy bots can block changes; refresh and retry when idle.
  Other OpenMausBot clients and direct provider CLI configuration can change access outside
  this panel, so refresh before reviewing assignments.
- **Usage analytics are off.** OpenMausBot's page sends anonymous usage events
  to PostHog by default. For a server Bot Team for Orca starts, it switches this off
  before the page first loads. If you turn it on yourself in OpenMausBot's
  Settings, Bot Team for Orca leaves your choice alone.
- **Local only.** The server listens on `127.0.0.1`, so other computers on your
  network cannot reach it.
- **Its own workspace.** Bot Team for Orca uses `~/.orca-bot/data` and never opens an
  existing `~/.openmausbot`, so it cannot wake routines or connections you set
  up elsewhere.
- **A pinned version.** It installs one tested OpenMausBot version (in
  `shared/omb-version.ts`) from npm using a committed lockfile with SHA-512
  integrity hashes for every dependency and `npm ci --ignore-scripts`.
  Integrity mismatches abort installation and remove staging files.
  OpenMausBot never updates on its own; when a plugin update changes the pinned
  version, a server the plugin started switches to it once bots are idle,
  after you have approved installation. Existing users are asked too.
- **Secrets stay out of sight.** The browser sign-in link is used once and is
  never shown, logged or returned by the plugin. Your message text is passed to
  OpenMausBot privately, not on a command line that other programs can read.
  Error messages never include raw output.
- **No logins stored.** Bot Team for Orca does not read, copy or keep your Claude,
  Codex or Grok login. It only tells Claude which Orca login folder to use.
  Connector credentials are copied only when you enable those connectors, as described above.

### Risks you should know about

1. **Bots act with your access.** A new OpenMausBot bot starts at "Full access":
   it can run commands and read files as you, without asking. Lower this per
   bot in the full chat if you want to approve each step.
2. **Shared tools give bots more access.** Claude tools are shared and Orca
   agents are linked only after you approve in the setup card. With sharing on,
   Claude bots can use your MCP servers, plugins, instructions, skills and
   hooks, and with **Include my claude.ai connectors** also every connector of
   your claude.ai account, whether or not a bot was assigned it. A malicious page or document could trick a bot into misusing those
   tools. Change sharing and agent linking in Orca's Settings.
3. **Any program on this computer can talk to the server.** OpenMausBot trusts
   local programs as the owner. This is its design, and it means other software
   running under your account can read chats and message your bots.
4. **A reused server is trusted as it is.** If something else is already
   answering as OpenMausBot on one of the three ports, Bot Team for Orca talks to it and
   your messages go there. Bot Team for Orca does not switch off analytics on a server it
   did not start.
5. **The download is trusted.** The pinned version comes from npm, and npm
   checks it against its own records. Bot Team for Orca does not add a second check.
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
8. **OpenMausBot checks for updates.** It asks GitHub for its latest release,
   model list and announcements, `models.dev` for provider models, and npm for
   the latest Codex version. These requests reveal your IP address to those
   services; we found nothing else in them.

9. **Learned skills are instructions the bot wrote for itself.** With
   **Learn skills on their own** on, a bot can save or change a skill
   without asking; each change shows in its chat with **Undo** in the full chat.
   A skill can be wrong like any other instruction. Switch it off under
   **Skills** in the bot's settings (the gear in its chat), or delete it in the full chat.

10. **An export holds what your bots remember.** The files are readable only by
    you, but anything you copy or share from the folder carries that memory with it.

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

Bot Team for Orca is licensed under [Apache-2.0](LICENSE), the same license as
OpenMausBot, which is by milind-soni and contributors. The panel adapts its colours and layout values; see
[NOTICE](NOTICE).

The earlier Grok Bot client is kept at the tag `grok-bot-final`.

### Remove surviving agent links

**Agent MCP links survive plugin uninstall.** The entry is named `orca-bot`
in **Claude, Codex, opencode and Antigravity**. Before uninstalling, open the
plugin's Settings and turn off **My Orca agents can talk to the bots** (or
**Let my Orca agents talk to the bots** in Orca's plugin settings). Keep the
local server running until the setting applies; resolve any removal error
before uninstalling.

If the plugin is already uninstalled, remove only the `orca-bot` entry:

- **Claude:** run `claude mcp remove --scope user orca-bot` with the same
  Claude profile used by Orca. For manual editing, remove `mcpServers.orca-bot`
  from that profile's `.claude.json` (normally `~/.claude.json`; if
  `CLAUDE_CONFIG_DIR` is set, use `.claude.json` in that directory).
- **Codex:** run `codex mcp remove orca-bot` with Orca's selected Codex home,
  or remove `[mcp_servers.orca-bot]` and its child tables from
  `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`).
- **opencode:** remove `mcp["orca-bot"]` from
  `~/.config/opencode/opencode.json`, preserving the other MCP entries.
- **Antigravity:** run `agy mcp remove orca-bot`, or remove
  `mcpServers["orca-bot"]` from `~/.gemini/config/mcp_config.json`.

Restart the affected agents after editing their configuration. Deleting
`~/.orca-bot` alone does not remove these links.
