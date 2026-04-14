import log from "../../config/logger.config";
import { fetchAllItemFulfillments } from "../../services/netsuite.rest.client";
import { persistRestItemFulfillmentRows } from "../../services/item_fulfillment.rest_dump";
import { NS_REST_CRON_EXPAND_LINES } from "./config";

/** Daily at 8:08 AM/PM */
export const CRON_SCHEDULE = "8 8,20 * * *";

let running = false;

export async function runCronNsRestItemFulfillmentDump(): Promise<void> {
    if (running) {
        log.warn("[CRON] [NS-REST-IF-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        log.info("[CRON] [NS-REST-IF-DUMP] Start — untilExhausted fetch + Mongo upsert");
        const rows = await fetchAllItemFulfillments({
            untilExhausted: true,
            expandSubResources: NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await persistRestItemFulfillmentRows(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_item_fulfillment_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        log.info(
            `[CRON] [NS-REST-IF-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`
        );
    } catch (err: any) {
        log.error("[CRON] [NS-REST-IF-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    } finally {
        running = false;
    }
}
