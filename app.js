const $ = (id) => document.getElementById(id);
const PAGE = 50;
const MAX_COMPARE = 4;
const MAX_SHARED = 30;
const NEW_DAYS = 90;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0", "Zlib", "BSL-1.0", "MIT-0"]);
const SITE_REPO = window.SITE_CONFIG?.siteRepo || "";

const state = { q: "", cat: "", pack: "", lang: "", sort: "best", active: false, perm: false, ai: false, list: null, repo: "", comparing: false };

let categories = [];
let packs = [];
let repos = [];
let byName = new Map();
const extras = new Map(); // repos from outside the index: live results, shared lists, saved items
let generatedAt = "";
let trendingDays = 0;
let results = [];
let shown = 0;
let tokens = [];
let notes = new Map(); // repo name -> why it's in the current starter pack
let compareSet = [];
let saved = [];
let panelPushed = false;
let panelRequest = 0;
let liveRequest = 0;
let liveTimer;
let aiTimer;
let aiRequest = 0;
let aiResult = null; // { q, scores: Map(name -> score) }
let aiStatus = "";

/* ---------- helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "m" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 864e5);
const getRepo = (name) => byName.get(name) || extras.get(name);
const cloneCmd = (name) => `git clone https://github.com/${name}.git`;
const suggestUrl = (name) => `https://github.com/${SITE_REPO}/issues/new?template=suggest-repo.yml${name ? `&title=${encodeURIComponent(name)}` : ""}`;

function ago(iso) {
  const days = daysSince(iso);
  if (days < 1) return "today";
  if (days < 30) return days + "d ago";
  if (days < 365) return Math.floor(days / 30) + "mo ago";
  return Math.floor(days / 365) + "y ago";
}

function health(r) {
  const days = daysSince(r.p);
  if (days <= 90) return { key: "active", label: "Active", note: "Updated in the last 3 months" };
  if (days <= 365) return { key: "slowing", label: "Slowing", note: "No updates for over 3 months" };
  return { key: "inactive", label: "Inactive", note: "No updates for over a year" };
}

function highlight(text) {
  if (!tokens.length) return esc(text);
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return String(text).split(new RegExp(`(${pattern})`, "ig"))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
}

function index(r) {
  const [owner, name] = r.n.split("/");
  r._owner = owner;
  r._short = name;
  r._name = r.n.toLowerCase();
  r._shortLower = name.toLowerCase();
  r._topics = r.t.join(" ").toLowerCase();
  r._desc = r.d.toLowerCase();
  r._lang = (r.l || "").toLowerCase();
  r._time = Date.parse(r.p);
  return r;
}

function fromApi(r) {
  return index({
    n: r.full_name, d: (r.description || "").slice(0, 240), s: r.stargazers_count, f: r.forks_count, i: r.open_issues_count,
    l: r.language || undefined, t: (r.topics || []).slice(0, 10), p: r.pushed_at, cr: r.created_at, c: [],
    lic: r.license && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : undefined, h: safeUrl(r.homepage) || undefined,
  });
}

async function fetchRepo(name) {
  if (getRepo(name)) return getRepo(name);
  const res = await fetch(`https://api.github.com/repos/${name}`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const repo = fromApi(await res.json());
  extras.set(repo.n, repo);
  return repo;
}

/* ---------- saved lists ---------- */
function loadSaved() {
  try {
    const data = JSON.parse(localStorage.getItem("saved") || "{}");
    saved = (data.names || []).filter((n) => REPO_NAME.test(n));
    for (const r of data.extras || []) if (REPO_NAME.test(r.n)) extras.set(r.n, index(r));
  } catch { saved = []; }
}

function storeSaved() {
  const keep = saved.filter((n) => !byName.has(n) && extras.has(n)).map((n) => {
    const { n: name, d, s, f, i, l, t, p, cr, c, lic, h } = extras.get(n);
    return { n: name, d, s, f, i, l, t, p, cr, c, lic, h };
  });
  try { localStorage.setItem("saved", JSON.stringify({ names: saved, extras: keep })); } catch {}
}

function toggleSaved(name) {
  saved = saved.includes(name) ? saved.filter((n) => n !== name) : [name, ...saved];
  storeSaved();
  refreshStates();
  if (state.cat === "saved") update();
  else updateVirtualCounts();
}

/* ---------- compare ---------- */
function toggleCompare(name) {
  if (compareSet.includes(name)) compareSet = compareSet.filter((n) => n !== name);
  else if (compareSet.length < MAX_COMPARE) compareSet = [...compareSet, name];
  refreshStates();
  renderTray();
  if (state.comparing) {
    if (compareSet.length) renderCompare();
    else $("compare").close();
  }
}

