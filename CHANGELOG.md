# Changelog

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
