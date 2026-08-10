import pg from "pg";

/**
 * Directe Postgres-verbinding voor de workers.
 * Bulk upserts van honderdduizenden GSC-rijen gaan hier veel sneller
 * doorheen dan via supabase-js. RLS wordt omzeild — dit is de service-laag.
 */
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 8),
  idleTimeoutMillis: 30_000,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Bulk upsert in brokken. `columns` is de kolomvolgorde,
 * `rows` een array van waarde-arrays in diezelfde volgorde.
 * `conflictTarget` is de naam van de unique index, bijv. 'gsc_query_daily_uniq'.
 */
export async function bulkUpsert(
  table: string,
  columns: string[],
  rows: any[][],
  conflictTarget: string,
  updateColumns: string[],
  chunkSize = 1000,
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;

  const setClause = updateColumns.map((c) => `${c} = excluded.${c}`).join(", ");

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: any[] = [];
    const tuples = chunk.map((row) => {
      const ph = row.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      return `(${ph.join(",")})`;
    });

    const sql = `
      insert into ${table} (${columns.join(",")})
      values ${tuples.join(",")}
      on conflict on constraint ${conflictTarget}
      do update set ${setClause}
    `;
    const res = await pool.query(sql, values);
    written += res.rowCount ?? 0;
  }
  return written;
}
