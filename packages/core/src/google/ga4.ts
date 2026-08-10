import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type Ga4Row = {
  date: string;
  channelGroup: string | null;
  landingPage: string | null;
  sessions: number;
  users: number;
  engagedSessions: number;
  conversions: number;
  revenue: number;
};

/** Property's waar dit Google-account toegang toe heeft. */
export async function listProperties(auth: OAuth2Client) {
  const admin = google.analyticsadmin({ version: "v1beta", auth });
  const { data } = await admin.accountSummaries.list({ pageSize: 200 });

  const out: Array<{ propertyId: string; displayName: string }> = [];
  for (const acc of data.accountSummaries ?? []) {
    for (const p of acc.propertySummaries ?? []) {
      out.push({ propertyId: p.property!, displayName: p.displayName ?? p.property! });
    }
  }
  return out;
}

/** Welke conversie-events bestaan er — de klant vinkt bij onboarding aan wat een aanvraag is. */
export async function listConversionEvents(auth: OAuth2Client, propertyId: string) {
  const admin = google.analyticsadmin({ version: "v1beta", auth });
  const { data } = await admin.properties.conversionEvents.list({ parent: propertyId });
  return (data.conversionEvents ?? []).map((e) => e.eventName!).filter(Boolean);
}

export async function runReport(
  auth: OAuth2Client,
  propertyId: string,
  startDate: string,
  endDate: string,
): Promise<Ga4Row[]> {
  const dataApi = google.analyticsdata({ version: "v1beta", auth });

  const { data } = await withRetry(() =>
    dataApi.properties.runReport({
      property: propertyId,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [
          { name: "date" },
          { name: "sessionDefaultChannelGroup" },
          { name: "landingPage" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "engagedSessions" },
          { name: "conversions" },
          { name: "totalRevenue" },
        ],
        limit: "100000",
      },
    }),
  );

  return (data.rows ?? []).map((r) => {
    const d = r.dimensionValues ?? [];
    const m = r.metricValues ?? [];
    return {
      date: fmtDate(d[0]?.value ?? ""),
      channelGroup: d[1]?.value ?? null,
      landingPage: d[2]?.value ?? null,
      sessions: num(m[0]?.value),
      users: num(m[1]?.value),
      engagedSessions: num(m[2]?.value),
      conversions: num(m[3]?.value),
      revenue: num(m[4]?.value),
    };
  });
}

/** GA4 geeft datums als YYYYMMDD terug. */
function fmtDate(v: string): string {
  return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}

function num(v: string | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = err?.code ?? err?.response?.status;
      if (code !== 429 && !(code >= 500 && code < 600)) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2 ** i * 1000, 30_000)));
    }
  }
  throw lastErr;
}