function renderTray() {
  const tray = $("tray");
  tray.hidden = !compareSet.length;
  document.body.classList.toggle("has-tray", compareSet.length > 0);
  if (!compareSet.length) { tray.innerHTML = ""; return; }
  tray.innerHTML = `<div class="tray-names">${compareSet.map((n) =>
    `<button type="button" class="chip" data-compare="${esc(n)}" aria-label="Remove ${esc(n)} from compare">${esc(n.split("/")[1])} <span aria-hidden="true">×</span></button>`).join("")}</div>
    <button type="button" class="btn primary" data-open-compare ${compareSet.length < 2 ? "disabled" : ""}>${compareSet.length < 2 ? "Pick one more" : `Compare ${compareSet.length}`}</button>
    <button type="button" class="btn" data-clear-compare>Clear</button>`;
}

function renderCompare() {
  const list = compareSet.map(getRepo).filter(Boolean);
  const best = (fn) => Math.max(...list.map(fn));
  const bestStars = best((r) => r.s);
  const freshest = Math.min(...list.map((r) => daysSince(r.p)));
  const gains = list.some((r) => r.g !== undefined);
  const rows = [
    ["What it is", (r) => esc(r.d || "No description")],
    ["Stars", (r) => `<span class="${r.s === bestStars && list.length > 1 ? "best" : ""}">${r.s.toLocaleString()}</span>`],
    ...(gains ? [[`Stars gained (${trendingDays}d)`, (r) => (r.g !== undefined ? `+${r.g.toLocaleString()}` : "–")]] : []),
    ["Forks", (r) => r.f?.toLocaleString() ?? "–"],
    ["Open issues", (r) => r.i?.toLocaleString() ?? "–"],
    ["Status", (r) => { const h = health(r); return `<span class="health ${h.key}" title="${h.note}">${h.label}</span>`; }],
    ["Last update", (r) => `<span class="${daysSince(r.p) === freshest && list.length > 1 ? "best" : ""}">${ago(r.p)}</span>`],
    ["Created", (r) => (r.cr ? new Date(r.cr).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "–")],
    ["License", (r) => esc(r.lic || "None listed")],
    ["Language", (r) => esc(r.l || "–")],
    ["Website", (r) => (safeUrl(r.h) ? `<a href="${esc(r.h)}" target="_blank" rel="noopener nofollow">Open</a>` : "–")],
    ["Get it", (r) => `<button type="button" class="btn small" data-copy="${esc(cloneCmd(r.n))}">Copy clone</button>`],
  ];
  $("compare-body").innerHTML = `<header class="dialog-head"><h2>Compare</h2><button type="button" class="btn" data-close-dialog>Close</button></header>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col"><span class="sr">Detail</span></th>${list.map((r) => `<th scope="col"><a href="https://github.com/${esc(r.n)}" target="_blank" rel="noopener"><span class="owner">${esc(r._owner)}/</span><br>${esc(r._short)}</a>
        <button type="button" class="linkish" data-compare="${esc(r.n)}">Remove</button></th>`).join("")}</tr></thead>
      <tbody>${rows.map(([label, cell]) => `<tr><th scope="row">${label}</th>${list.map((r) => `<td>${cell(r)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
}

function openCompare() {
  if (compareSet.length < 2) return;
  state.comparing = true;
  renderCompare();
  if (!$("compare").open) $("compare").showModal();
  syncUrl();
}

/* ---------- search ---------- */
// 0 means a token is missing, so the repo is not a match.
function score(r) {
  let total = 0;
  for (const t of tokens) {
    let s = 0;
    if (r._shortLower === t) s = 120;
    else if (r._shortLower.startsWith(t)) s = 70;
    else if (r._name.includes(t)) s = 45;
    else if (r._topics.includes(t)) s = 25;
    else if (r._desc.includes(t)) s = 12;
    else if (r._lang === t) s = 10;
    else return 0;
    total += s;
  }
  return total + Math.log10(r.s + 1) * 4;
}

const aiActive = () => state.ai && state.q.trim().length > 0;

function matchScore(r) {
  if (state.lang && r.l !== state.lang) return 0;
  if (state.active && health(r).key === "inactive") return 0;
  if (state.perm && !PERMISSIVE.has(r.lic)) return 0;
  if (aiActive()) return aiResult?.q === state.q.trim() ? aiResult.scores.get(r.n) || 0 : 0;
  return tokens.length ? score(r) : 1;
}

function queueAiSearch() {
  clearTimeout(aiTimer);
  const q = state.q.trim();
  if (!state.ai || !q || aiResult?.q === q) return;
  aiTimer = setTimeout(() => runAiSearch(q), 350);
}

async function runAiSearch(q) {
  const request = ++aiRequest;
  aiStatus = "Searching…";
  setCount();
  try {
    const { rank } = await import("./semantic.js");
    const ranked = await rank(q, repos, generatedAt, (pct) => {
      if (request !== aiRequest) return;
      aiStatus = `Downloading the search model (about 23 MB, first time only): ${pct}%`;
      setCount();
    });
    if (request !== aiRequest) return;
    aiResult = { q, scores: new Map(ranked.map(([i, s]) => [repos[i].n, s])) };
    aiStatus = "";
    update();
  } catch (err) {
    if (request !== aiRequest) return;
    console.error(err);
    aiStatus = "";
    state.ai = false;
    syncModeButton();
    update();
    $("count").textContent = `Describe it couldn't load, so this is keyword search. ${$("count").textContent}`;
  }
}

/* ---------- views ---------- */
function trendingPool() {
  if (trendingDays > 0) {
    for (const r of repos) r._rank = r.g || 0;
    return repos.filter((r) => r.g > 0);
  }
  // Until a few daily snapshots exist, use average stars per day for repos under a year old.
  const pool = repos.filter((r) => r.cr && daysSince(r.cr) <= 365);
  for (const r of pool) r._rank = r.s / Math.max(daysSince(r.cr), 1);
  return pool.sort((a, b) => b._rank - a._rank).slice(0, 200);
}

const newPool = () => repos.filter((r) => r.cr && daysSince(r.cr) <= NEW_DAYS);

function currentPool() {
  if (state.pack) {
    const pack = packs.find((p) => p.id === state.pack);
    return pack.repos.map((x) => getRepo(x.n)).filter(Boolean);
  }
  if (state.list) return state.list.map(getRepo).filter(Boolean);
  switch (state.cat) {
    case "saved": return saved.map(getRepo).filter(Boolean);
    case "trending": return trendingPool();
    case "new": return newPool();
    case "community": return repos.filter((r) => r.v !== undefined);
    case "": return repos;
    default: return repos.filter((r) => r.c.includes(state.cat));
  }
}

function viewInfo() {
  if (state.pack) {
    const pack = packs.find((p) => p.id === state.pack);
    return { title: pack.title, blurb: pack.blurb };
  }
  if (state.list) return { title: "Shared list", blurb: "Someone shared these repos with you." };
  switch (state.cat) {
    case "packs": return { title: "Starter packs", blurb: "Tell us what you want to do. These are hand-picked repos to start with, in the order we'd try them." };
    case "saved": return { title: "Saved", blurb: "Your list stays in this browser. Share it with a link." };
    case "trending": return trendingDays > 0
      ? { title: "Trending", blurb: `Most stars gained in the last ${trendingDays} ${trendingDays === 1 ? "day" : "days"}.` }
      : { title: "Trending", blurb: "Repos under a year old with the most stars per day. Weekly gains appear here once the site has a few days of history." };
    case "new": return { title: "New", blurb: `Created in the last ${NEW_DAYS} days, most stars first.` };
    case "community": return { title: "Community picks", blurb: "Suggested by visitors and ranked by votes. Vote with a thumbs-up on the repo's GitHub issue." };
  }
  const cat = categories.find((c) => c.id === state.cat);
  return cat ? { title: cat.name, blurb: cat.blurb } : { title: "All repositories", blurb: "Top GitHub projects, sorted into categories." };
}

function sortResults(scored) {
  const hasQuery = state.q.trim() && (tokens.length || aiActive());
  const byStars = (a, b) => b[1].s - a[1].s;
  if (state.sort === "recent") return scored.sort((a, b) => b[1]._time - a[1]._time);
  if (state.sort === "stars") return scored.sort(byStars);
  if (hasQuery) return scored.sort((a, b) => b[0] - a[0]);
  if (state.pack || state.list || state.cat === "saved") return scored; // keep the list's own order
  if (state.cat === "trending") return scored.sort((a, b) => b[1]._rank - a[1]._rank);
  if (state.cat === "community") return scored.sort((a, b) => b[1].v - a[1].v);
  return scored.sort(byStars);
}

/* ---------- rendering ---------- */
function rowHtml(r) {
  const topics = r.t.slice(0, 3).map((t) => `<button class="topic" type="button" data-topic="${esc(t)}">${esc(t)}</button>`).join("");
  const home = safeUrl(r.h);
  const h = health(r);
  const why = notes.get(r.n);
  let gain = "";
  if (state.cat === "trending" && !state.q) {
    gain = trendingDays > 0 ? `<span class="gain">+${num(r.g || 0)} in ${trendingDays}d</span>` : `<span class="gain">+${num(Math.round(r._rank || 0))} a day</span>`;
  }
  const votes = r.iu ? `<a class="votes" href="${esc(r.iu)}" target="_blank" rel="noopener">▲ ${r.v} ${r.v === 1 ? "vote" : "votes"}</a>` : "";
  return `<li class="repo" data-n="${esc(r.n)}">
    <img class="avatar" src="https://avatars.githubusercontent.com/${encodeURIComponent(r._owner)}?s=72" alt="" width="36" height="36" loading="lazy">
    <a class="name" href="https://github.com/${esc(r.n)}" data-open="${esc(r.n)}"><span class="owner">${highlight(r._owner)}/</span><b>${highlight(r._short)}</b></a>
    <span class="stars" title="${r.s.toLocaleString()} stars">${num(r.s)}</span>
    ${r.d ? `<p class="desc">${highlight(r.d)}</p>` : ""}
    ${why ? `<p class="why">${esc(why)}</p>` : ""}
    <div class="meta">
      ${gain}${votes}
      <span class="health ${h.key}" title="${h.note}">${h.label}</span>
      ${r.l ? `<span class="lang">${esc(r.l)}</span>` : ""}
      <span>${ago(r.p)}</span>
      ${r.lic ? `<span>${esc(r.lic)}</span>` : ""}
      ${home ? `<a href="${esc(home)}" target="_blank" rel="noopener nofollow">Website</a>` : ""}
      ${topics}
    </div>
    <div class="actions">
      <button class="btn small" type="button" data-open="${esc(r.n)}">Quick start</button>
      <button class="btn small" type="button" data-copy="${esc(cloneCmd(r.n))}">Copy clone</button>
      <a class="btn small" href="https://github.com/${esc(r.n)}" target="_blank" rel="noopener">GitHub</a>
      <span class="spacer"></span>
      ${saveButton(r.n)}
      ${compareButton(r.n)}
    </div>
  </li>`;
}

function saveButton(name) {
  const on = saved.includes(name);
  return `<button class="btn small toggle" type="button" data-save="${esc(name)}" aria-pressed="${on}">${on ? "Saved" : "Save"}</button>`;
}

function compareButton(name) {
  const on = compareSet.includes(name);
  const full = !on && compareSet.length >= MAX_COMPARE;
  return `<button class="btn small toggle" type="button" data-compare="${esc(name)}" aria-pressed="${on}" ${full ? `disabled title="You can compare up to ${MAX_COMPARE}"` : ""}>Compare</button>`;
}

function refreshStates() {
  for (const b of document.querySelectorAll("[data-save]")) {
    const on = saved.includes(b.dataset.save);
    b.setAttribute("aria-pressed", on);
    b.textContent = on ? "Saved" : "Save";
  }
  for (const b of document.querySelectorAll("button.toggle[data-compare]")) {
    const on = compareSet.includes(b.dataset.compare);
    b.setAttribute("aria-pressed", on);
    b.disabled = !on && compareSet.length >= MAX_COMPARE;
  }
}

function buildCats() {
  const groups = [...new Set(categories.map((c) => c.group))];
  const button = (id, label) => `<button class="cat" type="button" data-cat="${esc(id)}">${esc(label)}<span></span></button>`;
  $("cats").innerHTML = button("", "All repositories") +
    `<h2>Discover</h2>` + button("packs", "Starter packs") + button("trending", "Trending") + button("new", "New") + button("saved", "Saved") +
    (SITE_REPO ? button("community", "Community picks") : "") +
    groups.map((g) => `<h2>${esc(g)}</h2>` + categories.filter((c) => c.group === g).map((c) => button(c.id, c.name)).join("")).join("");
}

function buildLangs() {
  const counts = {};
  for (const r of repos) if (r.l) counts[r.l] = (counts[r.l] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([l]) => l).sort();
  $("lang").insertAdjacentHTML("beforeend", top.map((l) => `<option>${esc(l)}</option>`).join(""));
}

function renderPacks() {
  const box = $("packs");
  const isPacksView = state.cat === "packs" && !state.q;
  const isHome = !state.cat && !state.pack && !state.list && !state.q && !state.lang && !state.active && !state.perm;
  box.hidden = !isPacksView && !isHome;
  if (box.hidden) { box.innerHTML = ""; return; }
  const list = isPacksView ? packs : packs.slice(0, 6);
  const tile = (p) => `<a class="pack" href="?pack=${esc(p.id)}" data-pack="${esc(p.id)}"><b>${esc(p.title)}</b>${isPacksView ? `<span>${esc(p.blurb)}</span>` : ""}<small>${p.repos.length} repos</small></a>`;
  box.innerHTML = (isHome ? `<div class="packs-head"><h2>What do you want to do?</h2><a href="?cat=packs" data-cat-link="packs">All ${packs.length} starter packs</a></div>` : "") +
    `<div class="pack-grid ${isPacksView ? "full" : ""}">${list.map(tile).join("")}</div>`;
}

function renderViewActions() {
  const box = $("viewactions");
  let html = "";
  if (state.cat === "saved" && saved.length) html = `<button class="btn small" type="button" data-share>Copy share link</button>`;
  if (state.list) html = `<button class="btn small" type="button" data-save-all>Save all to my list</button>`;
  if (state.cat === "community") html = `<a class="btn small" href="${esc(suggestUrl())}" target="_blank" rel="noopener">Suggest a repo</a>`;
  box.innerHTML = html;
  box.hidden = !html;
}

function updateVirtualCounts() {
  const set = (id, text) => {
    const span = $("cats").querySelector(`[data-cat="${id}"] span`);
    if (span) span.textContent = text;
  };
  set("saved", saved.length || "");
  set("packs", packs.length);
  set("trending", "");
}

function setCount() {
  const q = state.q.trim();
  if (aiActive() && aiStatus) { $("count").textContent = aiStatus; return; }
  const quoted = q ? ` matching “${q}”` : "";
  $("count").textContent = `${results.length.toLocaleString()} ${results.length === 1 ? "repo" : "repos"}${quoted}`;
}

function appendPage() {
  if (shown >= results.length) return;
  $("list").insertAdjacentHTML("beforeend", results.slice(shown, shown + PAGE).map(rowHtml).join(""));
  shown = Math.min(shown + PAGE, results.length);
}

function emptyMessage() {
  if (results.length || aiStatus) return "";
  if (state.q.trim()) return aiActive() && aiResult?.q === state.q.trim() ? "Nothing close to that. Try describing it another way." : "";
  if (state.cat === "saved") return "Nothing saved yet. Press Save on any repo and it will show up here.";
  if (state.cat === "community") return "No community picks yet. Be the first to suggest one.";
  if (state.list) return "Loading the shared list didn't find any repos.";
  return "No repos match these filters.";
}

function update() {
  tokens = state.ai ? [] : state.q.toLowerCase().split(/\s+/).filter(Boolean);

  const counts = { "": 0 };
  let newCount = 0;
  let communityCount = 0;
  for (const r of repos) {
    if (!matchScore(r)) continue;
    counts[""]++;
    for (const c of r.c) counts[c] = (counts[c] || 0) + 1;
    if (r.cr && daysSince(r.cr) <= NEW_DAYS) newCount++;
    if (r.v !== undefined) communityCount++;
  }
  counts.new = newCount;
  counts.community = communityCount;

  const pack = state.pack && packs.find((p) => p.id === state.pack);
  notes = new Map(pack ? pack.repos.map((x) => [x.n, x.why]) : []);

  const isPacks = state.cat === "packs" && !state.q;
  const scored = [];
  if (!isPacks) {
    for (const r of state.cat === "packs" ? repos : currentPool()) {
      const s = matchScore(r);
      if (s) scored.push([s, r]);
    }
  }
  results = sortResults(scored).map((x) => x[1]);

  shown = 0;
  $("list").innerHTML = "";
  appendPage();

  const info = viewInfo();
  $("title").textContent = info.title;
  $("blurb").textContent = info.blurb;
  document.title = state.cat || state.pack ? `${info.title} · FindAIRepos` : "FindAIRepos: Find the Best AI GitHub Repos";
  $("count").hidden = isPacks;
  document.querySelector(".controls").hidden = isPacks;
  setCount();

  const message = emptyMessage();
  $("empty").hidden = !message;
  $("empty").textContent = message;

  for (const b of $("cats").querySelectorAll(".cat")) {
    const id = b.dataset.cat;
    if (!["packs", "saved", "trending"].includes(id)) {
      const n = counts[id] || 0;
      b.querySelector("span").textContent = n.toLocaleString();
      b.classList.toggle("empty", n === 0);
    }
    if (id === state.cat && !state.pack && !state.list) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
  updateVirtualCounts();
  renderPacks();
  renderViewActions();
  renderLive();
  syncUrl();
}

/* ---------- live GitHub search ---------- */
// The index holds the top repos. Anything else is one click away through GitHub's own search.
function renderLive() {
  liveRequest++;
  clearTimeout(liveTimer);
  const q = state.q.trim();
  if (!q || state.ai) { $("live").innerHTML = ""; return; }
  $("live").innerHTML = `<button class="livebtn" type="button" id="livebtn">Search all of GitHub for “${esc(q)}”</button>`;
  if (!results.length && q.length >= 2) liveTimer = setTimeout(searchGitHub, 500);
}

async function searchGitHub() {
  const request = ++liveRequest;
  const q = state.q.trim();
  const box = $("live");
  box.innerHTML = `<h2>Live from GitHub</h2><p>Searching…</p>`;
  try {
    const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`, { headers: { Accept: "application/vnd.github+json" } });
    if (request !== liveRequest) return;
    if (res.status === 403 || res.status === 429) {
      box.innerHTML = `<h2>Live from GitHub</h2><p>GitHub limits anonymous searches to 10 a minute. Wait a moment, or <a href="https://github.com/search?type=repositories&q=${encodeURIComponent(q)}" target="_blank" rel="noopener">search on GitHub directly</a>.</p>`;
      return;
    }
    if (!res.ok) throw new Error(res.status);
    const { items } = await res.json();
    if (request !== liveRequest) return;
    const known = new Set(results.map((r) => r.n));
    const fresh = items.filter((r) => !known.has(r.full_name)).map((r) => {
      const existing = getRepo(r.full_name);
      if (existing) return existing;
      const repo = fromApi(r);
      extras.set(repo.n, repo);
      return repo;
    });
    box.innerHTML = `<h2>Live from GitHub · ${fresh.length} more</h2>` +
      (fresh.length ? `<ol class="list">${fresh.map(rowHtml).join("")}</ol>` : `<p>No other repos match “${esc(q)}”.</p>`);
  } catch {
    if (request === liveRequest) box.innerHTML = `<h2>Live from GitHub</h2><p>Couldn't reach GitHub. Check your connection and try again.</p>`;
  }
}

/* ---------- quick start panel ---------- */
function commandBlock(cmd, label = "Copy") {
  return `<div class="cmd"><code>${esc(cmd)}</code><button type="button" class="btn small" data-copy="${esc(cmd)}" data-copy-label="${esc(label)}">${esc(label)}</button></div>`;
}

async function openPanel(name, { push = true } = {}) {
  const request = ++panelRequest;
  state.repo = name;
  const body = $("panel-body");
  if (!$("panel").open) $("panel").showModal();
  if (push) { syncUrl(true); panelPushed = true; } else syncUrl();
  body.innerHTML = `<p class="muted pad">Loading…</p>`;
  const r = await fetchRepo(name);
  if (request !== panelRequest) return;
  if (!r) {
    body.innerHTML = `<header class="dialog-head"><h2>${esc(name)}</h2><button type="button" class="btn" data-close-dialog>Close</button></header><p class="muted pad">Couldn't load this repo. It may have moved, or GitHub's limit for anonymous requests has been reached. <a href="https://github.com/${esc(name)}" target="_blank" rel="noopener">Open it on GitHub</a>.</p>`;
    return;
  }
  const h = health(r);
  const home = safeUrl(r.h);
  const suggest = SITE_REPO && !byName.has(r.n) ? `<a class="btn" href="${esc(suggestUrl(r.n))}" target="_blank" rel="noopener">Suggest for this site</a>` : "";
  body.innerHTML = `
    <header class="dialog-head">
      <div class="panel-title">
        <img class="avatar" src="https://avatars.githubusercontent.com/${encodeURIComponent(r._owner)}?s=72" alt="" width="36" height="36">
        <h2><span class="owner">${esc(r._owner)}/</span>${esc(r._short)}</h2>
      </div>
      <button type="button" class="btn" data-close-dialog>Close</button>
    </header>
    <div class="pad">
      ${r.d ? `<p class="panel-desc">${esc(r.d)}</p>` : ""}
      <div class="meta panel-meta">
        <span class="stars">${num(r.s)}</span>
        <span class="health ${h.key}" title="${h.note}">${h.label}</span>
        ${r.l ? `<span class="lang">${esc(r.l)}</span>` : ""}
        <span>Updated ${ago(r.p)}</span>
        ${r.lic ? `<span>${esc(r.lic)}</span>` : "<span>No license listed</span>"}
      </div>
      <div class="actions panel-actions">
        <a class="btn primary" href="https://github.com/${esc(r.n)}" target="_blank" rel="noopener">Open on GitHub</a>
        ${home ? `<a class="btn" href="${esc(home)}" target="_blank" rel="noopener nofollow">Website</a>` : ""}
        ${saveButton(r.n).replace("btn small", "btn")}
        ${compareButton(r.n).replace("btn small", "btn")}
        ${suggest}
      </div>
      <h3>Get it</h3>
      ${commandBlock(cloneCmd(r.n))}
      <div id="panel-commands"></div>
      <h3>README</h3>
      <div class="readme" id="panel-readme"><p class="muted">Loading README…</p></div>
    </div>`;
  try {
    const { loadReadme } = await import("./quickstart.js");
    const holder = document.createElement("div");
    const commands = await loadReadme(r.n, holder);
    if (request !== panelRequest) return;
    if (commands === null) {
      $("panel-readme").innerHTML = `<p class="muted">This repo has no README we can show. <a href="https://github.com/${esc(r.n)}" target="_blank" rel="noopener">See it on GitHub</a>.</p>`;
      return;
    }
    $("panel-readme").replaceChildren(holder);
    if (commands.length) {
      $("panel-commands").innerHTML = `<p class="muted note">Found in this repo's README. Read what a command does before you run it.</p>` + commands.map((c) => commandBlock(c)).join("");
    }
  } catch (err) {
    console.error(err);
    if (request === panelRequest) $("panel-readme").innerHTML = `<p class="muted">Couldn't load the README. <a href="https://github.com/${esc(r.n)}#readme" target="_blank" rel="noopener">Read it on GitHub</a>.</p>`;
  }
}

/* ---------- copy ---------- */
// navigator.clipboard is refused on non-HTTPS pages and in some embedded browsers, so fall back to the older API.
function legacyCopy(text, near) {
  const box = document.createElement("textarea");
  box.value = text;
  box.style.cssText = "position:fixed;opacity:0";
  near.append(box); // inside the button's parent, because a modal dialog makes the rest of the page inert
  box.select();
  const ok = document.execCommand("copy");
  box.remove();
  return ok;
}

async function copyText(text, btn) {
  const label = btn.dataset.copyLabel || btn.textContent;
  btn.dataset.copyLabel = label;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text, btn.parentElement);
    btn.focus();
  }
  btn.textContent = ok ? "Copied" : "Copy failed";
  btn.classList.toggle("done", ok);
  setTimeout(() => { btn.textContent = label; btn.classList.remove("done"); }, 1400);
}

