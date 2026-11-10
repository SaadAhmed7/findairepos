// Fetches and renders a repo's README for the quick start panel. README content is untrusted,
// so everything rendered goes through DOMPurify. Loaded only when a panel is first opened.
import { marked } from "./vendor/marked.js";
import DOMPurify from "./vendor/purify.js";

const NAMES = ["README.md", "readme.md", "Readme.md", "README.MD", "README.markdown", "README.rst", "README"];
const MAX_CHARS = 150000;
const MAX_COMMANDS = 6;

const INSTALL = new RegExp("^(" + [
  "pip3? install", "pipx (install|run)", "uv (pip install|tool install|add)", "uvx ", "conda install",
  "npm (install|i|create)\\b", "npx ", "pnpm (add|dlx|install)", "yarn (add|global add|dlx)", "bun (add|install|x)", "bunx ",
  "brew install", "cargo install", "go install", "gem install", "composer (require|create-project)",
  "docker (run|pull|compose up)", "docker-compose up", "winget install", "scoop install", "ollama (run|pull)",
  "(curl|wget) .*\\|\\s*(sudo )?(ba|z)?sh", "irm .*\\|\\s*iex",
].join("|") + ")", "i");

async function fetchReadme(repo) {
  for (const name of NAMES) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`);
    if (res.ok) return { text: (await res.text()).slice(0, MAX_CHARS), name };
    if (res.status !== 404) throw new Error(res.status);
  }
  return null;
}

// Pulls install and run commands out of the README's code blocks, in the order they appear.
function findCommands(markdown) {
  const commands = new Set();
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type !== "code") return;
    const joined = token.text.replace(/\\\n\s*/g, " ");
    for (const raw of joined.split("\n")) {
      const line = raw.trim().replace(/^[$>#]\s+/, "");
      if (INSTALL.test(line) && line.length <= 300) commands.add(line);
    }
  });
  return [...commands].slice(0, MAX_COMMANDS);
}

function renderInto(container, markdown, repo, file) {
  container.innerHTML = DOMPurify.sanitize(marked.parse(markdown), {
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "video", "audio", "svg"],
    FORBID_ATTR: ["style", "class", "id", "width", "height"],
  });
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const isRelative = (url) => url && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
  for (const img of container.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (isRelative(src)) img.src = `https://raw.githubusercontent.com/${repo}/HEAD/${dir}${src.replace(/^\.?\//, "")}`;
    img.loading = "lazy";
    img.addEventListener("error", () => img.remove());
  }
  for (const a of container.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (href?.startsWith("#")) a.href = `https://github.com/${repo}${href}`;
    else if (isRelative(href)) a.href = `https://github.com/${repo}/blob/HEAD/${dir}${href.replace(/^\.?\//, "")}`;
    a.target = "_blank";
    a.rel = "noopener nofollow";
  }
}

// Returns the commands found, or null when the repo has no README we can read.
export async function loadReadme(repo, container) {
  const readme = await fetchReadme(repo);
  if (!readme) return null;
  renderInto(container, readme.text, repo, readme.name);
  return findCommands(readme.text);
}
