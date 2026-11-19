# Changelog

## 0.1.11 (19 November 2026)

- **Skills and memory in the chat**: a **Skills** pill in each bot's chat opens
  a panel from the right with the bot's skills, a switch for each, and a
  **Learned** tag on those the bot wrote itself, plus its memory (`MEMORY.md`)
  and how much of it loads each turn. Each skill is tagged with where it
  comes from: learned by the bot, Claude Code, Codex, the agents folder, a
  project, a team package or added.
- **Settings → Learning**: **Bots learn skills on their own** turns on
  OpenMausBot's automatic skill review. After a task with many tool steps, a bot
  looks back over it and may save or improve a skill.
- **Export bots** (Settings → Export): each bot's persona, memory and own
  skills as plain files in Downloads, laid out like Hermes Agent profiles, so
  the team can move to another agent without OpenMausBot.
- **MCP Connectors is now Connectors**, and each provider's list folds; long
  lists start folded.
- **Settled cards read as one line**: a card that asks nothing, such as
  "Skill … enabled", no longer says "This needs the full chat."
- **OpenMausBot 0.1.171**: faster replies (Codex turns stay warm, Claude starts
  ahead of your message), bots can set themselves reminders, longer hand-offs
  between bots, and scheduled runs retry when a cloud desktop does not wake.

## 0.1.10 (19 November 2026)

- **Set up private desktops in the panel**: choosing **Private desktop** in a
  bot's Backend panel shows OpenMausBot's setup steps with checkmarks and the
  one action for the current state (Prepare desktop, Create, Start it now,
  Stop, or Delete and recreate). Steps use OpenMausBot's own routes, so it
  still refuses while a bot is using the desktop, and recreating keeps the
  desktop's folder and browser sign-ins.
- **Settings → Private desktops**: the same setup for the bot host, plus
  **Isolation** (Shared or Per bot), the per-bot maximum and the idle stop time.
- **Turn on the browser**: install OpenMausBot's built-in browser from the
  Backend panel when a bot is set to **Browser**.

## 0.1.9 (18 November 2026)

- **Wide two-pane layout**: at 720px or wider the panel keeps the bot list on the
  left and the open chat on the right, as OpenMausBot does. The bot list no
  longer runs past a narrow panel's edge.
- **Backend panel**: the computer icon in a chat, or **Backend** in a bot's
  context menu, opens a panel from the right showing where the bot is working
  and a **Works on** grid (Auto, Cloud desktop, Private desktop, This computer,
  Browser, Off) with the state OpenMausBot reports for each.
- **Files and photos in chat**: attach with **+**, paste or drop when bots run on
  this computer; messages show attachment names.
- **Drag bots between groups**, including onto **Pinned**.
- **Model picker by provider**: the chat's model chip and the **Model** menu open
  on the current provider's models, with the other providers one step away; bot
  rows show the provider next to the model.
- **Claude plugin connectors**: MCP servers from enabled Claude Code plugins
  appear under **Claude plugins** in **Settings → MCP Connectors**.
- **Open native OpenMausBot** moved from the header and chat into each bot's
  context menu, and is hidden for bots on a paired server.

## 0.1.8 (18 November 2026)

- **Add bot button & creation flow**: adds an accessible **Add bot** (`+`)
  action in the panel header alongside empty-state and group context menu entry
  points, opening a compact **New bot** popover (optional bot name, paired-host
  terminal relay support, least-privilege MCP defaults, and immediate chat open
  upon creation).
- **Auto-closing bottom-left toast notifications**: replaces lingering inline
  action status text with a floating bottom-left toast notification featuring an
  immediate `×` dismiss button and a 3-second auto-close timer.

## 0.1.7 (18 November 2026)

- **Clean MCP connector toggles & auto-purge on disable**: turning off (or using
  **All off** on) a locally backed MCP connector imported by this plugin now
  disables it, removes bot assignments, and deletes its copied credentials from
  OpenMausBot automatically, eliminating noisy inline **Remove** buttons on
  local provider rows while preserving **Remove** confirmation for servers
  created directly in OpenMausBot or orphaned from local configs.
- **Offline connector icons & UI polish**: adds rounded-square vector icons for
  popular services and MCP tool categories across **Settings → MCP Connectors**
  (**Providers** and **By Bot**) and the **Connectors** capability popover,
  replaces the text **Refresh** button with an accessible circular refresh icon,
  and removes the redundant **Cancel** item from capability popovers.

## 0.1.6 (18 November 2026)

- **In-panel bot model switching**: switch a bot's AI model directly from the
  chat view header's **Model** pill or the sidebar right-click **Model** menu,
  grouped by ready AI provider from OpenMausBot (`GET /api/instances`) and
  updating both the bot default and its active conversation on local and paired
  Orca servers.
- **Bot-centric MCP Connectors & least-privilege scoping**: replaces the
  one-click bulk tool import with **Settings → MCP Connectors** (**Providers**
  catalog for enabling, disabling, or removing connectors by AI app, plus a **By
  Bot** access view) and an in-chat **Connectors** pill + sidebar context menu
  checklist for scoping enabled MCP connectors per bot. Newly enabled connectors
  default to zero bots allowed, with non-destructive background reconciliation
  and paired-host relay parity.