/* ---------- state and URL ---------- */
function syncUrl(push = false) {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.ai) p.set("mode", "describe");
  if (state.pack) p.set("pack", state.pack);
  else if (state.cat) p.set("cat", state.cat);
  if (state.list) p.set("list", state.list.join(","));
  if (state.lang) p.set("lang", state.lang);
  if (state.sort !== "best") p.set("sort", state.sort);
  if (state.active) p.set("active", "1");
  if (state.perm) p.set("perm", "1");
  if (state.repo) p.set("repo", state.repo);
  if (state.comparing) p.set("compare", compareSet.join(","));
  // Slashes and commas are safe in a query string, and leaving them makes shared links readable.
  const qs = p.toString().replace(/%2F/g, "/").replace(/%2C/g, ",");
  const url = qs ? `?${qs}` : location.pathname;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

function setView({ cat = "", pack = "", list = null }) {
  state.cat = cat;
  state.pack = pack;
  state.list = list;
  syncUrl(true);
  update();
  scrollTo(0, 0);
  revealActiveCat();
  if (list) loadSharedList();
}

// On phones the categories are a sideways-scrolling row, so keep the selected one visible.
function revealActiveCat() {
  const box = $("cats");
  const active = box.querySelector('[aria-current="true"]');
  if (!active) return;
  box.scrollLeft += active.getBoundingClientRect().left - box.getBoundingClientRect().left - 16;
}

