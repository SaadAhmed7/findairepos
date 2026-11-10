#!/usr/bin/env node
// Writes a plain HTML page for each starter pack to packs/<id>/index.html,
// so search engines and visitors with slow connections get real content without the app.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { packs, repos } = JSON.parse(await readFile(join(ROOT, "data", "repos.json"), "utf8"));
const byName = new Map(repos.map((r) => [r.n, r]));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));

const page = (pack) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(pack.title)}: the best GitHub repos · FindAIRepos</title>
  <meta name="description" content="${esc(pack.blurb)}">
  <meta name="color-scheme" content="light dark">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../../styles.css">
</head>
<body class="static-page">
  <header class="masthead"><a class="wordmark" href="../../">find<b>AI</b>repos</a></header>
  <main class="static-main">
    <h1>${esc(pack.title)}</h1>
    <p class="static-blurb">${esc(pack.blurb)}</p>
    <ol class="list">
${pack.repos.map((x) => {
  const r = byName.get(x.n);
  return `      <li class="static-repo">
        <h2><a href="https://github.com/${esc(x.n)}">${esc(x.n)}</a> <span class="stars">${stars(r.s)}</span></h2>
        <p class="why">${esc(x.why)}</p>
        ${r.d ? `<p class="muted">${esc(r.d)}</p>` : ""}
        <div class="cmd"><code>git clone https://github.com/${esc(x.n)}.git</code></div>
      </li>`;
}).join("\n")}
    </ol>
    <p><a class="btn primary" href="../../?pack=${esc(pack.id)}">Open this pack in FindAIRepos</a></p>
  </main>
</body>
</html>
`;

await rm(join(ROOT, "packs"), { recursive: true, force: true });
for (const pack of packs) {
  const dir = join(ROOT, "packs", pack.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), page(pack));
}
console.log(`Wrote ${packs.length} pack pages`);
