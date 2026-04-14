import log from "../../config/logger.config";
import { fetchAllPurchaseOrders } from "../../services/netsuite.rest.client";
import { persistRestPurchaseOrderItems } from "../../services/purchase_order.rest_dump";
import { NS_REST_CRON_EXPAND_LINES } from "./config";

/** Daily at 8:02 AM/PM — staggered from SO dump. */
export const CRON_SCHEDULE = "2 8,20 * * *";

let running = false;

export async function runCronNsRestPurchaseOrderDump(): Promise<void> {
    if (running) {
        log.warn("[CRON] [NS-REST-PO-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        log.info("[CRON] [NS-REST-PO-DUMP] Start — untilExhausted fetch + line expand + Mongo upsert");
        const rows = await fetchAllPurchaseOrders({
            untilExhausted: true,
            expandSubResources: NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await persistRestPurchaseOrderItems(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_purchase_order_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        log.info(
            `[CRON] [NS-REST-PO-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`
        );
    } catch (err: any) {
        log.error("[CRON] [NS-REST-PO-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    } finally {
        running = false;
    }
}
