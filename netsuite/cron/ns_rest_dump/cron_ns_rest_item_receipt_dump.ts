import log from "../../config/logger.config";
import { fetchAllItemReceipts } from "../../services/netsuite.rest.client";
import { persistRestItemReceiptRows } from "../../services/item_receipt.rest_dump";
import { NS_REST_CRON_EXPAND_LINES } from "./config";

/** Daily at 8:10 AM/PM */
export const CRON_SCHEDULE = "10 8,20 * * *";

let running = false;

export async function runCronNsRestItemReceiptDump(): Promise<void> {
    if (running) {
        log.warn("[CRON] [NS-REST-IR-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        log.info("[CRON] [NS-REST-IR-DUMP] Start — untilExhausted fetch + Mongo upsert");
        const rows = await fetchAllItemReceipts({
            untilExhausted: true,
            expandSubResources: NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await persistRestItemReceiptRows(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_item_receipt_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        log.info(
            `[CRON] [NS-REST-IR-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`
        );
    } catch (err: any) {
        log.error("[CRON] [NS-REST-IR-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    } finally {
        running = false;
    }
}