- **Sidebar group rename & context menu polish**: right-click or press
  `Shift+F10` on a sidebar group heading to rename the group, remove trailing
  ellipses from bot context menu items, and show an inline spinner while a bot
  is being deleted or hidden.

## 0.1.5 (17 November 2026)

- **Panel polish**: shows the OpenMausBot installation notice once inside its
  card instead of repeating it in the header, and uses a gear icon for Settings.
- **Bot right-click actions**: right-click (or press `Shift+F10` / the context
  menu key) on a bot row to **Pin** or **Unpin**, **Rename**, move to or create
  a **Group**, **Delete** a bot, or **Hide from list** for the default MausBot.
  Grouped rosters render **Pinned** and named section headings while keeping
  arrow-key navigation and focus restoration in the menu.
- **Remote Bot Dashboard**: when bots run on a paired Orca server, **Jump to
  Bot Dashboard** and bot dashboard links open and auto-pair in the client
  desktop's Orca browser, reuse the client tab across relay reconnects, and no
  longer show a bottom fallback notice. Cross-device live verification remains
  pending.
- **Synced remote permissions and server controls**: **Permissions** (Claude and
  Codex tool sharing, Orca agent links, and AI app tool imports) and
  **OpenMausBot** (**Install OpenMausBot** approval and **Stop OpenMausBot**)
  sync two-way with a paired server, naming the server that supplies tools and
  agents. Installation still requires explicit user approval.
- **Atomic shared state and cross-worker locking**: host preferences self-heal
  from corrupt JSON, save atomically, and write only changed keys; server
  install, upgrade, start and stop serialize across local and relay workers with
  isolated staging folders and 15-minute / boot-time stale-lock recovery.

## 0.1.4 (17 November 2026)

- **OpenMausBot 0.1.169**: updates the tested OpenMausBot version from 0.1.158
  to 0.1.169, and switches an existing plugin-started server to the new version
  once bots are idle and installation has been approved. The replacement is
  verified before stopping the old server, and idle state is checked again.
- **Explicit installation approval**: an **Install OpenMausBot** button explains
  the npm package, approximate 75 MB download and `~/.orca-bot` destination.
  Opening the panel, polling status, importing tools or connecting a paired
  client cannot approve a download. Existing installations remain usable.
- **Verified downloads**: a committed lockfile pins SHA-512 integrity for
  OpenMausBot and its dependencies (27 resolved packages). Installation uses
  `npm ci --ignore-scripts`; integrity mismatches abort and clean staging files.
- **Agent links**: settings name Claude, Codex, opencode and Antigravity. The
  README explains that `orca-bot` links survive uninstall and gives removal
  steps for all four. Missing pinned binaries cannot replace working links.
- **Settings** in the panel: where the bots run, the setup card's permissions
  (now changeable at any time), updates, and stopping OpenMausBot. Switching
  hosts refreshes permissions and shows errors in Settings; initial permission
  choices match the saved values and default to off.
- **Updates**: a banner asks when a new version is out, or turn on **Install
  updates automatically**. Checks GitHub at most every six hours while the
  panel is open; temporary network failures retry after one minute. Failed
  installs do not block future checks, and approval-required updates wait
  for approval in Orca. The main banner keeps success and error feedback visible.
- **Bots run on**: pick this computer or a paired Orca server in the panel.
  The server needs Orca, Node.js 24 or newer and one project in Orca; it does
  not need this plugin, but OpenMausBot must already be installed there.
  Chat and the bot list work from the client; setup,
  tool imports, the Bot Dashboard and stopping OpenMausBot stay on the server.
  Not yet tested between two computers.

## 0.1.3 (16 November 2026)

- Plugin icon, and author and repository links on the plugin page.
- Removed the deprecated `publisher` field; Orca takes it from the repository
  owner.
- Source reformatted to short, readable lines, and generated listing pages are
  no longer shipped. Orca's directory holds releases whose code looks packed.
  No behaviour change.

## 0.1.2 (15 November 2026)

- Renamed to **Bot Team for Orca**. Nothing else changed.

## 0.1.1 (15 November 2026)

- Renamed from Orca Bot to **Bot for Orca**. Orca's community catalog reserves
  names that start with "Orca" for official plugins, so 0.1.0 was not listed.
  Nothing else changed.

## 0.1.0 (15 November 2026)

First release, under the name Orca Bot. macOS only for now.

- Bot list and chat window in Orca's sidebar, in OpenMausBot's light and dark
  look.
- Installs and starts a tested OpenMausBot version (0.1.158) by itself, in its
  own workspace.
- **Jump to Bot Dashboard** opens the full OpenMausBot page in an Orca browser
  tab, signed in, and signs it in again by itself if the session ends.
- A setup card asks once before anything is shared: bots using your Claude
  tools, your Orca agents (Claude, Codex, opencode, Antigravity) talking to the
  bots, and bringing in tools from your other AI apps.
- Claude bots use the Claude login you have in Orca.
- OpenMausBot's usage analytics are switched off for a server the plugin starts.
- Licensed under Apache-2.0.
