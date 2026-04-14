import log from "../../config/logger.config";
import { fetchAllClassifications } from "../../services/netsuite.rest.client";
import { persistRestClassificationRows } from "../../services/classification.rest_dump";

/** Daily 8:06 AM/PM. Classification: no `item` expand (avoid 400s from NetSuite). */
export const CRON_SCHEDULE = "6 8,20 * * *";

let running = false;

export async function runCronNsRestClassificationDump(): Promise<void> {
    if (running) {
        log.warn("[CRON] [NS-REST-CLASS-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        log.info("[CRON] [NS-REST-CLASS-DUMP] Start — untilExhausted fetch + Mongo upsert");
        const rows = await fetchAllClassifications({
            untilExhausted: true,
        });
        const persist = await persistRestClassificationRows(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_classification_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        log.info(
            `[CRON] [NS-REST-CLASS-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`
        );
    } catch (err: any) {
        log.error("[CRON] [NS-REST-CLASS-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    } finally {
        running = false;
    }
}
