"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRON_SCHEDULE = void 0;
exports.runCronNsRestClassificationDump = runCronNsRestClassificationDump;
const logger_config_1 = __importDefault(require("../../config/logger.config"));
const netsuite_rest_client_1 = require("../../services/netsuite.rest.client");
const classification_rest_dump_1 = require("../../services/classification.rest_dump");
/** Daily 8:06 AM/PM. Classification: no `item` expand (avoid 400s from NetSuite). */
exports.CRON_SCHEDULE = "6 8,20 * * *";
let running = false;
async function runCronNsRestClassificationDump() {
    if (running) {
        logger_config_1.default.warn("[CRON] [NS-REST-CLASS-DUMP] Skip — previous run still in progress");
        return;
    }
    running = true;
    try {
        logger_config_1.default.info("[CRON] [NS-REST-CLASS-DUMP] Start — untilExhausted fetch + Mongo upsert");
        const rows = await (0, netsuite_rest_client_1.fetchAllClassifications)({
            untilExhausted: true,
        });
        const persist = await (0, classification_rest_dump_1.persistRestClassificationRows)(rows, {
            save: true,
            queryContext: {
                mode: "cron_8am_8pm",
                job: "ns_rest_classification_dump",
                untilExhausted: true,
                pulled: rows.length,
            },
        });
        logger_config_1.default.info(`[CRON] [NS-REST-CLASS-DUMP] Done — pulled=${rows.length}, upserted=${persist.upserted}, skipped=${persist.skipped}, errors=${persist.errors}`);
    }
    catch (err) {
        logger_config_1.default.error("[CRON] [NS-REST-CLASS-DUMP] Error", { error: err?.message || String(err) });
        throw err;
    }
    finally {
        running = false;
    }
}
