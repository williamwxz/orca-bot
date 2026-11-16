# Listing images

All bots, messages, and tool counts are invented fixtures. These pages do not
load the plugin runtime, access accounts, or capture real application windows.

`styles.css` and `panel-template.html` are verbatim copies of `panel/styles.css`
and `panel/index.html`. `build.mjs` produces static HTML using the real roster
and chat DOM structure and `shared/appearance.ts` avatars. Chat and setup show
their respective panel sections without the outer roster header.

Run with Node supporting native TypeScript imports (Node 22.18+):

```sh
node listing/build.mjs
node listing/render.mjs
```

Rendering uses installed Google Chrome headless with a temporary isolated
profile. Output is written to `images/`. The original panel CSS is unchanged;
`stage.css` only styles the outer presentation canvas. Panels are 360 CSS px
wide at 2× scale, except setup at the coordinator-approved 1.5× so its full
original copy fits in the same 1280×800 gallery dimensions. The cover is
1600×1000. A static PNG captures one frame of the real working-avatar animation.

When the panel changes, refresh the two copied files before rebuilding and
review every image again. The official manifest schema permits screenshot
`path`, `alt`, optional `caption`, and optional `theme`; theme is omitted so
all screenshots remain visible regardless of the catalog viewer's theme.

The pages `build.mjs` writes (`bots.html`, `chat.html`, `setup.html`,
`cover.html`, `screenshot-*.html`) are build output and are not committed.
