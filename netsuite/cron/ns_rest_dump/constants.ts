/** Per-id GET `expandSubResources` for line-level detail where NetSuite supports it */
export const NS_REST_DUMP_EXPAND_ITEM = "item";

/** Cron guard timeout (ms). Large untilExhausted runs can exceed 10m. */
export function nsRestDumpCronTimeoutMs(): number {
    const n = parseInt(process.env.NS_REST_DUMP_CRON_TIMEOUT_MS || "", 10);
    return Number.isFinite(n) && n >= 60_000 ? n : 90 * 60 * 1000;
}

/** When not `"false"`, NetSuite REST dump crons are scheduled (default on). */
export function nsRestDumpCronsEnabled(): boolean {
    return process.env.NS_REST_DUMP_CRONS_ENABLED !== "false";
}
