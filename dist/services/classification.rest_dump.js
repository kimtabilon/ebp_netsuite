"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NS_REST_CLASSIFICATION_DUMP_COLLECTION = void 0;
exports.persistRestClassificationRows = persistRestClassificationRows;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const netsuite_rest_client_1 = require("./netsuite.rest.client");
exports.NS_REST_CLASSIFICATION_DUMP_COLLECTION = "ns_rest_classification_detail_dump";
function extractNsIdFromRestPayload(item) {
    if (item == null || typeof item !== "object")
        return null;
    if (item._hydrateError && item.listItem) {
        return (0, netsuite_rest_client_1.extractClassificationIdFromListItem)(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "")
        return String(direct).trim();
    return (0, netsuite_rest_client_1.extractClassificationIdFromListItem)(item);
}
async function persistRestClassificationRows(items, options) {
    const base = {
        saved: false,
        collection: exports.NS_REST_CLASSIFICATION_DUMP_COLLECTION,
        upserted: 0,
        skipped: 0,
        errors: 0,
    };
    if (!options.save) {
        return base;
    }
    if (!Array.isArray(items) || items.length === 0) {
        base.saved = true;
        return base;
    }
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const col = ns_db.collection(exports.NS_REST_CLASSIFICATION_DUMP_COLLECTION);
    const now = new Date();
    for (const item of items) {
        const nsId = extractNsIdFromRestPayload(item);
        if (!nsId) {
            base.skipped++;
            continue;
        }
        const doc = {
            ns_internal_id: nsId,
            dumped_at: now,
            query_context: options.queryContext ?? null,
            payload: item,
        };
        try {
            await col.replaceOne({ ns_internal_id: nsId }, doc, { upsert: true });
            base.upserted++;
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST classification dump] upsert failed for ${nsId}:`, err?.message || err);
        }
    }
    base.saved = true;
    logger_config_1.default.info(`[NS REST classification dump] collection=${exports.NS_REST_CLASSIFICATION_DUMP_COLLECTION} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`);
    return base;
}
