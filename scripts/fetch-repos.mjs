#!/usr/bin/env node
// Builds data/repos.json from the GitHub search API. No dependencies.
// Usage: GITHUB_TOKEN=$(gh auth token) node scripts/fetch-repos.mjs
// A token is strongly recommended: search allows 30 requests/min with one, 10 without.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addSnapshot, applyGains } from "./trending.mjs";

const t = (...topics) => topics.map((x) => `topic:${x}`);
// Topic searches miss repos with no topics set, so AI categories also search names and descriptions.
const text = (...phrases) => phrases.map((x) => `"${x}" in:name,description`);

// `queries` are GitHub search qualifiers. `minStars` keeps out noise; niche categories use a lower bar.
const CATEGORIES = [
  { id: "llm", group: "AI", name: "LLMs & Models", blurb: "Open models, training code and LLM libraries.",
    queries: [...t("llm", "large-language-models", "llms", "transformers", "open-source-llm"), ...text("large language model", "llm")] },
  { id: "local", group: "AI", name: "Run AI Locally", blurb: "Inference engines and tools for your own hardware.",
    queries: [...t("local-llm", "local-ai", "ollama", "llama-cpp", "llm-inference"), ...text("local llm", "run locally", "local ai")], minStars: 300 },
  { id: "agents", group: "AI", name: "AI Agents", blurb: "Agent frameworks, autonomous and multi-agent systems.",
    queries: [...t("ai-agents", "ai-agent", "agentic-ai", "multi-agent-systems", "autonomous-agents"), ...text("ai agent", "ai agents", "agent framework")] },
  // Many skill repos have no topics at all, so this category leans on text search as well.
  { id: "skills", group: "AI", name: "AI Skills", blurb: "Skills and plugins for Claude Code, Codex, Cursor and other agents.",
    queries: [...t("agent-skills", "agent-skill", "claude-skills", "claude-skill", "claude-code-skill", "skills-sh", "ai-skills", "skills", "skill"),
      ...text("agent skills", "agent skill", "claude skills", "claude skill", "ai skills"),
      "skill claude in:name,description", "skills claude in:name,description", "skill codex in:name,description", "skills codex in:name,description",
      "skill cursor in:name,description", "skills cursor in:name,description", "SKILL.md in:readme"],
    minStars: 100, pages: 3, limit: 600 },
  { id: "prompts", group: "AI", name: "Prompts & Rules", blurb: "System prompts, prompt libraries and rule files.",
    queries: [...t("prompt-engineering", "prompts", "cursor-rules", "system-prompts"), ...text("system prompts", "cursor rules", "prompt library")], minStars: 100 },
  { id: "mcp", group: "AI", name: "MCP Servers", blurb: "Model Context Protocol servers, clients and registries.",
    queries: [...t("mcp", "mcp-server", "mcp-servers", "model-context-protocol"), ...text("mcp server", "model context protocol", "mcp")], minStars: 200 },
  { id: "coding", group: "AI", name: "AI Coding Tools", blurb: "Coding agents, assistants and editor plugins.",
    queries: [...t("coding-agent", "ai-coding", "claude-code", "vibe-coding"), ...text("coding agent", "claude code", "ai coding", "codex")], minStars: 200 },
  { id: "rag", group: "AI", name: "RAG & Vector Search", blurb: "Retrieval pipelines, embeddings and vector databases.",
    queries: [...t("rag", "retrieval-augmented-generation", "vector-database", "embeddings"), ...text("rag", "vector database")], minStars: 300 },
  { id: "chat", group: "AI", name: "Chat Apps & UIs", blurb: "Ready-to-run chat interfaces and bots.",
    queries: [...t("chatgpt", "ai-chat", "llm-ui", "chatbot"), ...text("ai chat", "chat interface")] },
  { id: "image", group: "AI", name: "Image & Video", blurb: "Diffusion models, generators and creative tools.",
    queries: [...t("stable-diffusion", "image-generation", "comfyui", "text-to-video", "video-generation"), ...text("image generation", "video generation")] },
  { id: "audio", group: "AI", name: "Voice & Audio", blurb: "Speech-to-text, text-to-speech and voice agents.",
    queries: [...t("text-to-speech", "speech-recognition", "whisper", "voice-ai"), ...text("text to speech", "speech to text", "voice agent")], minStars: 300 },
  { id: "ml", group: "AI", name: "ML Frameworks", blurb: "Training, deep learning and MLOps foundations.",
    queries: t("machine-learning", "deep-learning", "pytorch", "mlops"), minStars: 1000 },
  { id: "vision", group: "AI", name: "Computer Vision", blurb: "Detection, segmentation and image understanding.",
    queries: t("computer-vision", "object-detection", "image-segmentation"), minStars: 500 },
  { id: "learn-ai", group: "AI", name: "Learn AI", blurb: "Courses, roadmaps and curated AI reading lists.",
    queries: ["topic:awesome topic:llm", "topic:awesome topic:machine-learning", "topic:awesome topic:ai",
      "topic:tutorial topic:llm", "topic:tutorial topic:machine-learning", "topic:course topic:machine-learning"], minStars: 200 },

  { id: "web", group: "Everything else", name: "Web Development", blurb: "Frameworks and libraries for the web.",
    queries: t("react", "nextjs", "vue", "web-framework", "frontend"), minStars: 2000 },
  { id: "devtools", group: "Everything else", name: "Developer Tools", blurb: "CLIs, terminals and everyday utilities.",
    queries: t("developer-tools", "cli", "terminal"), minStars: 2000 },
  { id: "selfhosted", group: "Everything else", name: "Self-Hosted", blurb: "Apps you can run on your own server.",
    queries: t("self-hosted", "selfhosted"), minStars: 1000 },
  { id: "database", group: "Everything else", name: "Databases", blurb: "Engines, ORMs and data stores.",
    queries: t("database", "sql", "orm"), minStars: 2000 },
  { id: "devops", group: "Everything else", name: "DevOps & Infra", blurb: "Containers, Kubernetes and deployment.",
    queries: t("devops", "kubernetes", "docker"), minStars: 2000 },
  { id: "security", group: "Everything else", name: "Security", blurb: "Scanners, hardening guides and security tooling.",
    queries: t("security", "cybersecurity", "security-tools"), minStars: 1000 },
  { id: "awesome", group: "Everything else", name: "Awesome Lists", blurb: "Community-curated lists on every topic.",
    queries: t("awesome", "awesome-list"), minStars: 2000 },
  { id: "learn", group: "Everything else", name: "Learn to Code", blurb: "Roadmaps, free books and interview prep.",
    queries: t("roadmap", "interview-preparation", "learn-to-code"), minStars: 1000 },
];

