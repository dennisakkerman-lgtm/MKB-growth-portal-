import {
  query, bulkUpsert, getAuthedClient, markRevoked, isGrantError,
  fetchSearchAnalytics, syncWindow, backfillChunks, DIMENSION_SETS,
} from "@portal/core";

type Property = { id: string; account_id: string; connection_id: string; site_url: string };

export async function syncGsc(
  accountId: string,
  propertyId: string,
  range?: { startDate: string; endDate: string },
): Promise<number> {
  const [prop] = await query<Property>(
    `select id, account_id, connection_id, site_url from gsc_properties where id = $1`,
    [propertyId],
  );
  if (!prop) throw new Error(`GSC-property ${propertyId} bestaat niet`);

  const [run] = await query<{ id: string }>(
    `insert into sync_runs (account_id, job) values ($1, 'sync:gsc') returning id`,
    [accountId],
  );

  const window = range ?? syncWindow(7);
  let written = 0;

  try {
    const auth = await getAuthedClient(prop.connection_id);

    // 1. query x device
    const qRows = await fetchSearchAnalytics(
      auth, prop.site_url, window.startDate, window.endDate, [...DIMENSION_SETS.query],
    );
    written += await bulkUpsert(
      "gsc_query_daily",
      ["account_id", "property_id", "date", "query", "device", "clicks", "impressions", "position", "ctr"],
      qRows.map((r) => [
        accountId, propertyId, r.keys[0], r.keys[1], r.keys[2],
        r.clicks, r.impressions, r.position, r.ctr,
      ]),
      "gsc_query_daily_uniq",
      ["clicks", "impressions", "position", "ctr"],
    );

    // 2. page
    const pRows = await fetchSearchAnalytics(
      auth, prop.site_url, window.startDate, window.endDate, [...DIMENSION_SETS.page],
    );
    written += await bulkUpsert(
      "gsc_page_daily",
      ["account_id", "property_id", "date", "page", "clicks", "impressions", "position", "ctr"],
      pRows.map((r) => [
        accountId, propertyId, r.keys[0], r.keys[1],
        r.clicks, r.impressions, r.position, r.ctr,
      ]),
      "gsc_page_daily_uniq",
      ["clicks", "impressions", "position", "ctr"],
    );

    // 3. query x page — alleen recent, deze tabel groeit hard
    const qpRows = await fetchSearchAnalytics(
      auth, prop.site_url, window.startDate, window.endDate, [...DIMENSION_SETS.queryPage],
    );
    written += await bulkUpsert(
      "gsc_query_page_recent",
      ["account_id", "property_id", "date", "query", "page", "clicks", "impressions", "position"],
      qpRows.map((r) => [
        accountId, propertyId, r.keys[0], r.keys[1], r.keys[2],
        r.clicks, r.impressions, r.position,
      ]),
      "gsc_qp_uniq",
      ["clicks", "impressions", "position"],
    );

    await query(
      `update sync_runs set status='ok', rows_written=$2, finished_at=now() where id=$1`,
      [run.id, written],
    );
    await query(
      `update google_connections set last_synced_at = now(), status='active', last_error=null
        where id = $1`,
      [prop.connection_id],
    );
    return written;
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (isGrantError(err)) {
      await markRevoked(prop.connection_id, msg);
    }
    await query(
      `update sync_runs set status='failed', error=$2, finished_at=now() where id=$1`,
      [run.id, msg],
    );
    throw err;
  }
}

/** 16 maanden historie in maandblokken, nieuw naar oud. */
export async function backfillGsc(
  accountId: string,
  propertyId: string,
  months = 16,
): Promise<number> {
  let total = 0;
  for (const chunk of backfillChunks(months)) {
    total += await syncGsc(accountId, propertyId, chunk);
  }
  await query(`update gsc_properties set backfilled_at = now() where id = $1`, [propertyId]);
  return total;
}

/** query_page_recent op 90 dagen houden — anders loopt de tabel vol. */
export async function pruneQueryPage(): Promise<void> {
  await query(`delete from gsc_query_page_recent where date < current_date - 90`);
}
