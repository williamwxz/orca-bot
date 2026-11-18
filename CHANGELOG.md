# Changelog

## Unreleased

- **OpenMausBot 0.1.169**: updates the tested OpenMausBot version from 0.1.158
  to 0.1.169, and switches an existing plugin-started server to the new version
  once bots are idle.
- **Bots run on**: pick this computer or a paired Orca server in the panel.
  The server needs Orca, Node.js 24 or newer and one project in Orca; it does
  not need this plugin. Chat and the bot list work from the client; setup,
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