// A repo must mention one of these (at a word start) in its name or description to stay in the category.
// Popular repos often stuff unrelated topics to gain visibility; this keeps them out.
const TERMS = {
  "llm": [
    "llm",
    "language model",
    "gpt",
    "llama",
    "transformer",
    "deepseek",
    "qwen",
    "mistral"
  ],
  "local": [
    "local",
    "offline",
    "ollama",
    "llama",
    "inference",
    "self-host",
    "on-device",
    "private"
  ],
  "agents": [
    "agent"
  ],
  "skills": [
    "skill"
  ],
  "prompts": [
    "prompt",
    "rules",
    "instructions"
  ],
  "mcp": [
    "mcp",
    "model context protocol"
  ],
  "coding": [
    "coding",
    "code",
    "developer",
    "copilot",
    "ide",
    "programming"
  ],
  "rag": [
    "rag",
    "retriev",
    "vector",
    "embedding",
    "knowledge base",
    "semantic search"
  ],
  "chat": [
    "chat",
    "conversation",
    "assistant",
    "bot"
  ],
  "image": [
    "image",
    "video",
    "diffusion",
    "comfy",
    "art",
    "animation",
    "visual",
    "flux"
  ],
  "audio": [
    "speech",
    "voice",
    "audio",
    "tts",
    "stt",
    "whisper",
    "sound",
    "transcri",
    "music"
  ],
  "ml": [
    "machine learning",
    "deep learning",
    "neural",
    "torch",
    "tensor",
    "ml",
    "training",
    "ai"
  ],
  "vision": [
    "vision",
    "detect",
    "segment",
    "image",
    "video",
    "ocr",
    "opencv",
    "tracking",
    "pose"
  ],
  "learn-ai": [
    "course",
    "tutorial",
    "learn",
    "awesome",
    "roadmap",
    "guide",
    "beginner",
    "from scratch",
    "curated",
    "handbook",
    "resources",
    "book"
  ],
  "web": [
    "react",
    "next",
    "vue",
    "web",
    "frontend",
    "front-end",
    "css",
    "javascript",
    "ui",
    "component",
    "framework",
    "html",
    "browser"
  ],
  "devtools": [
    "cli",
    "command line",
    "terminal",
    "shell",
    "developer",
    "tool",
    "editor",
    "git",
    "debug"
  ],
  "selfhosted": [
    "self-host",
    "selfhost",
    "self host",
    "host",
    "your own",
    "alternative",
    "server",
    "privacy"
  ],
  "database": [
    "database",
    "sql",
    "orm",
    "db",
    "postgres",
    "mysql",
    "redis",
    "mongo",
    "storage",
    "store",
    "query",
    "data"
  ],
  "devops": [
    "devops",
    "kubernetes",
    "docker",
    "container",
    "deploy",
    "infrastructure",
    "monitor",
    "cloud",
    "ci/cd",
    "k8s",
    "terraform",
    "observab",
    "server"
  ],
  "security": [
    "security",
    "hack",
    "penetration",
    "pentest",
    "vulnerab",
    "scanner",
    "cyber",
    "exploit",
    "osint",
    "privacy",
    "encrypt",
    "ctf",
    "malware"
  ],
  "awesome": [
    "awesome",
    "curated",
    "list",
    "collection"
  ],
  "learn": [
    "roadmap",
    "interview",
    "learn",
    "tutorial",
    "book",
    "course",
    "beginner",
    "guide",
    "algorithm",
    "curriculum",
    "cheat",
    "education"
  ]
};

