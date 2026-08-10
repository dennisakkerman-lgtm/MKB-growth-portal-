import { query } from "../db/pool.js";
import { buildCtrCurve, type CtrCurve } from "./ctrCurve.js";

/**
 * Zet ruwe GSC/GA4-signalen om in kansen met een bedrag in euro's.
 *
 *   extra_clicks = impressies_pm * (ctr_bij_doelpositie - ctr_huidig)
 *   value_eur    = extra_clicks * conv_rate * avg_deal_value
 *
 * Zonder conv_rate en avg_deal_value tonen we geen bedragen — dan is
 * de portal een dashboard, en dat is precies wat het niet moet zijn.
 */

const EFFORT_FACTOR = { low: 1, medium: 2.5, high: 5 } as const;
type Effort = keyof typeof EFFORT_FACTOR;

type Candidate = {
  type: string;
  query: string | null;
  page: string | null;
  impressions: number;
  position: number | null;
  currentCtr: number | null;
  extraClicks: number;
  effort: Effort;
  evidence: Record<string, unknown>;
};

export async function analyzeAccount(accountId: string): Promise<number> {
  const [acct] = await query<{ avg_deal_value: string | null; conv_rate: string | null }>(
    `select avg_deal_value, conv_rate from accounts where id = $1`,
    [accountId],
  );
  if (!acct) throw new Error(`Account ${accountId} bestaat niet`);

  const curve = await buildCtrCurve(accountId);
  const dealValue = Number(acct.avg_deal_value ?? 0);
  const convRate = Number(acct.conv_rate ?? 0);

  const candidates: Candidate[] = [
    ...(await strikingDistance(accountId, curve)),
    ...(await lowCtr(accountId, curve)),
    ...(await missingPage(accountId, curve)),
    ...(await decay(accountId)),
    ...(await cannibalisation(accountId)),
    ...(await convGap(accountId)),
  ];

  // Kansen die niet meer gedetecteerd worden, sluiten we automatisch.
  const seen = new Set(candidates.map((c) => `${c.type}|${c.query ?? ""}|${c.page ?? ""}`));
  const open = await query<{ id: string; type: string; query: string | null; page: string | null }>(
    `select id, type, query, page from opportunities
      where account_id = $1 and status = 'open'`,
    [accountId],
  );
  for (const o of open) {
    if (!seen.has(`${o.type}|${o.query ?? ""}|${o.page ?? ""}`)) {
      await query(
        `update opportunities set status = 'done', resolved_at = now() where id = $1`,
        [o.id],
      );
    }
  }

  for (const c of candidates) {
    const valueEur = dealValue > 0 && convRate > 0
      ? Math.round(c.extraClicks * convRate * dealValue)
      : null;
    const priority = valueEur !== null
      ? valueEur / EFFORT_FACTOR[c.effort]
      : c.extraClicks / EFFORT_FACTOR[c.effort];

    await query(
      `insert into opportunities
         (account_id, type, query, page, impressions, position, current_ctr,
          extra_clicks, value_eur, effort, priority, evidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict on constraint opportunities_open_uniq
       do update set impressions   = excluded.impressions,
                     position      = excluded.position,
                     current_ctr   = excluded.current_ctr,
                     extra_clicks  = excluded.extra_clicks,
                     value_eur     = excluded.value_eur,
                     priority      = excluded.priority,
                     evidence      = excluded.evidence`,
      [accountId, c.type, c.query, c.page, c.impressions, c.position, c.currentCtr,
       c.extraClicks, valueEur, c.effort, priority, JSON.stringify(c.evidence)],
    );
  }

  return candidates.length;
}

// ── Detectie ────────────────────────────────────────────────────────

