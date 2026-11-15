// Static, invented listing fixtures. No plugin runtime or account access.
import { readFileSync, writeFileSync } from 'node:fs';
import { avatarSvg } from '../shared/appearance.ts';
const template = readFileSync(new URL('./panel-template.html', import.meta.url), 'utf8');
const write = (name, text) => writeFileSync(new URL(name, import.meta.url), text);
const crown = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12 1.5 5l4 2L8 3l2.5 4 4-2-1.5 7Z"/><path d="M3 14h10"/></svg>';
const avatar = (id, working = false) => `<span class="avatar drawn${working ? ' avatar-working' : ''}">${avatarSvg(id)}</span>`;
const bots = [
  ['Milo', 'Your plan for the week is ready.', true],
  ['Scout', 'Researcher · Three useful sources found.'],
  ['Quill', 'Writer · The first draft is ready.'],
  ['Patch', 'Developer · All checks passed.'],
];
const roster = bots.map(([name, preview, chief], i) => `<div class="bot-row${chief ? ' selected' : ''}"><button class="bot-chat" type="button">${avatar('sample-' + name)}<span class="bot-copy"><span class="bot-heading"><span class="bot-name">${name}</span>${chief ? `<span class="main-badge">${crown}Chief of Staff</span>` : ''}</span><span class="model">${preview}</span></span></button><span class="state">${i === 1 ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}</span></div>`).join('');
function panel(theme) { return template.replace('<html lang="en">', `<html lang="en" class="${theme}">`).replace(/\s*<script[^>]*>[\s\S]*?<\/script>/, ''); }
write('bots.html', panel('light').replace(' disabled>Jump', '>Jump').replace('Starting…', 'Your team, one conversation away.').replace('id="running" aria-label="Chat and bots" hidden', 'id="running" aria-label="Chat and bots"').replace('<div id="roster" aria-label="Bots"></div>', `<div id="roster" aria-label="Bots">${roster}</div>`));
write('setup.html', panel('light').replace(/<header>[\s\S]*?<\/header>/, '').replace('id="setup" aria-labelledby="setup-title" hidden', 'id="setup" aria-labelledby="setup-title"').replace('id="import-tools-label" hidden', 'id="import-tools-label"').replace('>Claude and Codex</span>', '>Claude, Codex, opencode and Antigravity</span>').replace('<small id="import-tools-copy"></small>', '<small id="import-tools-copy">Adds 3 tools from Cursor and Claude Desktop.</small>'));
const chat = `<main><section id="bot-view" aria-label="Bot conversation"><div class="thread-header"><button aria-label="Back to bots">←</button><div class="thread-identity">${avatar('sample-Scout')}<div><strong>Scout</strong><small>Researcher · Claude</small></div></div><button>↗ Open bot</button></div><div class="messages" aria-label="Recent messages"><time class="day-separator" data-label="Today"></time><div class="chat-message text user">Find three ideas for our next guide.</div><div class="chat-message text bot">I’ll compare useful topics and bring back a short list.</div></div><p class="thread-note"></p><div class="working-line">${avatar('sample-Scout', true)}<span>Working · 12s<span class="working-sheen" aria-hidden="true"><span data-text="Working · 12s"></span></span></span></div><form class="composer"><label for="quick-message">Message</label><textarea id="quick-message" rows="3" placeholder="Message Scout"></textarea><button type="button" aria-label="Send" disabled>↑</button></form></section></main>`;
write('chat.html', panel('dark').replace(/<main>[\s\S]*?<\/main>/, chat));
function stage(name, theme, caption, source, scale, height) {
 write(name + '.html', `<!doctype html><html lang="en" class="${theme}"><head><meta charset="utf-8"><title>${caption}</title><link rel="stylesheet" href="stage.css"></head><body class="gallery ${theme}"><h1>${caption}</h1><div class="frame" style="width:${360 * scale}px;height:${height * scale}px"><iframe title="Fictional Orca Bot example" src="${source}.html" style="width:360px;height:${height}px;transform:scale(${scale})"></iframe></div></body></html>`);
}
stage('screenshot-bots', 'light', 'Your team, right in the sidebar.', 'bots', 2, 344);
stage('screenshot-chat', 'dark', 'Keep the conversation moving.', 'chat', 2, 356);
stage('screenshot-setup', 'light', 'Choose what your bots can access.', 'setup', 1.5, 460);
write('cover.html', `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><title>Orca Bot</title><link rel="stylesheet" href="stage.css"></head><body class="cover"><div class="intro"><span class="eyebrow">YOUR TEAM. IN YOUR SIDEBAR.</span><h1>Orca Bot</h1><p>A team of AI bots in Orca's sidebar, running OpenMausBot on your Mac</p><small>Unofficial</small></div><div class="frame"><iframe title="Fictional bot team" src="bots.html"></iframe></div></body></html>`);