const DEFAULT_MIN_STARS = 500;
const PER_CATEGORY = 200;
const NEW_WINDOW_DAYS = 90;
// Topics searched for recently created repos. New projects rarely reach the star bar of the main categories yet.
const NEW_TOPICS = ["llm", "ai-agents", "mcp", "agent-skills", "rag", "generative-ai", "claude-code", "ai"];
const TOKEN = process.env.GITHUB_TOKEN;
// The site's own GitHub repo. Its issues labelled "approved" become Community picks.
const SITE_REPO = process.env.SITE_REPO;
const PAUSE_MS = TOKEN ? 2200 : 6500; // stays inside the search rate limit
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "findairepos-data-fetch", "X-GitHub-Api-Version": "2022-11-28" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://api.github.com/${path}`, { headers });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
      const wait = Number(res.headers.get("retry-after")) * 1000 || (reset > 0 ? reset + 1000 : 10000 * (attempt + 1));
      console.warn(`  ${res.status}, waiting ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 120000));
      continue;
    }
    throw new Error(`GitHub ${res.status} for ${path}: ${await res.text()}`);
  }
  throw new Error(`Gave up on ${path} after 5 attempts`);
}

async function search(q, pages = 1) {
  const items = [];
  for (let page = 1; page <= pages; page++) {
    const result = await api(`search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`);
    items.push(...result.items);
    if (result.items.length < 100) break;
    if (page < pages) await sleep(PAUSE_MS);
  }
  return items;
}

const clean = (s) => (s || "").replace(/:[a-z0-9_+-]+:/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
const webUrl = (s) => (/^https?:\/\//i.test(s || "") ? s : undefined);
const haystack = (r) => `${r.full_name.split("/")[1].replace(/[-_.]/g, " ")} ${r.description || ""}`;
const patternFor = (cat) => new RegExp(`\\b(${TERMS[cat.id].join("|").replace(/\//g, "\\/")})`, "i");

const toEntry = (r) => ({
  n: r.full_name,
  d: clean(r.description),
  s: r.stargazers_count,
  f: r.forks_count,
  i: r.open_issues_count,
  l: r.language || undefined,
  t: (r.topics || []).slice(0, 10),
  p: r.pushed_at,
  cr: r.created_at,
  c: [],
  lic: r.license && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : undefined,
  h: webUrl(r.homepage),
});

const repos = new Map();

for (const cat of CATEGORIES) {
  const found = new Map();
  for (const q of cat.queries) {
    const items = await search(`${q} stars:>=${cat.minStars ?? DEFAULT_MIN_STARS} archived:false`, cat.pages);
    for (const r of items) found.set(r.full_name, r);
    console.log(`${cat.id}: ${q} -> ${items.length}`);
    await sleep(PAUSE_MS);
  }
  const pattern = patternFor(cat);
  const relevant = [...found.values()].filter((r) => pattern.test(haystack(r)));
  const top = relevant.sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, cat.limit ?? PER_CATEGORY);
  if (!top.length) throw new Error(`Category ${cat.id} came back empty; keeping the existing data file`);
  for (const r of top) {
    const entry = repos.get(r.full_name) ?? toEntry(r);
    entry.c.push(cat.id);
    repos.set(r.full_name, entry);
  }
}

// Recently created repos, filed into any category whose topics and terms they match.
const since = new Date(Date.now() - NEW_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
const newQueries = [...NEW_TOPICS.map((x) => `topic:${x} stars:>=200`), "stars:>=3000"];
for (const q of newQueries) {
  const items = await search(`${q} created:>=${since} archived:false`);
  console.log(`new: ${q} -> ${items.length}`);
  for (const r of items) {
    if (repos.has(r.full_name)) continue;
    const entry = toEntry(r);
    const topics = r.topics || [];
    entry.c = CATEGORIES.filter((cat) =>
      cat.queries.some((x) => topics.includes(x.replace("topic:", ""))) && patternFor(cat).test(haystack(r))).map((cat) => cat.id);
    repos.set(r.full_name, entry);
  }
  await sleep(PAUSE_MS);
}

// Every repo a starter pack names has to be present, whatever its star count.
const packs = JSON.parse(await readFile(join(ROOT, "data", "packs.json"), "utf8"));
for (const name of new Set(packs.flatMap((p) => p.repos.map((r) => r.n)))) {
  if (repos.has(name)) continue;
  const r = await api(`repos/${name}`);
  if (!r || r.full_name !== name) throw new Error(`Starter pack repo ${name} was moved or removed; update data/packs.json`);
  repos.set(name, toEntry(r));
}

// Community picks: open issues the maintainer has labelled "approved". Votes are the issue's thumbs-up count.
if (SITE_REPO) {
  const issues = (await api(`repos/${SITE_REPO}/issues?labels=approved&state=open&per_page=100`)) || [];
  for (const issue of issues) {
    const match = /([\w.-]+\/[\w.-]+)/.exec(issue.title.replace(/https?:\/\/github\.com\//i, ""));
    const r = match && (await api(`repos/${match[1].replace(/\.git$/, "")}`));
    if (!r) { console.warn(`Skipping issue #${issue.number}: no repo found in "${issue.title}"`); continue; }
    const entry = repos.get(r.full_name) ?? toEntry(r);
    entry.v = issue.reactions?.["+1"] ?? 0;
    entry.iu = issue.html_url;
    repos.set(r.full_name, entry);
  }
  console.log(`community: ${issues.length} approved`);
}

const list = [...repos.values()].sort((a, b) => b.s - a.s);

// Trending needs snapshots from earlier runs, so a missing history file just means no gains yet.
const historyPath = join(ROOT, "data", "history.json");
const today = new Date().toISOString().slice(0, 10);
const history = addSnapshot(JSON.parse(await readFile(historyPath, "utf8").catch(() => "{}")), today, list);
const trendingDays = applyGains(history, today, list);

const output = {
  generatedAt: new Date().toISOString(),
  trendingDays,
  categories: CATEGORIES.map(({ id, group, name, blurb }) => ({ id, group, name, blurb })),
  packs,
  repos: list,
};

// Write to temp files first so a failed run can never leave a broken data file behind.
const save = async (path, value) => {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
};
await save(join(ROOT, "data", "repos.json"), output);
await save(historyPath, history);
console.log(`Wrote ${list.length} repos in ${CATEGORIES.length} categories to data/repos.json (trending covers ${trendingDays} days)`);
