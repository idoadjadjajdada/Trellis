import type { Config } from './config.js';

export interface Embedder {
  /** Identifies the vector space. Atoms embedded by a different model are re-embedded. */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
  /** Starts loading the model in the background so the first save is not slow. */
  warmUp?(): Promise<void>;
}

export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  return len === 0 ? v : v.map((x) => x / len);
}

/** pgvector text format. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}

/**
 * Runs a sentence-embedding model in-process with transformers.js, so the hosted
 * and local versions produce identical vectors with no API key.
 */
class LocalEmbedder implements Embedder {
  readonly model: string;
  private extractor: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(model: string, private cacheDir?: string, private localModelPath?: string) {
    this.model = model;
  }

  private load() {
    if (!this.extractor) {
      this.extractor = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        if (this.cacheDir) env.cacheDir = this.cacheDir;
        if (this.localModelPath) {
          env.localModelPath = this.localModelPath.endsWith('/') ? this.localModelPath : `${this.localModelPath}/`;
          env.allowRemoteModels = false;
        }
        const extractor = await pipeline('feature-extraction', this.model, { dtype: 'fp32' });
        return extractor as unknown as (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;
      })();
      // Let a failed load (e.g. no network) be retried on the next call.
      this.extractor.catch(() => {
        this.extractor = null;
      });
    }
    return this.extractor;
  }

  async warmUp() {
    await this.load();
  }

  embed(texts: string[]): Promise<number[][]> {
    // BGE models are trained with CLS pooling; MiniLM / mpnet / nomic use mean pooling.
    const pooling = /bge/i.test(this.model) ? 'cls' : 'mean';
    // Run one batch at a time: the ONNX session is already multi-threaded.
    const run = this.queue.then(async () => {
      const extractor = await this.load();
      const out = await extractor(texts, { pooling, normalize: true });
      return out.tolist().map(normalize);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

class OpenAIEmbedder implements Embedder {
  constructor(readonly model: string, private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return body.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
  }
}

/**
 * Deterministic bag-of-words hashing. Only for tests and offline development:
 * texts sharing words get similar vectors, but it does not understand meaning.
 */
export class FakeEmbedder implements Embedder {
  readonly model = 'fake-64';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(64).fill(0);
      const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const w of words) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        v[(h >>> 0) % 64] += 1;
      }
      if (words.length === 0) v[0] = 1;
      return normalize(v);
    });
  }
}

export function createEmbedder(config: Config): Embedder {
  switch (config.embeddingProvider) {
    case 'local':
      return new LocalEmbedder(config.embeddingModel, config.modelCacheDir, config.localModelPath);
    case 'openai':
      return new OpenAIEmbedder(config.embeddingModel, config.openaiApiKey!);
    case 'fake':
      return new FakeEmbedder();
  }
}
