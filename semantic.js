// Plain-English search. Runs a small model in the visitor's browser and compares the query
// with vectors built ahead of time by scripts/build-embeddings.mjs. Loaded only when first used.
const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
const MODEL = "Xenova/all-MiniLM-L6-v2"; // keep in sync with scripts/build-embeddings.mjs
const MAX_RESULTS = 60;
const MIN_SCORE = 0.25;

let ready = null;

function load(generatedAt, onProgress) {
  ready ??= (async () => {
    const [{ pipeline }, meta, bin] = await Promise.all([
      import(LIBRARY),
      fetch("data/embeddings.json").then((r) => r.json()),
      fetch("data/embeddings.bin").then((r) => r.arrayBuffer()),
    ]);
    if (meta.generatedAt !== generatedAt) throw new Error("Search vectors don't match the repo list");
    const embed = await pipeline("feature-extraction", MODEL, {
      dtype: "q8",
      progress_callback: (e) => {
        if (e.status === "progress" && /\.onnx$/.test(e.file || "")) onProgress(Math.round(e.progress));
      },
    });
    return { embed, vectors: new Int8Array(bin), dim: meta.dim, count: meta.count };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// Returns [[repoIndex, score], ...], best first. Popular repos get a small boost to break near-ties.
export async function rank(query, repos, generatedAt, onProgress) {
  const { embed, vectors, dim, count } = await load(generatedAt, onProgress);
  const q = (await embed(query, { pooling: "mean", normalize: true })).data;
  const scored = [];
  for (let i = 0; i < count; i++) {
    let dot = 0;
    for (let j = 0; j < dim; j++) dot += q[j] * vectors[i * dim + j];
    const score = dot / 127;
    if (score >= MIN_SCORE) scored.push([i, score + Math.log10(repos[i].s + 1) * 0.008]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, MAX_RESULTS);
}
