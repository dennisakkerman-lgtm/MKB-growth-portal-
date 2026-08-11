export declare function syncGsc(accountId: string, propertyId: string, range?: {
    startDate: string;
    endDate: string;
}): Promise<number>;
/** 16 maanden historie in maandblokken, nieuw naar oud. */
export declare function backfillGsc(accountId: string, propertyId: string, months?: number): Promise<number>;
/** query_page_recent op 90 dagen houden — anders loopt de tabel vol. */
export declare function pruneQueryPage(): Promise<void>;
