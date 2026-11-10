# FindAIRepos

A fast, searchable directory of top GitHub repositories, sorted into categories such as LLMs, AI agents, AI skills and MCP servers.

It's a static site with no build step and no server. Everything runs in the browser, and the data is rebuilt ahead of time by the scripts in `scripts/`.

## Features

- **Instant search and categories:** results appear as you type. "Search all of GitHub" covers anything outside the index.
- **Starter packs:** hand-picked repos for a goal, edited in `data/packs.json`. Each pack also gets a plain HTML page at `packs/<id>/` for search engines.
- **Quick start panel:** install commands and the README for any repo, loaded directly from GitHub.
- **Status and license filters:** Active (updated within 3 months), Slowing (within a year) or Inactive (over a year), plus a permissive license filter.
- **Trending and New:** Trending shows stars gained, from the daily snapshots in `data/history.json`. Until a second day of data exists, it shows stars per day for repos under a year old.
- **Saved lists and Compare:** saved repos stay in the visitor's browser and can be shared by link. Compare shows up to 4 repos side by side.
- **Describe it:** plain-English search. A small model (about 23 MB, downloaded once) runs in the visitor's browser, so there's no API bill.
- **Community picks:** visitors suggest repos through GitHub issues and vote with thumbs-up reactions. See below for setup.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening `index.html` directly won't work, because the page has to fetch its data.

## Refresh the data

```bash
npm ci
GITHUB_TOKEN=$(gh auth token) npm run refresh
```

This takes roughly 10 minutes. It runs three steps: `fetch` (repo data), `embeddings` (vectors for Describe it) and `pages` (starter pack pages). Run all three together, because Describe it switches off if the vectors don't match the repo list.

Categories and their search queries are in `scripts/fetch-repos.mjs`. If a starter pack repo moves or is deleted, the fetch stops with an error naming it, and the existing data stays in place.

## Deploy

Upload the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages, Vercel). `node_modules`, `scripts` and `package*.json` aren't needed at runtime.

If the site is in a GitHub repo, `.github/workflows/refresh-data.yml` refreshes the data daily.

## Turn on Community picks

1. Set `siteRepo` in `site.config.js` to the site's repo, for example `your-name/findairepos`. This shows the Suggest and Community picks links.
2. In that repo, create a label named `approved`.
3. Review suggestions as they arrive in Issues. Add `approved` to accept one and close the issue to remove it. Only people with triage access can add that label, so nothing appears without your approval.

Votes are the thumbs-up count on each issue. They update with the daily refresh, not instantly, and voting needs a GitHub account.

To run the fetch locally with Community picks, also set `SITE_REPO=your-name/findairepos`.