async function loadSharedList() {
  const missing = state.list.filter((n) => !getRepo(n));
  if (!missing.length) return;
  await Promise.all(missing.map(fetchRepo));
  if (state.list) update();
}

function setQuery(q) {
  state.q = q;
  $("q").value = q;
  queueAiSearch();
  update();
}

function syncModeButton() {
  $("mode").setAttribute("aria-pressed", state.ai);
  $("q").placeholder = state.ai ? "Describe what you need…" : "Search: ollama, rag, skills…";
}

function parseNames(value, max) {
  return (value || "").split(",").filter((n) => REPO_NAME.test(n)).slice(0, max);
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.ai = p.get("mode") === "describe";
  const virtual = ["packs", "trending", "new", "saved", ...(SITE_REPO ? ["community"] : [])];
  const cat = p.get("cat") || "";
  state.cat = virtual.includes(cat) || categories.some((c) => c.id === cat) ? cat : "";
  const pack = p.get("pack") || "";
  state.pack = packs.some((x) => x.id === pack) ? pack : "";
  state.list = p.has("list") ? parseNames(p.get("list"), MAX_SHARED) : null;
  state.lang = p.get("lang") || "";
  const sort = p.get("sort");
  state.sort = ["stars", "recent"].includes(sort) ? sort : "best";
  state.active = p.get("active") === "1";
  state.perm = p.get("perm") === "1";
  const repo = p.get("repo") || "";
  state.repo = REPO_NAME.test(repo) ? repo : "";
  if (p.has("compare")) compareSet = parseNames(p.get("compare"), MAX_COMPARE);
  state.comparing = compareSet.length >= 2 && p.has("compare");

  $("q").value = state.q;
  $("lang").value = state.lang;
  if ($("lang").value !== state.lang) state.lang = "";
  $("sort").value = state.sort;
  $("active").checked = state.active;
  $("perm").checked = state.perm;
  syncModeButton();
}

