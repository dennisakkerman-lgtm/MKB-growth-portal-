import "dotenv/config";
import { Worker } from "bullmq";
import { query, analyzeAccount } from "@portal/core";
import { connection, CONCURRENCY, syncQueue, analyzeQueue, } from "./queues.js";
import { syncGsc, backfillGsc, pruneQueryPage } from "./jobs/syncGsc.js";
import { syncGa4, refreshConversionRate } from "./jobs/syncGa4.js";
import { measureOutcomes } from "./jobs/measureOutcomes.js";
// ── Processors ──────────────────────────────────────────────────────
new Worker("sync", async (job) => {
    switch (job.name) {
        case "gsc": {
            const { accountId, propertyId } = job.data;
            return syncGsc(accountId, propertyId);
        }
        case "ga4": {
            const { accountId, propertyId } = job.data;
            const n = await syncGa4(accountId, propertyId);
            await refreshConversionRate(accountId);
            return n;
        }
        default:
            throw new Error(`Onbekende sync-job: ${job.name}`);
    }
}, { connection, concurrency: CONCURRENCY.sync });
new Worker("backfill", async (job) => {
    const { accountId, propertyId, months } = job.data;
    return backfillGsc(accountId, propertyId, months ?? 16);
}, { connection, concurrency: CONCURRENCY.backfill });
new Worker("analyze", async (job) => {
    const { accountId } = job.data;
    return analyzeAccount(accountId);
}, { connection, concurrency: CONCURRENCY.analyze });
// ── Scheduler ───────────────────────────────────────────────────────
// Repeatable jobs staan in Redis; opnieuw toevoegen is idempotent.
async function schedule() {
    await syncQueue.add("tick:gsc", {}, {
        repeat: { pattern: "0 3 * * *", tz: "Europe/Amsterdam" }, jobId: "tick-gsc",
    });
    await syncQueue.add("tick:ga4", {}, {
        repeat: { pattern: "30 3 * * *", tz: "Europe/Amsterdam" }, jobId: "tick-ga4",
    });
    await analyzeQueue.add("tick:analyze", {}, {
        repeat: { pattern: "0 5 * * *", tz: "Europe/Amsterdam" }, jobId: "tick-analyze",
    });
}
/**
 * De tick-jobs waaieren uit naar één job per property/account.
 * Zo blijft een trage klant geen andere klanten ophouden.
 */
new Worker("sync", async (job) => {
    if (job.name === "tick:gsc") {
        const props = await query(`select p.id, p.account_id from gsc_properties p
           join google_connections c on c.id = p.connection_id
          where p.is_active and c.status = 'active'`);
        for (const p of props) {
            await syncQueue.add("gsc", { accountId: p.account_id, propertyId: p.id });
        }
        await pruneQueryPage();
        return props.length;
    }
    if (job.name === "tick:ga4") {
        const props = await query(`select p.id, p.account_id from ga4_properties p
           join google_connections c on c.id = p.connection_id
          where p.is_active and c.status = 'active'`);
        for (const p of props) {
            await syncQueue.add("ga4", { accountId: p.account_id, propertyId: p.id });
        }
        return props.length;
    }
    return 0;
}, { connection, concurrency: 1, name: "sync-ticks" });
new Worker("analyze", async (job) => {
    if (job.name !== "tick:analyze")
        return 0;
    const accounts = await query(`select id from accounts where status = 'active'`);
    for (const a of accounts) {
        await analyzeQueue.add("account", { accountId: a.id });
    }
    await measureOutcomes();
    return accounts.length;
}, { connection, concurrency: 1, name: "analyze-ticks" });
await schedule();
console.log("[worker] draait — queues: sync, backfill, analyze, publish");
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
        console.log(`[worker] ${sig} ontvangen, afsluiten`);
        await connection.quit();
        process.exit(0);
    });
}