/** Positie 11-20 met genoeg vertoningen. Doel: positie 6. */
async function strikingDistance(accountId: string, curve: CtrCurve): Promise<Candidate[]> {
  const rows = await query<any>(
    `select query,
            sum(impressions)                                   as impressions,
            sum(clicks)                                        as clicks,
            sum(position * impressions) / nullif(sum(impressions),0) as position
       from gsc_query_daily
      where account_id = $1 and date >= current_date - 30
      group by query
     having sum(impressions) >= 100
        and sum(position * impressions) / nullif(sum(impressions),0) between 11 and 20
      order by sum(impressions) desc
      limit 100`,
    [accountId],
  );

  return rows.map((r) => {
    const impressions = Number(r.impressions);
    const position = Number(r.position);
    const currentCtr = Number(r.clicks) / impressions;
    const target = curve.ctrAt(6);
    return {
      type: "striking_distance",
      query: r.query,
      page: null,
      impressions,
      position,
      currentCtr,
      extraClicks: Math.max(0, Math.round(impressions * (target - currentCtr))),
      effort: "medium" as Effort,
      evidence: { targetPosition: 6, targetCtr: target, curve: curve.source },
    };
  });
}

/**
 * Goede positie maar te lage doorklik. Alleen title en meta aanpassen,
 * resultaat binnen twee weken zichtbaar. Snelste winst bij een nieuwe klant.
 */
async function lowCtr(accountId: string, curve: CtrCurve): Promise<Candidate[]> {
  const rows = await query<any>(
    `select query,
            sum(impressions)                                   as impressions,
            sum(clicks)                                        as clicks,
            sum(position * impressions) / nullif(sum(impressions),0) as position
       from gsc_query_daily
      where account_id = $1 and date >= current_date - 30
      group by query
     having sum(impressions) >= 200
        and sum(position * impressions) / nullif(sum(impressions),0) <= 10
      order by sum(impressions) desc
      limit 200`,
    [accountId],
  );

  const out: Candidate[] = [];
  for (const r of rows) {
    const impressions = Number(r.impressions);
    const position = Number(r.position);
    const currentCtr = Number(r.clicks) / impressions;
    const expected = curve.ctrAt(position);
    if (currentCtr >= expected * 0.6) continue;

    out.push({
      type: "low_ctr",
      query: r.query,
      page: null,
      impressions,
      position,
      currentCtr,
      extraClicks: Math.max(0, Math.round(impressions * (expected - currentCtr))),
      effort: "low",
      evidence: { expectedCtr: expected, ratio: currentCtr / expected, curve: curve.source },
    });
  }
  return out.slice(0, 50);
}

/**
 * Zoekopdracht met volume waarvoor geen specifieke pagina bestaat —
 * de homepage of een irrelevante URL rankt. Dit is de brief voor Blogfinity.
 */
async function missingPage(accountId: string, curve: CtrCurve): Promise<Candidate[]> {
  const rows = await query<any>(
    `with ranked as (
       select query, page,
              sum(impressions) as impressions,
              sum(position * impressions) / nullif(sum(impressions),0) as position,
              row_number() over (partition by query order by sum(impressions) desc) as rn
         from gsc_query_page_recent
        where account_id = $1 and date >= current_date - 30
        group by query, page
     )
     select r.query, r.page, r.impressions, r.position
       from ranked r
       join accounts a on a.id = $1
      where r.rn = 1
        and r.impressions >= 150
        and r.position > 8
        and (
          -- homepage rankt voor een specifieke zoekopdracht
          r.page ~ '^https?://[^/]+/?$'
          -- of de zoekwoorden komen niet in de URL voor
          or position(lower(split_part(r.query, ' ', 1)) in lower(r.page)) = 0
        )
      order by r.impressions desc
      limit 50`,
    [accountId],
  );

  return rows.map((r) => {
    const impressions = Number(r.impressions);
    const position = Number(r.position);
    const target = curve.ctrAt(5);
    return {
      type: "missing_page",
      query: r.query,
      page: r.page,
      impressions,
      position,
      currentCtr: null,
      extraClicks: Math.max(0, Math.round(impressions * target * 0.5)),
      effort: "high" as Effort,
      evidence: { rankingPage: r.page, reason: "geen specifieke pagina voor deze zoekopdracht" },
    };
  });
}

