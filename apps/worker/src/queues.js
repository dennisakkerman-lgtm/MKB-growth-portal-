import { Queue } from "bullmq";
import IORedis from "ioredis";
export const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
});
const defaults = {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
    },
};
/**
 * Backfill staat bewust in een eigen queue met lage concurrency.
 * Anders blokkeert één nieuwe klant met 16 maanden historie
 * de dagelijkse sync van alle bestaande klanten.
 */
export const syncQueue = new Queue("sync", defaults);
export const backfillQueue = new Queue("backfill", defaults);
export const analyzeQueue = new Queue("analyze", defaults);
export const publishQueue = new Queue("publish", defaults);
export const CONCURRENCY = {
    sync: 5,
    backfill: 2,
    analyze: 3,
    publish: 2,
};
