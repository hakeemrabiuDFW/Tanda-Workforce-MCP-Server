/**
 * Response guard: every tool returns { summary, rows, page } with at most 50 rows
 * and at most 25 KB serialized. When rows are dropped, `truncated: true` and a
 * paging hint are included.
 */

export const MAX_ROWS = 50;
export const MAX_BYTES = 25 * 1024;

export interface GuardedResponse {
  summary: Record<string, unknown>;
  rows: unknown[];
  page: {
    page: number;
    page_size: number;
    total_rows: number;
    returned: number;
    has_more: boolean;
    offset: number;
    next_offset?: number;
  };
  truncated?: boolean;
  how_to_page?: string;
  [key: string]: unknown;
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export interface GuardOptions {
  page?: unknown;
  pageSize?: unknown;
  offset?: unknown;
  extra?: Record<string, unknown>;
  maxBytes?: number;
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function guardResponse(
  summary: Record<string, unknown>,
  allRows: unknown[],
  opts: GuardOptions = {}
): GuardedResponse {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const pageSize = Math.min(toPositiveInt(opts.pageSize, MAX_ROWS), MAX_ROWS);
  const page = toPositiveInt(opts.page, 1);
  const start = opts.offset !== undefined && opts.offset !== null
    ? Math.max(0, toPositiveInt(Number(opts.offset) + 1, 1) - 1)
    : (page - 1) * pageSize;
  let rows = allRows.slice(start, start + pageSize);

  const build = (r: unknown[], s: Record<string, unknown>): GuardedResponse => {
    const hasMore = start + r.length < allRows.length;
    const res: GuardedResponse = {
      summary: s,
      ...(opts.extra || {}),
      rows: r,
      page: {
        page,
        page_size: pageSize,
        total_rows: allRows.length,
        returned: r.length,
        has_more: hasMore,
        offset: start,
      },
    };
    if (hasMore) {
      const next = start + r.length;
      res.truncated = true;
      res.page.next_offset = next;
      res.how_to_page = r.length < pageSize
        ? `Response capped at ${Math.round(maxBytes / 1024)} KB. Call again with offset=${next} (same arguments) or narrow the filters.`
        : `Call again with offset=${next} (same arguments), or narrow the date range/filters.`;
    }
    return res;
  };

  let res = build(rows, summary);
  // Drop rows from the end until the payload fits
  while (byteSize(res) > maxBytes && rows.length > 0) {
    const over = byteSize(res) - maxBytes;
    const avg = byteSize(rows) / rows.length;
    const drop = Math.max(1, Math.ceil(over / Math.max(avg, 1)));
    rows = rows.slice(0, Math.max(0, rows.length - drop));
    res = build(rows, summary);
  }
  // Last resort: an oversized summary is replaced by a note rather than exceeding the cap
  if (byteSize(res) > maxBytes) {
    res = build([], { note: 'Summary too large; narrow the date range or filters.', keys: Object.keys(summary) });
    res.truncated = true;
  }
  return res;
}
