import {
  query, bulkUpsert, getAuthedClient, markRevoked, isGrantError, runReport,
} from "@portal/core";

type Property = { id: string; account_id: string; connection_id: string; property_id: string };

export async function syncGa4(
  accountId: string,
  propertyRowId: string,
  range?: { startDate: string; endDate: string },
): Promise<number> {
  const [prop] = await query<Property>(
    `select id, account_id, connection_id, property_id from ga4_properties where id = $1`,
    [propertyRowId],
  );
  if (!prop) throw new Error(`GA4-property ${propertyRowId} bestaat niet`);

  const [run] = await query<{ id: string }>(
    `insert into sync_runs (account_id, job) values ($1, 'sync:ga4') returning id`,
    [accountId],
  );

  const window = range ?? { startDate: "7daysAgo", endDate: "yesterday" };

  try {
    const auth = await getAuthedClient(prop.connection_id);
    const rows = await runReport(auth, prop.property_id, window.startDate, window.endDate);

    const written = await bulkUpsert(
      "ga4_daily",
      ["account_id", "property_id", "date", "channel_group", "landing_page",
       "sessions", "users", "engaged_sessions", "conversions", "revenue"],
      rows.map((r) => [
        accountId, propertyRowId, r.date, r.channelGroup, r.landingPage,
        r.sessions, r.users, r.engagedSessions, r.conversions, r.revenue,
      ]),
      "ga4_daily_uniq",
      ["sessions", "users", "engaged_sessions", "conversions", "revenue"],
    );

    await query(
      `update sync_runs set status='ok', rows_written=$2, finished_at=now() where id=$1`,
      [run.id, written],
    );
    return written;
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (isGrantError(err)) await markRevoked(prop.connection_id, msg);
    await query(
      `update sync_runs set status='failed', error=$2, finished_at=now() where id=$1`,
      [run.id, msg],
    );
    throw err;
  }
}

/**
 * Leidt de conversieratio af uit organisch verkeer en schrijft die
 * naar accounts.conv_rate. Zonder dit getal kan de kansenengine
 * geen euro's berekenen.
 */
export async function refreshConversionRate(accountId: string): Promise<number | null> {
  const [row] = await query<{ rate: string | null }>(
    `select sum(conversions)::numeric / nullif(sum(sessions),0) as rate
       from ga4_daily
      where account_id = $1
        and date >= current_date - 90
        and channel_group ilike '%organic%'`,
    [accountId],
  );
  const rate = row?.rate ? Number(row.rate) : null;
  if (rate && rate > 0 && rate < 1) {
    await query(`update accounts set conv_rate = $2 where id = $1`, [accountId, rate]);
  }
  return rate;
}