const listKey = () => JSON.stringify([state.q, state.ai, state.cat, state.pack, state.list, state.lang, state.sort, state.active, state.perm]);

async function syncDialogs() {
  if (state.repo) openPanel(state.repo, { push: false });
  else if ($("panel").open) $("panel").close();
  if (state.comparing) {
    await Promise.all(compareSet.map(fetchRepo));
    compareSet = compareSet.filter(getRepo);
    state.comparing = compareSet.length >= 2;
    if (state.comparing) openCompare();
  } else if ($("compare").open) $("compare").close();
  renderTray();
  refreshStates();
}

/* ---------- events ---------- */
function bind() {
  $("q").addEventListener("input", (e) => { state.q = e.target.value; queueAiSearch(); update(); });
  $("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.ai) return;
    if (state.q.trim() && !results.length) searchGitHub();
    else document.querySelector(".repo .name")?.focus();
  });
  $("mode").addEventListener("click", () => {
    state.ai = !state.ai;
    syncModeButton();
    queueAiSearch();
    update();
    $("q").focus();
  });
  const onFilter = (fn) => (e) => { fn(e.target); update(); scrollTo(0, 0); };
  $("lang").addEventListener("change", onFilter((t) => { state.lang = t.value; }));
  $("sort").addEventListener("change", onFilter((t) => { state.sort = t.value; }));
  $("active").addEventListener("change", onFilter((t) => { state.active = t.checked; }));
  $("perm").addEventListener("change", onFilter((t) => { state.perm = t.checked; }));

  document.addEventListener("click", (e) => {
    const t = e.target;
    const plainClick = !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0;

    const cat = t.closest(".cat");
    if (cat) return setView({ cat: cat.dataset.cat });

    const open = t.closest("[data-open]");
    if (open) {
      if (open.tagName === "A" && !plainClick) return; // let cmd-click open GitHub in a new tab
      e.preventDefault();
      return openPanel(open.dataset.open);
    }
    const pack = t.closest("[data-pack]");
    if (pack && plainClick) { e.preventDefault(); return setView({ pack: pack.dataset.pack }); }
    const catLink = t.closest("[data-cat-link]");
    if (catLink && plainClick) { e.preventDefault(); return setView({ cat: catLink.dataset.catLink }); }

    const copy = t.closest("[data-copy]");
    if (copy) return copyText(copy.dataset.copy, copy);
    const save = t.closest("[data-save]");
    if (save) return toggleSaved(save.dataset.save);
    const compare = t.closest("[data-compare]");
    if (compare) return toggleCompare(compare.dataset.compare);
    if (t.closest("[data-open-compare]")) return openCompare();
    if (t.closest("[data-clear-compare]")) { compareSet = []; refreshStates(); return renderTray(); }
    if (t.closest("[data-close-dialog]")) return t.closest("dialog").close();

    const topic = t.closest("[data-topic]");
    if (topic) { setQuery(topic.dataset.topic); scrollTo(0, 0); return; }
    if (t.closest("#livebtn")) return searchGitHub();

    const share = t.closest("[data-share]");
    if (share) {
      const url = new URL(location.pathname, location.href);
      url.searchParams.set("list", saved.slice(0, MAX_SHARED).join(","));
      return copyText(url.href, share);
    }
    const saveAll = t.closest("[data-save-all]");
    if (saveAll) {
      saved = [...new Set([...saved, ...state.list.filter(getRepo)])];
      storeSaved();
      refreshStates();
      updateVirtualCounts();
      saveAll.textContent = "Saved";
    }
  });

  // Clicking the dimmed area outside a dialog closes it.
  for (const dialog of [$("panel"), $("compare")]) {
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  }
  $("panel").addEventListener("close", () => {
    panelRequest++;
    if (!state.repo) return;
    state.repo = "";
    if (panelPushed) { panelPushed = false; history.back(); } else syncUrl();
  });
  $("compare").addEventListener("close", () => {
    state.comparing = false;
    syncUrl();
  });

  addEventListener("popstate", () => {
    panelPushed = false;
    const before = listKey();
    restoreFromUrl();
    queueAiSearch();
    // Closing the panel only changes the repo param, so keep the list and scroll position as they are.
    if (listKey() !== before) update();
    syncDialogs();
  });

  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    const inField = e.target.matches("input, select, textarea");
    if (e.key === "/" && !inField && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      $("q").focus();
      $("q").select();
    } else if (e.key === "Escape") {
      if (state.q) setQuery("");
      $("q").focus();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.tagName !== "SELECT") {
      const links = [...document.querySelectorAll(".repo .name")];
      const at = links.indexOf(document.activeElement);
      if (e.key === "ArrowUp" && at <= 0) {
        if (at === 0) { e.preventDefault(); $("q").focus(); }
        return;
      }
      const next = links[e.key === "ArrowDown" ? at + 1 : at - 1];
      if (next) {
        e.preventDefault();
        next.focus();
        next.closest(".repo").scrollIntoView({ block: "nearest" });
      }
    }
  });

  document.addEventListener("error", (e) => {
    if (e.target.classList?.contains("avatar")) e.target.style.visibility = "hidden";
  }, true);

  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) appendPage();
  }, { rootMargin: "800px" }).observe($("sentinel"));

  $("theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  });
}

async function start() {
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  bind();
  try {
    const res = await fetch("data/repos.json");
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    categories = data.categories;
    packs = data.packs || [];
    trendingDays = data.trendingDays || 0;
    generatedAt = data.generatedAt;
    repos = data.repos.map(index);
    byName = new Map(repos.map((r) => [r.n, r]));
    loadSaved();
    const when = new Date(data.generatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("stat").textContent = `${repos.length.toLocaleString()} repos`;
    $("updated").textContent = `Last updated ${when}.`;
    if (SITE_REPO) $("suggest-foot").innerHTML = `<a href="${esc(suggestUrl())}" target="_blank" rel="noopener">Suggest a repo</a>.`;
    buildCats();
    buildLangs();
    restoreFromUrl();
    if (state.list) loadSharedList();
    queueAiSearch();
    update();
    revealActiveCat();
    syncDialogs();
  } catch (err) {
    console.error(err);
    $("count").textContent = "Couldn't load the repo list. Refresh the page to try again.";
  }
}
start();
