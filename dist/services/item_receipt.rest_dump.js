"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NS_REST_ITEM_RECEIPT_DUMP_COLLECTION_DUMMY = exports.NS_REST_ITEM_RECEIPT_DUMP_COLLECTION = void 0;
exports.persistRestItemReceiptRows = persistRestItemReceiptRows;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const netsuite_rest_client_1 = require("./netsuite.rest.client");
exports.NS_REST_ITEM_RECEIPT_DUMP_COLLECTION = "ns_rest_item_receipt_detail_dump";
exports.NS_REST_ITEM_RECEIPT_DUMP_COLLECTION_DUMMY = "ns_rest_item_receipt_detail_dump_dummy";
function extractNsIdFromRestPayload(item) {
    if (item == null || typeof item !== "object")
        return null;
    if (item._hydrateError && item.listItem) {
        return (0, netsuite_rest_client_1.extractItemReceiptIdFromListItem)(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "")
        return String(direct).trim();
    return (0, netsuite_rest_client_1.extractItemReceiptIdFromListItem)(item);
}
async function persistRestItemReceiptRows(items, options) {
    const targetCollection = options.collection || exports.NS_REST_ITEM_RECEIPT_DUMP_COLLECTION;
    const base = {
        saved: false,
        collection: targetCollection,
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
    const col = ns_db.collection(targetCollection);
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
            logger_config_1.default.error(`[NS REST item receipt dump] upsert failed for ${nsId}:`, err?.message || err);
        }
    }
    base.saved = true;
    logger_config_1.default.info(`[NS REST item receipt dump] collection=${targetCollection} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`);
    return base;
}
