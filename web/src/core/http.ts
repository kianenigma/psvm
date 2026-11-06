export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Minimal key-value store for immutable results (compare of two shas never changes). */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class MemoryKV implements KV {
  private map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.map.set(key, value);
  }
}

export class RateLimitError extends Error {
  constructor(
    public readonly resetAt: Date | null,
    public readonly authenticated: boolean,
  ) {
    super(
      `GitHub API rate limit exceeded${resetAt ? `; resets at ${resetAt.toLocaleTimeString()}` : ''}.` +
        (authenticated ? '' : ' Add a GitHub token for a higher limit.'),
    );
    this.name = 'RateLimitError';
  }
}

export const API = 'https://api.github.com';
export const RAW = 'https://raw.githubusercontent.com';
export const SDK_REPO = 'paritytech/polkadot-sdk';
export const RUNTIMES_REPO = 'polkadot-fellows/runtimes';

export interface HttpOptions {
  token?: string;
  /** Base URL of the `psvm index` output, e.g. `data/`. */
  dataBase: string;
  cache?: KV;
}

/** GitHub + static-data client. Counts API calls and exposes the remaining rate limit. */
export class Http {
  apiCalls = 0;
  rateRemaining: number | null = null;
  readonly cache: KV;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly options: HttpOptions,
  ) {
    this.cache = options.cache ?? new MemoryKV();
  }

  /** `GET api.github.com{path}`; `null` on 404/422. */
  async api<T>(path: string): Promise<T | null> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    this.apiCalls++;
    const response = await this.fetchFn(`${API}${path}`, { headers });
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) this.rateRemaining = Number(remaining);
    if (response.status === 429 || (response.status === 403 && remaining === '0')) {
      const reset = response.headers.get('x-ratelimit-reset');
      throw new RateLimitError(reset ? new Date(Number(reset) * 1000) : null, !!this.options.token);
    }
    if (response.status === 404 || response.status === 422) return null;
    if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /** A file of `repo` at `ref` from raw.githubusercontent.com (not rate limited); `null` on 404. */
  async raw(repo: string, ref: string, path: string): Promise<string | null> {
    const response = await this.fetchFn(`${RAW}/${repo}/${ref}/${path}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`raw ${repo}/${ref}/${path}: HTTP ${response.status}`);
    return response.text();
  }

  /** A file of the static index; `null` if absent. */
  async data<T>(file: string): Promise<T | null> {
    const response = await this.fetchFn(`${this.options.dataBase}${file}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`index file ${file}: HTTP ${response.status}`);
    // Dev servers answer unknown paths with index.html.
    if (!(response.headers.get('content-type') ?? 'application/json').includes('json')) return null;
    return (await response.json()) as T;
  }
}
