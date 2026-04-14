import log from "../../config/logger.config";
import { fetchAllSalesOrders } from "../../services/netsuite.rest.client";
import { persistRestSalesOrderItems } from "../../services/sales_order.rest_dump";
import { NS_REST_CRON_EXPAND_LINES } from "./config";

/** Daily at 8:00 AM and 8:00 PM (server local time). */
export const CRON_SCHEDULE = "0 8,20 * * *";

let running = false;

export async function runCronNsRestSalesOrderDump(): Promise<void> {
    if (running) {
        log.warn("[CRON] [NS-REST-SO-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        log.info("[CRON] [NS-REST-SO-DUMP] Start — untilExhausted fetch + line expand + Mongo upsert");
        const rows = await fetchAllSalesOrders({
            untilExhausted: true,
            expandSubResources: NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await persistRestSalesOrderItems(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_sales_order_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        log.info(
            `[CRON] [NS-REST-SO-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`
        );
    } catch (err: any) {
        log.error("[CRON] [NS-REST-SO-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    } finally {
        running = false;
    }
}
