"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const inventory_item_rest_dump_1 = require("../services/inventory_item.rest_dump");
const classification_rest_dump_1 = require("../services/classification.rest_dump");
const item_fulfillment_rest_dump_1 = require("../services/item_fulfillment.rest_dump");
const item_receipt_rest_dump_1 = require("../services/item_receipt.rest_dump");
const router = (0, express_1.Router)();
function parsePersistDbFlag(req) {
    const q = req.query || {};
    const b = req.body || {};
    const truthy = (v) => v === true || v === "true" || v === "1" || v === 1;
    return (truthy(q.persistDb) ||
        truthy(q.saveToDb) ||
        truthy(b.persistDb) ||
        truthy(b.saveToDb));
}
/** Same semantics as SO/PO: off unless explicitly enabled — surface why nothing landed in Mongo. */
function enrichPersistResult(persistResult, persistDb, rowCount) {
    const out = { ...persistResult };
    if (!persistDb && rowCount > 0) {
        out.hint =
            'Mongo dump is disabled. Add ?persistDb=true or ?saveToDb=true (GET query). Writes use database "netsuite"; collection is persist.collection.';
    }
    else if (persistDb && rowCount > 0 && persistResult.upserted === 0 && persistResult.skipped === rowCount) {
        out.hint =
            "persistDb=true but every row was skipped (no internal id). See server log for first row keys; NetSuite list shape may differ.";
    }
    else if (persistDb && persistResult.errors > 0 && persistResult.upserted === 0) {
        out.hint = 'Mongo upsert failed; check server logs and write access to database "netsuite".';
    }
    return out;
}
function registerRestRecordRoutes(cfg) {
    const listPath = `/${cfg.pathSegment}`;
    const getPath = `/${cfg.pathSegment}/:id`;
    router.get(listPath, async (req, res) => {
        const prefer = req.headers.prefer;
        const idempotencyKey = req.headers["x-netsuite-idempotency-key"];
        const fetchAll = req.query.fetchAll === "true";
        const persistDb = parsePersistDbFlag(req);
        try {
            if (fetchAll) {
                const rawMax = req.query.maxRecords != null ? parseInt(String(req.query.maxRecords), 10) : NaN;
                const maxRecords = Number.isFinite(rawMax)
                    ? Math.min(Math.max(1, rawMax), cfg.fetchAllAbsMax)
                    : cfg.fetchAllDefaultMax;
                const rawPage = req.query.pageSize != null ? parseInt(String(req.query.pageSize), 10) : NaN;
                const pageSize = Number.isFinite(rawPage) ? Math.min(Math.max(1, rawPage), 1000) : undefined;
                logger_config_1.default.info(`[${cfg.logLabel} List] fetchAll — maxRecords=${maxRecords}` +
                    (pageSize != null ? `, pageSize=${pageSize}` : ""));
                const allRecords = await cfg.fetchAllFn({
                    q: req.query.q,
                    expandSubResources: req.query.expandItems === "true" ? "item" : undefined,
                    maxRecords,
                    pageSize,
                });
                const persistResult = await cfg.persistItems(allRecords, {
                    save: persistDb,
                    queryContext: {
                        mode: "fetchAll",
                        maxRecords,
                        pageSize: pageSize ?? null,
                        q: req.query.q ?? null,
                        dbPayloadSource: "per_id_get",
                    },
                });
                return res.json({
                    success: true,
                    fetchAll: true,
                    maxRecords,
                    pageSize: pageSize ?? null,
                    count: allRecords.length,
                    items: allRecords,
                    persistDb,
                    persist: enrichPersistResult(persistResult, persistDb, allRecords.length),
                    limits: {
                        defaultMax: cfg.fetchAllDefaultMax,
                        absMax: cfg.fetchAllAbsMax,
                    },
                });
            }
            const rawListLimit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : NaN;
            const listLimit = Number.isFinite(rawListLimit)
                ? Math.min(Math.max(1, rawListLimit), cfg.listAbsMax)
                : cfg.listDefaultLimit;
            const rawOffset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : 0;
            const listOffset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
            const expandOnDetail = req.query.expandItems === "true" ? "item" : undefined;
            const wantDetails = (0, netsuite_rest_client_1.restListWantDetails)(req.query);
            const listOptions = {
                q: req.query.q,
                limit: listLimit,
                offset: listOffset,
                expandSubResources: wantDetails ? undefined : expandOnDetail,
            };
            if (prefer === "respond-async") {
                if (!idempotencyKey) {
                    return res.status(400).json({ success: false, error: "X-NetSuite-Idempotency-Key required for async" });
                }
                const data = await cfg.listFn(listOptions);
                if (!wantDetails) {
                    const listOnly = (0, netsuite_rest_client_1.normalizeRestRecordListItems)(data);
                    let rowsForPersist = listOnly;
                    if (persistDb && listOnly.length > 0) {
                        logger_config_1.default.info(`[${cfg.logLabel} List] persistDb=true + details=false → per-id GET for Mongo (${listOnly.length} row(s))`);
                        rowsForPersist = await cfg.hydrateFromListRows(listOnly, expandOnDetail);
                    }
                    const persistResult = await cfg.persistItems(rowsForPersist, {
                        save: persistDb,
                        queryContext: {
                            mode: "list_only_async",
                            limit: listLimit,
                            offset: listOffset,
                            q: req.query.q ?? null,
                            dbPayloadSource: persistDb && listOnly.length > 0 ? "per_id_get" : "list_row",
                        },
                    });
                    return res.status(202).setHeader("Preference-Applied", "respond-async").json({
                        success: true,
                        async: true,
                        idempotencyKey,
                        details: false,
                        ...data,
                        limit: listLimit,
                        offset: listOffset,
                        persistDb,
                        persist: enrichPersistResult(persistResult, persistDb, rowsForPersist.length),
                    });
                }
                const listItems = (0, netsuite_rest_client_1.normalizeRestRecordListItems)(data);
                if (wantDetails && listItems.length === 0 && data && typeof data === "object") {
                    logger_config_1.default.warn(`[${cfg.logLabel} List] details=true but no list rows — keys: ${Object.keys(data).join(", ")}`);
                }
                const items = await cfg.hydrateFromListRows(listItems, expandOnDetail);
                const persistResult = await cfg.persistItems(items, {
                    save: persistDb,
                    queryContext: {
                        mode: "list_details_async",
                        limit: listLimit,
                        offset: listOffset,
                        q: req.query.q ?? null,
                        dbPayloadSource: "per_id_get",
                    },
                });
                const accountHost = (process.env.NS_ACCOUNT_ID || "").toLowerCase().replace(/_/g, "-");
                const recordDetailBase = accountHost
                    ? `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/record/v1/${cfg.pathSegment}`
                    : null;
                return res.status(202).setHeader("Preference-Applied", "respond-async").json({
                    success: true,
                    async: true,
                    idempotencyKey,
                    details: true,
                    limit: listLimit,
                    offset: listOffset,
                    hasMore: data.hasMore,
                    totalResults: data.totalResults,
                    count: items.length,
                    ids: listItems.map((row) => cfg.extractIdFromListItem(row)).filter(Boolean),
                    recordDetailBase,
                    persistDb,
                    persist: enrichPersistResult(persistResult, persistDb, items.length),
                    items,
                });
            }
            const data = await cfg.listFn(listOptions);
            if (!wantDetails) {
                const listOnly = (0, netsuite_rest_client_1.normalizeRestRecordListItems)(data);
                let rowsForPersist = listOnly;
                if (persistDb && listOnly.length > 0) {
                    logger_config_1.default.info(`[${cfg.logLabel} List] persistDb=true + details=false → per-id GET for Mongo (${listOnly.length} row(s))`);
                    rowsForPersist = await cfg.hydrateFromListRows(listOnly, expandOnDetail);
                }
                const persistResult = await cfg.persistItems(rowsForPersist, {
                    save: persistDb,
                    queryContext: {
                        mode: "list_only",
                        limit: listLimit,
                        offset: listOffset,
                        q: req.query.q ?? null,
                        dbPayloadSource: persistDb && listOnly.length > 0 ? "per_id_get" : "list_row",
                    },
                });
                return res.json({
                    success: true,
                    details: false,
                    ...data,
                    limit: listLimit,
                    offset: listOffset,
                    persistDb,
                    persist: enrichPersistResult(persistResult, persistDb, rowsForPersist.length),
                });
            }
            const listItems = (0, netsuite_rest_client_1.normalizeRestRecordListItems)(data);
            if (wantDetails && listItems.length === 0 && data && typeof data === "object") {
                logger_config_1.default.warn(`[${cfg.logLabel} List] details=true but no list rows — keys: ${Object.keys(data).join(", ")}`);
            }
            const items = await cfg.hydrateFromListRows(listItems, expandOnDetail);
            const persistResult = await cfg.persistItems(items, {
                save: persistDb,
                queryContext: {
                    mode: "list_details",
                    limit: listLimit,
                    offset: listOffset,
                    q: req.query.q ?? null,
                    dbPayloadSource: "per_id_get",
                },
            });
            const accountHost = (process.env.NS_ACCOUNT_ID || "").toLowerCase().replace(/_/g, "-");
            const recordDetailBase = accountHost
                ? `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/record/v1/${cfg.pathSegment}`
                : null;
            return res.json({
                success: true,
                details: true,
                limit: listLimit,
                offset: listOffset,
                hasMore: data.hasMore,
                totalResults: data.totalResults,
                count: items.length,
                ids: listItems.map((row) => cfg.extractIdFromListItem(row)).filter(Boolean),
                recordDetailBase,
                persistDb,
                persist: enrichPersistResult(persistResult, persistDb, items.length),
                items,
            });
        }
        catch (e) {
            logger_config_1.default.error(`[${cfg.logLabel} List] Error:`, e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
    router.get(getPath, async (req, res) => {
        const { id } = req.params;
        const expandSubResources = req.query.expandItems === "true" ? "item" : undefined;
        const persistDb = parsePersistDbFlag(req);
        try {
            const data = await cfg.getFn(id, expandSubResources);
            if (persistDb) {
                const persistResult = await cfg.persistItems([data], {
                    save: true,
                    queryContext: {
                        mode: "single_record_get",
                        id: String(id),
                        dbPayloadSource: "per_id_get",
                    },
                });
                return res.json({
                    success: true,
                    data,
                    persistDb,
                    persist: enrichPersistResult(persistResult, persistDb, 1),
                });
            }
            res.json({ success: true, data });
        }
        catch (e) {
            logger_config_1.default.error(`[${cfg.logLabel} Get] ${id} Error:`, e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
}
registerRestRecordRoutes({
    pathSegment: "inventoryItem",
    logLabel: "InventoryItem",
    listFn: netsuite_rest_client_1.listInventoryItems,
    getFn: netsuite_rest_client_1.getInventoryItem,
    fetchAllFn: netsuite_rest_client_1.fetchAllInventoryItems,
    hydrateFromListRows: netsuite_rest_client_1.hydrateInventoryItemsFromListRows,
    extractIdFromListItem: netsuite_rest_client_1.extractInventoryItemIdFromListItem,
    persistItems: inventory_item_rest_dump_1.persistRestInventoryItemRows,
    fetchAllDefaultMax: netsuite_rest_client_1.INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: netsuite_rest_client_1.INVENTORY_ITEM_FETCH_ALL_ABS_MAX,
    listDefaultLimit: netsuite_rest_client_1.INVENTORY_ITEM_LIST_DEFAULT_LIMIT,
    listAbsMax: netsuite_rest_client_1.INVENTORY_ITEM_LIST_ABS_MAX,
});
registerRestRecordRoutes({
    pathSegment: "classification",
    logLabel: "Classification",
    listFn: netsuite_rest_client_1.listClassifications,
    getFn: netsuite_rest_client_1.getClassification,
    fetchAllFn: netsuite_rest_client_1.fetchAllClassifications,
    hydrateFromListRows: netsuite_rest_client_1.hydrateClassificationsFromListRows,
    extractIdFromListItem: netsuite_rest_client_1.extractClassificationIdFromListItem,
    persistItems: classification_rest_dump_1.persistRestClassificationRows,
    fetchAllDefaultMax: netsuite_rest_client_1.CLASSIFICATION_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: netsuite_rest_client_1.CLASSIFICATION_FETCH_ALL_ABS_MAX,
    listDefaultLimit: netsuite_rest_client_1.CLASSIFICATION_LIST_DEFAULT_LIMIT,
    listAbsMax: netsuite_rest_client_1.CLASSIFICATION_LIST_ABS_MAX,
});
registerRestRecordRoutes({
    pathSegment: "itemFulfillment",
    logLabel: "ItemFulfillment",
    listFn: netsuite_rest_client_1.listItemFulfillments,
    getFn: netsuite_rest_client_1.getItemFulfillment,
    fetchAllFn: netsuite_rest_client_1.fetchAllItemFulfillments,
    hydrateFromListRows: netsuite_rest_client_1.hydrateItemFulfillmentsFromListRows,
    extractIdFromListItem: netsuite_rest_client_1.extractItemFulfillmentIdFromListItem,
    persistItems: item_fulfillment_rest_dump_1.persistRestItemFulfillmentRows,
    fetchAllDefaultMax: netsuite_rest_client_1.ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: netsuite_rest_client_1.ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX,
    listDefaultLimit: netsuite_rest_client_1.ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT,
    listAbsMax: netsuite_rest_client_1.ITEM_FULFILLMENT_LIST_ABS_MAX,
});
registerRestRecordRoutes({
    pathSegment: "itemReceipt",
    logLabel: "ItemReceipt",
    listFn: netsuite_rest_client_1.listItemReceipts,
    getFn: netsuite_rest_client_1.getItemReceipt,
    fetchAllFn: netsuite_rest_client_1.fetchAllItemReceipts,
    hydrateFromListRows: netsuite_rest_client_1.hydrateItemReceiptsFromListRows,
    extractIdFromListItem: netsuite_rest_client_1.extractItemReceiptIdFromListItem,
    persistItems: item_receipt_rest_dump_1.persistRestItemReceiptRows,
    fetchAllDefaultMax: netsuite_rest_client_1.ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: netsuite_rest_client_1.ITEM_RECEIPT_FETCH_ALL_ABS_MAX,
    listDefaultLimit: netsuite_rest_client_1.ITEM_RECEIPT_LIST_DEFAULT_LIMIT,
    listAbsMax: netsuite_rest_client_1.ITEM_RECEIPT_LIST_ABS_MAX,
});
exports.default = router;
