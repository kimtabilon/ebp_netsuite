import { Router } from "express";
import log from "../config/logger.config";
import {
    restListWantDetails,
    normalizeRestRecordListItems,
    listInventoryItems,
    getInventoryItem,
    fetchAllInventoryItems,
    hydrateInventoryItemsFromListRows,
    extractInventoryItemIdFromListItem,
    INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX,
    INVENTORY_ITEM_FETCH_ALL_ABS_MAX,
    INVENTORY_ITEM_LIST_DEFAULT_LIMIT,
    INVENTORY_ITEM_LIST_ABS_MAX,
    listClassifications,
    getClassification,
    fetchAllClassifications,
    hydrateClassificationsFromListRows,
    extractClassificationIdFromListItem,
    CLASSIFICATION_FETCH_ALL_DEFAULT_MAX,
    CLASSIFICATION_FETCH_ALL_ABS_MAX,
    CLASSIFICATION_LIST_DEFAULT_LIMIT,
    CLASSIFICATION_LIST_ABS_MAX,
    listItemFulfillments,
    getItemFulfillment,
    fetchAllItemFulfillments,
    hydrateItemFulfillmentsFromListRows,
    extractItemFulfillmentIdFromListItem,
    ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX,
    ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX,
    ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT,
    ITEM_FULFILLMENT_LIST_ABS_MAX,
    listItemReceipts,
    getItemReceipt,
    fetchAllItemReceipts,
    hydrateItemReceiptsFromListRows,
    extractItemReceiptIdFromListItem,
    ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX,
    ITEM_RECEIPT_FETCH_ALL_ABS_MAX,
    ITEM_RECEIPT_LIST_DEFAULT_LIMIT,
    ITEM_RECEIPT_LIST_ABS_MAX,
} from "../services/netsuite.rest.client";
import { persistRestInventoryItemRows } from "../services/inventory_item.rest_dump";
import { persistRestClassificationRows } from "../services/classification.rest_dump";
import { persistRestItemFulfillmentRows } from "../services/item_fulfillment.rest_dump";
import { persistRestItemReceiptRows } from "../services/item_receipt.rest_dump";

const router = Router();

function parsePersistDbFlag(req: any): boolean {
    const q = req.query || {};
    const b = req.body || {};
    const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === 1;
    return (
        truthy(q.persistDb) ||
        truthy(q.saveToDb) ||
        truthy(b.persistDb) ||
        truthy(b.saveToDb)
    );
}

/** Same semantics as SO/PO: off unless explicitly enabled — surface why nothing landed in Mongo. */
function enrichPersistResult(
    persistResult: { collection: string; upserted: number; skipped: number; errors: number },
    persistDb: boolean,
    rowCount: number
) {
    const out: Record<string, unknown> = { ...persistResult };
    if (!persistDb && rowCount > 0) {
        out.hint =
            'Mongo dump is disabled. Add ?persistDb=true or ?saveToDb=true (GET query). Writes use database "netsuite"; collection is persist.collection.';
    } else if (persistDb && rowCount > 0 && persistResult.upserted === 0 && persistResult.skipped === rowCount) {
        out.hint =
            "persistDb=true but every row was skipped (no internal id). See server log for first row keys; NetSuite list shape may differ.";
    } else if (persistDb && persistResult.errors > 0 && persistResult.upserted === 0) {
        out.hint = 'Mongo upsert failed; check server logs and write access to database "netsuite".';
    }
    return out;
}

type PersistFn = (
    items: any[],
    options: { save: boolean; queryContext?: Record<string, unknown> }
) => Promise<{ saved: boolean; collection: string; upserted: number; skipped: number; errors: number }>;

type RestRecordRouteConfig = {
    /** Express path segment, e.g. inventoryItem */
    pathSegment: string;
    /** Log prefix, e.g. InventoryItem */
    logLabel: string;
    listFn: (opts: {
        q?: string;
        limit: number;
        offset: number;
        expandSubResources?: string;
    }) => Promise<any>;
    getFn: (id: string | number, expandSubResources?: string) => Promise<any>;
    fetchAllFn: (opts: {
        q?: string;
        expandSubResources?: string;
        maxRecords?: number;
        pageSize?: number;
    }) => Promise<any[]>;
    hydrateFromListRows: (listItems: any[], expandSubResources?: string) => Promise<any[]>;
    extractIdFromListItem: (item: any) => string | null;
    persistItems: PersistFn;
    fetchAllDefaultMax: number;
    fetchAllAbsMax: number;
    listDefaultLimit: number;
    listAbsMax: number;
};

