import log from "../../config/logger.config";
import { fetchAllInventoryItems } from "../../services/netsuite.rest.client";
import { persistRestInventoryItemRows } from "../../services/inventory_item.rest_dump";
import { NS_REST_CRON_EXPAND_LINES } from "./config";

/** Daily at 8:04 AM/PM */
export const CRON_SCHEDULE = "4 8,20 * * *";

let running = false;

export async function runCronNsRestInventoryItemDump(): Promise<void> {
    if (running) {
        log.warn("[CRON] [NS-REST-INV-ITEM-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        log.info("[CRON] [NS-REST-INV-ITEM-DUMP] Start — untilExhausted fetch + Mongo upsert");
        const rows = await fetchAllInventoryItems({
            untilExhausted: true,
            expandSubResources: NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await persistRestInventoryItemRows(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_inventory_item_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        log.info(
            `[CRON] [NS-REST-INV-ITEM-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`
        );
    } catch (err: any) {
        log.error("[CRON] [NS-REST-INV-ITEM-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    } finally {
        running = false;
    }
}
