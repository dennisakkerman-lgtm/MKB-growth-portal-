import { query } from "../db/pool.js";

/**
 * Een generieke branchecurve is altijd fout. Een curve uit de eigen data
 * van het account houdt automatisch rekening met AI Overviews, local packs
 * en de branche. Daarom: eigen curve zodra er genoeg volume is, anders fallback.
 */

const FALLBACK: Record<number, number> = {
  1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.05, 7: 0.04, 8: 0.032, 9: 0.028, 10: 0.025,
  11: 0.015, 12: 0.013, 13: 0.012, 14: 0.011, 15: 0.010,
  16: 0.009, 17: 0.008, 18: 0.008, 19: 0.007, 20: 0.007,
};

const MIN_IMPRESSIONS_PER_POSITION = 500;

export type CtrCurve = {
  ctrAt: (position: number) => number;
  source: "own" | "fallback" | "mixed";
};

export async function buildCtrCurve(accountId: string, days = 90): Promise<CtrCurve> {
  const rows = await query<{ pos: number; ctr: string; impressions: string }>(
    `select round(position)::int          as pos,
            sum(clicks)::numeric
              / nullif(sum(impressions),0) as ctr,
            sum(impressions)               as impressions
       from gsc_query_daily
      where account_id = $1
        and date >= current_date - $2::int
        and position between 1 and 20
      group by 1
     having sum(impressions) >= $3
      order by 1`,
    [accountId, days, MIN_IMPRESSIONS_PER_POSITION],
  );

  const own = new Map<number, number>();
  for (const r of rows) {
    const ctr = Number(r.ctr);
    if (Number.isFinite(ctr) && ctr > 0) own.set(r.pos, ctr);
  }

  // Curve moet monotoon dalend zijn; ruis eruit halen voorkomt
  // absurde uitkomsten zoals "positie 8 converteert beter dan positie 3".
  const smoothed = smooth(own);

  const source: CtrCurve["source"] =
    smoothed.size === 0 ? "fallback" : smoothed.size >= 10 ? "own" : "mixed";

  return {
    source,
    ctrAt(position: number) {
      const p = Math.max(1, Math.min(20, Math.round(position)));
      return smoothed.get(p) ?? FALLBACK[p] ?? 0.005;
    },
  };
}

/** Forceert monotoon dalend verloop: elke positie mag niet boven de vorige uitkomen. */
function smooth(raw: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  let ceiling = Infinity;
  for (let p = 1; p <= 20; p++) {
    const v = raw.get(p);
    if (v === undefined) continue;
    const capped = Math.min(v, ceiling);
    out.set(p, capped);
    ceiling = capped;
  }
  return out;
}