function registerRestRecordRoutes(cfg: RestRecordRouteConfig) {
    const listPath = `/${cfg.pathSegment}`;
    const getPath = `/${cfg.pathSegment}/:id`;

    router.get(listPath, async (req: any, res: any) => {
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
                const pageSize = Number.isFinite(rawPage) ? Math.min(Math.max(1, rawPage), 1_000) : undefined;

                log.info(
                    `[${cfg.logLabel} List] fetchAll — maxRecords=${maxRecords}` +
                        (pageSize != null ? `, pageSize=${pageSize}` : "")
                );

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
            const wantDetails = restListWantDetails(req.query);

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
                    const listOnly = normalizeRestRecordListItems(data);
                    let rowsForPersist = listOnly;
                    if (persistDb && listOnly.length > 0) {
                        log.info(
                            `[${cfg.logLabel} List] persistDb=true + details=false → per-id GET for Mongo (${listOnly.length} row(s))`
                        );
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
                const listItems = normalizeRestRecordListItems(data);
                if (wantDetails && listItems.length === 0 && data && typeof data === "object") {
                    log.warn(
                        `[${cfg.logLabel} List] details=true but no list rows — keys: ${Object.keys(data).join(", ")}`
                    );
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
                    ids: listItems.map((row: any) => cfg.extractIdFromListItem(row)).filter(Boolean),
                    recordDetailBase,
                    persistDb,
                    persist: enrichPersistResult(persistResult, persistDb, items.length),
                    items,
                });
            }

            const data = await cfg.listFn(listOptions);

            if (!wantDetails) {
                const listOnly = normalizeRestRecordListItems(data);
                let rowsForPersist = listOnly;
                if (persistDb && listOnly.length > 0) {
                    log.info(
                        `[${cfg.logLabel} List] persistDb=true + details=false → per-id GET for Mongo (${listOnly.length} row(s))`
                    );
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

            const listItems = normalizeRestRecordListItems(data);
            if (wantDetails && listItems.length === 0 && data && typeof data === "object") {
                log.warn(
                    `[${cfg.logLabel} List] details=true but no list rows — keys: ${Object.keys(data).join(", ")}`
                );
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
                ids: listItems.map((row: any) => cfg.extractIdFromListItem(row)).filter(Boolean),
                recordDetailBase,
                persistDb,
                persist: enrichPersistResult(persistResult, persistDb, items.length),
                items,
            });
        } catch (e: any) {
            log.error(`[${cfg.logLabel} List] Error:`, e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.get(getPath, async (req: any, res: any) => {
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
        } catch (e: any) {
            log.error(`[${cfg.logLabel} Get] ${id} Error:`, e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });
}

registerRestRecordRoutes({
    pathSegment: "inventoryItem",
    logLabel: "InventoryItem",
    listFn: listInventoryItems,
    getFn: getInventoryItem,
    fetchAllFn: fetchAllInventoryItems,
    hydrateFromListRows: hydrateInventoryItemsFromListRows,
    extractIdFromListItem: extractInventoryItemIdFromListItem,
    persistItems: persistRestInventoryItemRows,
    fetchAllDefaultMax: INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: INVENTORY_ITEM_FETCH_ALL_ABS_MAX,
    listDefaultLimit: INVENTORY_ITEM_LIST_DEFAULT_LIMIT,
    listAbsMax: INVENTORY_ITEM_LIST_ABS_MAX,
});

registerRestRecordRoutes({
    pathSegment: "classification",
    logLabel: "Classification",
    listFn: listClassifications,
    getFn: getClassification,
    fetchAllFn: fetchAllClassifications,
    hydrateFromListRows: hydrateClassificationsFromListRows,
    extractIdFromListItem: extractClassificationIdFromListItem,
    persistItems: persistRestClassificationRows,
    fetchAllDefaultMax: CLASSIFICATION_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: CLASSIFICATION_FETCH_ALL_ABS_MAX,
    listDefaultLimit: CLASSIFICATION_LIST_DEFAULT_LIMIT,
    listAbsMax: CLASSIFICATION_LIST_ABS_MAX,
});

registerRestRecordRoutes({
    pathSegment: "itemFulfillment",
    logLabel: "ItemFulfillment",
    listFn: listItemFulfillments,
    getFn: getItemFulfillment,
    fetchAllFn: fetchAllItemFulfillments,
    hydrateFromListRows: hydrateItemFulfillmentsFromListRows,
    extractIdFromListItem: extractItemFulfillmentIdFromListItem,
    persistItems: persistRestItemFulfillmentRows,
    fetchAllDefaultMax: ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX,
    listDefaultLimit: ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT,
    listAbsMax: ITEM_FULFILLMENT_LIST_ABS_MAX,
});

registerRestRecordRoutes({
    pathSegment: "itemReceipt",
    logLabel: "ItemReceipt",
    listFn: listItemReceipts,
    getFn: getItemReceipt,
    fetchAllFn: fetchAllItemReceipts,
    hydrateFromListRows: hydrateItemReceiptsFromListRows,
    extractIdFromListItem: extractItemReceiptIdFromListItem,
    persistItems: persistRestItemReceiptRows,
    fetchAllDefaultMax: ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX,
    fetchAllAbsMax: ITEM_RECEIPT_FETCH_ALL_ABS_MAX,
    listDefaultLimit: ITEM_RECEIPT_LIST_DEFAULT_LIMIT,
    listAbsMax: ITEM_RECEIPT_LIST_ABS_MAX,
});

export default router;
