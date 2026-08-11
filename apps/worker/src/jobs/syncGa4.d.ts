export declare function syncGa4(accountId: string, propertyRowId: string, range?: {
    startDate: string;
    endDate: string;
}): Promise<number>;
/**
 * Leidt de conversieratio af uit organisch verkeer en schrijft die
 * naar accounts.conv_rate. Zonder dit getal kan de kansenengine
 * geen euro's berekenen.
 */
export declare function refreshConversionRate(accountId: string): Promise<number | null>;
