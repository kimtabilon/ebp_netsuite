"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRON_SCHEDULE = void 0;
exports.runCronNsRestItemReceiptDump = runCronNsRestItemReceiptDump;
const logger_config_1 = __importDefault(require("../../config/logger.config"));
const netsuite_rest_client_1 = require("../../services/netsuite.rest.client");
const item_receipt_rest_dump_1 = require("../../services/item_receipt.rest_dump");
const config_1 = require("./config");
/** Daily at 8:10 AM/PM */
exports.CRON_SCHEDULE = "10 8,20 * * *";
let running = false;
async function runCronNsRestItemReceiptDump() {
    if (running) {
        logger_config_1.default.warn("[CRON] [NS-REST-IR-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        logger_config_1.default.info("[CRON] [NS-REST-IR-DUMP] Start — untilExhausted fetch + Mongo upsert");
        const rows = await (0, netsuite_rest_client_1.fetchAllItemReceipts)({
            untilExhausted: true,
            expandSubResources: config_1.NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await (0, item_receipt_rest_dump_1.persistRestItemReceiptRows)(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_item_receipt_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        logger_config_1.default.info(`[CRON] [NS-REST-IR-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`);
    }
    catch (err) {
        logger_config_1.default.error("[CRON] [NS-REST-IR-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    }
    finally {
        running = false;
    }
}
