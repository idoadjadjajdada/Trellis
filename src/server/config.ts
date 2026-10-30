export type EmbeddingProviderName = 'local' | 'openai' | 'fake';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** The public origin users and AI clients reach, e.g. https://trellis.example.com */
  publicUrl: URL;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  openaiApiKey?: string;
  modelCacheDir?: string;
  /** A folder holding pre-downloaded local models; when set, nothing is downloaded. */
  localModelPath?: string;
  isProduction: boolean;
  /** Whether new accounts can be created. */
  allowSignup: boolean;
  /** Express "trust proxy" setting, for running behind a load balancer or tunnel. */
  trustProxy: boolean | number | string;
}

function readTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '' || value === 'false') return 'loopback';
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function readProvider(value: string | undefined): EmbeddingProviderName {
  const v = (value ?? 'local').toLowerCase();
  if (v === 'local' || v === 'openai' || v === 'fake') return v;
  throw new Error(`EMBEDDING_PROVIDER must be local, openai, or fake (got "${value}")`);
}

const DEFAULT_MODELS: Record<EmbeddingProviderName, string> = {
  local: 'Xenova/bge-small-en-v1.5',
  openai: 'text-embedding-3-small',
  fake: 'fake-64',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);

  const databaseUrl = env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trellis';
  // Hosts that announce their own public address: Render, Railway.
  const platformUrl =
    env.RENDER_EXTERNAL_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  const publicUrl = new URL(env.PUBLIC_URL || platformUrl || `http://localhost:${port}`);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_URL must be an origin with no path, e.g. https://trellis.example.com');
  }
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !isLocalHost) {
    // Passkeys and OAuth both require HTTPS everywhere except localhost.
    throw new Error('PUBLIC_URL must use https:// unless it is localhost');
  }

  const embeddingProvider = readProvider(env.EMBEDDING_PROVIDER);
  if (embeddingProvider === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('EMBEDDING_PROVIDER=openai needs OPENAI_API_KEY');
  }

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    publicUrl,
    embeddingProvider,
    embeddingModel: env.EMBEDDING_MODEL || DEFAULT_MODELS[embeddingProvider],
    openaiApiKey: env.OPENAI_API_KEY,
    modelCacheDir: env.MODEL_CACHE_DIR || undefined,
    localModelPath: env.LOCAL_MODEL_PATH || undefined,
    isProduction: env.NODE_ENV === 'production',
    allowSignup: env.ALLOW_SIGNUP !== 'false',
    trustProxy: readTrustProxy(env.TRUST_PROXY),
  };
}
