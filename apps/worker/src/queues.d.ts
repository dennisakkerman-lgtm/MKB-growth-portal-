import { Queue } from "bullmq";
import IORedis from "ioredis";
export declare const connection: IORedis;
/**
 * Backfill staat bewust in een eigen queue met lage concurrency.
 * Anders blokkeert één nieuwe klant met 16 maanden historie
 * de dagelijkse sync van alle bestaande klanten.
 */
export declare const syncQueue: Queue<any, any, string, any, any, string>;
export declare const backfillQueue: Queue<any, any, string, any, any, string>;
export declare const analyzeQueue: Queue<any, any, string, any, any, string>;
export declare const publishQueue: Queue<any, any, string, any, any, string>;
export declare const CONCURRENCY: {
    readonly sync: 5;
    readonly backfill: 2;
    readonly analyze: 3;
    readonly publish: 2;
};
export type SyncGscJob = {
    accountId: string;
    propertyId: string;
};
export type SyncGa4Job = {
    accountId: string;
    propertyId: string;
};
export type BackfillJob = {
    accountId: string;
    propertyId: string;
    months?: number;
};
export type AnalyzeJob = {
    accountId: string;
};
