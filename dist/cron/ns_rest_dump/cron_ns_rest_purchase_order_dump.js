"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRON_SCHEDULE = void 0;
exports.runCronNsRestPurchaseOrderDump = runCronNsRestPurchaseOrderDump;
const logger_config_1 = __importDefault(require("../../config/logger.config"));
const netsuite_rest_client_1 = require("../../services/netsuite.rest.client");
const purchase_order_rest_dump_1 = require("../../services/purchase_order.rest_dump");
const config_1 = require("./config");
/** Daily at 8:02 AM/PM — staggered from SO dump. */
exports.CRON_SCHEDULE = "2 8,20 * * *";
let running = false;
async function runCronNsRestPurchaseOrderDump() {
    if (running) {
        logger_config_1.default.warn("[CRON] [NS-REST-PO-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        logger_config_1.default.info("[CRON] [NS-REST-PO-DUMP] Start — untilExhausted fetch + line expand + Mongo upsert");
        const rows = await (0, netsuite_rest_client_1.fetchAllPurchaseOrders)({
            untilExhausted: true,
            expandSubResources: config_1.NS_REST_CRON_EXPAND_LINES,
        });
        const persist = await (0, purchase_order_rest_dump_1.persistRestPurchaseOrderItems)(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_purchase_order_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        logger_config_1.default.info(`[CRON] [NS-REST-PO-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`);
    }
    catch (err) {
        logger_config_1.default.error("[CRON] [NS-REST-PO-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    }
    finally {
        running = false;
    }
}
