#!/usr/bin/env node
// Builds data/embeddings.bin for plain-English search: one vector per repo, in the same order as data/repos.json.
// The browser runs the same model on the visitor's query, so nothing needs a server or a paid API.
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";

// Keep in sync with semantic.js.
const MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH = 32;

const data = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const { repos, generatedAt } = JSON.parse(await readFile(join(data, "repos.json"), "utf8"));
const embed = await pipeline("feature-extraction", MODEL, { dtype: "q8" });

const text = (r) => `${r.n.split("/")[1].replace(/[-_.]/g, " ")}. ${r.d} ${r.t.join(" ").replace(/-/g, " ")}`;

let dim = 0;
let out;
for (let i = 0; i < repos.length; i += BATCH) {
  const batch = repos.slice(i, i + BATCH).map(text);
  const result = await embed(batch, { pooling: "mean", normalize: true });
  dim = result.dims[1];
  out ??= new Int8Array(repos.length * dim);
  // One signed byte per value keeps the file small, and search quality barely changes.
  result.data.forEach((v, j) => { out[i * dim + j] = Math.round(v * 127); });
  if (i % (BATCH * 20) === 0) console.log(`${i}/${repos.length}`);
}

await writeFile(join(data, "embeddings.bin.tmp"), out);
await rename(join(data, "embeddings.bin.tmp"), join(data, "embeddings.bin"));
await writeFile(join(data, "embeddings.json"), JSON.stringify({ dim, count: repos.length, generatedAt }));
console.log(`Wrote ${repos.length} vectors (${dim} dimensions, ${(out.length / 1e6).toFixed(1)} MB)`);
