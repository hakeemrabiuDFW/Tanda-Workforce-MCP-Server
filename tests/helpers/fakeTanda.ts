import { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { TandaClient, TandaClientOptions } from '../../src/tanda/client';

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, unknown>;
}

export type RouteHandler = (req: RecordedRequest) => unknown | { __status: number; __headers?: Record<string, string>; body?: unknown };

let counter = 0;

/** Empty org/user lookups so tools that enrich rows work without extra stubs. */
const DEFAULT_ROUTES: Array<[string | RegExp, RouteHandler]> = [
  ['/locations', () => []],
  ['/departments', () => []],
  ['/users', () => []],
];

/**
 * Build a TandaClient backed by an in-memory router instead of the network.
 * Routes are matched against the path (without /api/v2 base) using exact strings or regexes.
 */
export function fakeTanda(routes: Array<[string | RegExp, RouteHandler]>, options: Partial<TandaClientOptions> = {}) {
  const requests: RecordedRequest[] = [];

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const url = new URL(config.url || '', 'https://tanda.test');
    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (params[k] = v));
    if (config.params instanceof URLSearchParams) {
      config.params.forEach((v, k) => (params[k] = v));
    } else if (config.params) {
      for (const [k, v] of Object.entries(config.params)) params[k] = String(v);
    }
    const req: RecordedRequest = {
      method: (config.method || 'get').toUpperCase(),
      path: url.pathname,
      params,
      headers: { ...(config.headers || {}) },
    };
    requests.push(req);

    const all = [...routes, ...DEFAULT_ROUTES];
    const route = all.find(([m]) => (typeof m === 'string' ? m === req.path : m.test(req.path)));
    let status = 200;
    let headers: Record<string, string> = {};
    let data: unknown = route ? route[1](req) : undefined;
    if (!route) status = 404;
    if (data && typeof data === 'object' && '__status' in (data as Record<string, unknown>)) {
      const d = data as { __status: number; __headers?: Record<string, string>; body?: unknown };
      status = d.__status;
      headers = d.__headers || {};
      data = d.body;
    }

    const response: AxiosResponse = { data, status, statusText: String(status), headers, config };
    const validate = config.validateStatus || ((s: number) => s >= 200 && s < 300);
    if (!validate(status)) {
      const err = Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response,
        config,
      });
      throw err;
    }
    return response;
  };

  // Unique token per fake so the shared ETag/org cache never leaks between tests
  const client = new TandaClient(`fake-token-${++counter}`, undefined, undefined, { adapter, disableRateLimit: true, ...options });
  return { client, requests };
}

/** Unix seconds for a New York local wall-clock time (handles EST/EDT). */
export function nySeconds(date: string, time: string): number {
  // Try both offsets; pick the one whose NY rendering matches
  for (const offset of ['-04:00', '-05:00']) {
    const secs = Date.parse(`${date}T${time}:00${offset}`) / 1000;
    const rendered = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(secs * 1000)).replace(', ', 'T');
    if (rendered === `${date}T${time}`) return secs;
  }
  throw new Error(`Cannot resolve ${date} ${time} in America/New_York`);
}