/** Pagina's die terugvallen: klikken -30% t.o.v. de drie maanden ervoor. */
async function decay(accountId: string): Promise<Candidate[]> {
  const rows = await query<any>(
    `with recent as (
       select page, sum(clicks) as clicks, sum(impressions) as impressions
         from gsc_page_daily
        where account_id = $1 and date >= current_date - 30
        group by page
     ), baseline as (
       select page, sum(clicks)::numeric / 3 as clicks
         from gsc_page_daily
        where account_id = $1
          and date >= current_date - 120 and date < current_date - 30
        group by page
     )
     select r.page, r.clicks as recent_clicks, b.clicks as baseline_clicks, r.impressions
       from recent r join baseline b using (page)
      where b.clicks >= 20
        and r.clicks < b.clicks * 0.7
      order by (b.clicks - r.clicks) desc
      limit 30`,
    [accountId],
  );

  return rows.map((r) => ({
    type: "decay",
    query: null,
    page: r.page,
    impressions: Number(r.impressions),
    position: null,
    currentCtr: null,
    extraClicks: Math.max(0, Math.round(Number(r.baseline_clicks) - Number(r.recent_clicks))),
    effort: "medium" as Effort,
    evidence: {
      baselineClicks: Math.round(Number(r.baseline_clicks)),
      recentClicks: Number(r.recent_clicks),
      dropPct: Math.round((1 - Number(r.recent_clicks) / Number(r.baseline_clicks)) * 100),
    },
  }));
}

/** Twee of meer URL's die om dezelfde zoekopdracht concurreren. */
async function cannibalisation(accountId: string): Promise<Candidate[]> {
  const rows = await query<any>(
    `select query,
            count(distinct page)   as pages,
            sum(impressions)       as impressions,
            array_agg(distinct page) as page_list
       from gsc_query_page_recent
      where account_id = $1 and date >= current_date - 30
      group by query
     having count(distinct page) >= 2 and sum(impressions) >= 100
      order by sum(impressions) desc
      limit 30`,
    [accountId],
  );

  return rows.map((r) => ({
    type: "cannibalisation",
    query: r.query,
    page: null,
    impressions: Number(r.impressions),
    position: null,
    currentCtr: null,
    extraClicks: Math.round(Number(r.impressions) * 0.01),
    effort: "medium" as Effort,
    evidence: { pages: r.page_list, count: Number(r.pages) },
  }));
}

/** Veel bezoek, weinig aanvragen. Het 'growth'-deel: dit is geen SEO-probleem. */
async function convGap(accountId: string): Promise<Candidate[]> {
  const rows = await query<any>(
    `with site as (
       select sum(conversions)::numeric / nullif(sum(sessions),0) as rate
         from ga4_daily
        where account_id = $1 and date >= current_date - 30
     ), pages as (
       select landing_page,
              sum(sessions)     as sessions,
              sum(conversions)  as conversions,
              sum(conversions)::numeric / nullif(sum(sessions),0) as rate
         from ga4_daily
        where account_id = $1 and date >= current_date - 30
          and landing_page is not null
        group by landing_page
       having sum(sessions) >= 100
     )
     select p.*, s.rate as site_rate
       from pages p cross join site s
      where s.rate > 0 and p.rate < s.rate * 0.4
      order by p.sessions desc
      limit 20`,
    [accountId],
  );

  return rows.map((r) => {
    const sessions = Number(r.sessions);
    const gap = Number(r.site_rate) - Number(r.rate);
    return {
      type: "conv_gap",
      query: null,
      page: r.landing_page,
      impressions: sessions,
      position: null,
      currentCtr: Number(r.rate),
      extraClicks: 0, // geen extra klikken, wel extra aanvragen
      effort: "medium" as Effort,
      evidence: {
        pageRate: Number(r.rate),
        siteRate: Number(r.site_rate),
        extraLeads: Math.round(sessions * gap),
      },
    };
  });
}
