import rawData from "@/data/data.json";

// Mirrors stage8/build_stage8_data.py's data.json shape exactly (field names
// kept short there to save bytes: k=thread_key, src=source, cl=cluster id,
// q=evidence_quote, post=full original post text, rq=representative quote,
// cue/fm/out/trig/sev = the Stage 4 episode fields, scope = in/out/baseline).
export type Episode = {
  k: string;
  src: string;
  date: string;
  cl: string;
  code: string;
  cue: string;
  fm: string;
  out: string;
  trig: string;
  sev: "low" | "medium" | "high";
  q: string;
  post: string;
  rq: string;
  scope: "in" | "out" | "baseline";
};

export type Cluster = {
  id: string;
  label: string;
  n: number;
  rank: number | null;
  composite: number | null;
  freq: number | null;
  severity_score: number | null;
  clean: number | null;
  top_pair: string | null;
};

export type AtlasData = {
  clusters: Cluster[];
  episodes: Episode[];
  total: number;
  out_scope_groups: { reason: string; label: string; n: number }[];
};

const data = rawData as AtlasData;

export function getAllEpisodes(): Episode[] {
  return data.episodes;
}

export function getClusters(): Cluster[] {
  return data.clusters;
}

export function getClusterById(id: string): Cluster | undefined {
  return data.clusters.find((c) => c.id === id);
}

export function getStats() {
  return {
    total: data.total,
    inScope: data.episodes.filter((e) => e.scope === "in").length,
    outScope: data.episodes.filter((e) => e.scope === "out").length,
    baseline: data.episodes.filter((e) => e.scope === "baseline").length,
  };
}
