import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const ROW_LIMIT = 25_000;

export type GscRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** Property's waar dit Google-account toegang toe heeft. */
export async function listSites(auth: OAuth2Client) {
  const sc = google.webmasters({ version: "v3", auth });
  const { data } = await sc.sites.list();
  return (data.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({ siteUrl: s.siteUrl!, permission: s.permissionLevel! }));
}

/**
 * Haalt alle rijen op voor één dimensiecombinatie, met paginering.
 * Google levert max 25.000 rijen per request; bij precies dat aantal
 * is er vrijwel zeker meer, dus doorpagineren met startRow.
 */
export async function fetchSearchAnalytics(
  auth: OAuth2Client,
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
): Promise<GscRow[]> {
  const sc = google.webmasters({ version: "v3", auth });
  const out: GscRow[] = [];
  let startRow = 0;

  for (;;) {
    const { data } = await withRetry(() =>
      sc.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate,
          endDate,
          dimensions,
          rowLimit: ROW_LIMIT,
          startRow,
          dataState: "final",
        },
      }),
    );

    const rows = (data.rows ?? []) as GscRow[];
    out.push(...rows);
    if (rows.length < ROW_LIMIT) break;
    startRow += ROW_LIMIT;

    // Vangnet: één property zou de queue niet uren mogen bezetten
    if (startRow > 500_000) break;
  }
  return out;
}

/**
 * Drie aparte runs. Gecombineerde dimensies laten rijen vallen door
 * Google's drempelwaarden — juist in de long tail waar de kansen zitten.
 */
export const DIMENSION_SETS = {
  query: ["date", "query", "device"],
  page: ["date", "page"],
  queryPage: ["date", "query", "page"],
} as const;

/** Exponential backoff op 429 en 5xx. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.code ?? err?.response?.status;
      if (code !== 429 && !(code >= 500 && code < 600)) throw err;
      const waitMs = Math.min(2 ** i * 1000 + Math.random() * 500, 30_000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/**
 * GSC-data is 2-3 dagen vertraagd. Dagelijks halen we een window terug
 * op en upserten dat, zodat late correcties automatisch meekomen.
 */
export function syncWindow(days = 7): { startDate: string; endDate: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { startDate: iso(start), endDate: iso(end) };
}

/** Backfill in maandblokken, nieuw naar oud zodat recente data er eerst staat. */
export function backfillChunks(months = 16): Array<{ startDate: string; endDate: string }> {
  const chunks: Array<{ startDate: string; endDate: string }> = [];
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 2);

  for (let i = 0; i < months; i++) {
    const end = new Date(cursor);
    const start = new Date(cursor);
    start.setUTCMonth(start.getUTCMonth() - 1);
    chunks.push({ startDate: iso(start), endDate: iso(end) });
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return chunks;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
