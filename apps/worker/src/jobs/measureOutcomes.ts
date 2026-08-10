import { query } from "@portal/core";

/**
 * 28 dagen na publicatie meten we of de actie gewerkt heeft.
 * Dit is het enige harde bewijs dat je levert wat je belooft —
 * het voedt zowel het maandrapport als het verlengingsgesprek.
 */
export async function measureOutcomes(): Promise<number> {
  const actions = await query<{
    id: string; account_id: string; published_url: string; published_at: string;
  }>(
    `select a.id, a.account_id, a.published_url, a.published_at
       from actions a
       left join action_outcomes o on o.action_id = a.id
      where a.status = 'published'
        and a.published_url is not null
        and a.published_at <= now() - interval '28 days'
        and o.action_id is null`,
  );

  for (const a of actions) {
    const [before] = await query<{ clicks: string; pos: string }>(
      `select coalesce(sum(clicks),0) as clicks,
              sum(position * impressions) / nullif(sum(impressions),0) as pos
         from gsc_page_daily
        where account_id = $1 and page = $2
          and date >= $3::date - 28 and date < $3::date`,
      [a.account_id, a.published_url, a.published_at],
    );

    const [after] = await query<{ clicks: string; pos: string }>(
      `select coalesce(sum(clicks),0) as clicks,
              sum(position * impressions) / nullif(sum(impressions),0) as pos
         from gsc_page_daily
        where account_id = $1 and page = $2
          and date >= $3::date and date < $3::date + 28`,
      [a.account_id, a.published_url, a.published_at],
    );

    const [acct] = await query<{ avg_deal_value: string | null; conv_rate: string | null }>(
      `select avg_deal_value, conv_rate from accounts where id = $1`,
      [a.account_id],
    );

    const deltaClicks = Number(after?.clicks ?? 0) - Number(before?.clicks ?? 0);
    const dealValue = Number(acct?.avg_deal_value ?? 0);
    const convRate = Number(acct?.conv_rate ?? 0);
    const deltaValue = dealValue > 0 && convRate > 0
      ? Math.round(deltaClicks * convRate * dealValue)
      : null;

    await query(
      `insert into action_outcomes
         (action_id, baseline_clicks, baseline_pos, after_clicks, after_pos,
          delta_value_eur, measured_at)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (action_id) do update set
         after_clicks = excluded.after_clicks,
         after_pos    = excluded.after_pos,
         delta_value_eur = excluded.delta_value_eur,
         measured_at  = now()`,
      [a.id, Number(before?.clicks ?? 0), before?.pos ? Number(before.pos) : null,
       Number(after?.clicks ?? 0), after?.pos ? Number(after.pos) : null, deltaValue],
    );
  }
  return actions.length;
}
