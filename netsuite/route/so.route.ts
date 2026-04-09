import { Router } from "express";
import log from "../config/logger.config";
import { getDb } from "../config/mongdodb.config";
import { stageSalesOrders } from "../services/sales_order.stage";
import {
    syncSalesOrdersToNetsuite,
    syncSingleSalesOrderToNetsuite,
    getAllStagedSalesOrderProducts,
    resetOneStagedSalesOrderForResync,
    retryFailedSalesOrders,
} from "../services/sales_order.sync";
import { migrateSalesOrderSchema, migrateMultiVendorSchema } from "../services/sales_order.migrate";
import { persistRestSalesOrderItems } from "../services/sales_order.rest_dump";
import { postToNetsuite } from "../services/netsuite.client";
import {
    listSalesOrders,
    getSalesOrder,
    fetchAllSalesOrders,
    hydrateSalesOrdersFromListRows,
    extractSalesOrderIdFromListItem,
    normalizeSalesOrderListItems,
    restListWantDetails,
    SALES_ORDER_FETCH_ALL_DEFAULT_MAX,
    SALES_ORDER_FETCH_ALL_ABS_MAX,
    SALES_ORDER_LIST_DEFAULT_LIMIT,
    SALES_ORDER_LIST_ABS_MAX,
} from "../services/netsuite.rest.client";

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

// ─── Direct RESTlet call ────────────────────────────────────────────────────
router.post("/so-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuite(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Test SO Flow — hardcoded dropship-flagged items ────────────────────────
router.get("/test-so-flow", async (_req: any, res: any) => {
    try {
        const testId = "TEST-SO-" + Date.now();
        const result = await postToNetsuite({
            action:              "skip",
            otherrefnum:         testId,
            trandate:            new Date().toISOString(),
            store_type:          "amazon",
            order_status:        "Unshipped",
            fulfillment_channel: "MFN",
            ship_date:           null,
            items: [
                { item: "29S0100", quantity: 2, amount: 137.62 },
            ],
            po: []
        });
        log.info(`[TEST-SO-FLOW] Created SO otherrefnum=${testId}`);
        res.json({ success: true, testId, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

// ─── Multi-Vendor Test Playground ───────────────────────────────────────────
// GET /test-so-vendor?store=amazon|walmart|newegg|ebay|shopify
// GET /test-so-vendor?store=amazon&action=update&sku=CUSTOM_SKU
const VENDOR_PAYLOADS: Record<string, any> = {
    amazon: {
        store_type: "amazon",
        order_status: "Unshipped",
        fulfillment_channel: "MFN",
        shipping_address: {
            addressee: "", company: "Test Corp", addr1: "", addr2: "",
            city: "Seattle", state: "WA", zip: "98101", country: "US",
        },
    },
    walmart: {
        store_type: "walmart",
        order_status: "Acknowledged",
        fulfillment_channel: "EXPEDITED",
        shipping_address: {
            addressee: "Jane Smith", company: "", addr1: "857 Bridle Ln", addr2: "",
            city: "Webster", state: "NY", zip: "14580", country: "US",
        },
    },
    newegg: {
        store_type: "newegg",
        order_status: "Unshipped",
        fulfillment_channel: "MFN",
        shipping_address: {
            addressee: "John Doe", company: "Newegg Test Co", addr1: "17560 Rowland St", addr2: "Suite 200",
            city: "City of Industry", state: "CA", zip: "91748", country: "US",
        },
    },
    ebay: {
        store_type: "ebay",
        order_status: "Completed",
        fulfillment_channel: "MFN",
        shipping_address: {
            addressee: "Bob Johnson", company: "", addr1: "100 Congress Ave", addr2: "Apt 4B",
            city: "Austin", state: "TX", zip: "78701", country: "US",
        },
    },
    shopify: {
        store_type: "shopify",
        order_status: "Paid",
        fulfillment_channel: "Standard",
        shipping_address: {
            addressee: "Alice Williams", company: "Shopify Test LLC", addr1: "150 Elgin St", addr2: "",
            city: "Ottawa", state: "ON", zip: "K2P 1L4", country: "CA",
        },
    },
};

router.get("/test-so-vendor", async (req: any, res: any) => {
    const store = (req.query.store || "").toLowerCase();
    const action = req.query.action || "skip";
    const skuOverride = req.query.sku || null;

    if (!store) {
        return res.json({
            usage: "GET /test-so-vendor?store=<store_type>&action=skip|update&sku=OPTIONAL_SKU",
            available_stores: Object.keys(VENDOR_PAYLOADS),
            notes: [
                "action=skip (default) creates new, skips if exists",
                "action=update creates or updates existing",
                "sku overrides the default test item SKU (29S0100)",
            ],
        });
    }

    const vendorConfig = VENDOR_PAYLOADS[store];
    if (!vendorConfig) {
        return res.status(400).json({
            error: `Unknown store_type: "${store}"`,
            available_stores: Object.keys(VENDOR_PAYLOADS),
        });
    }

    const testId = `TEST-${store.toUpperCase()}-${Date.now()}`;
    const payload = {
        action,
        otherrefnum: testId,
        trandate: new Date().toISOString(),
        ship_date: null,
        items: [{ item: skuOverride || "29S0100", quantity: 1, amount: 99.99 }],
        po: [],
        ...vendorConfig,
    };

    try {
        log.info(`[TEST-SO-VENDOR] Testing store_type="${store}" → otherrefnum=${testId}`);
        const result = await postToNetsuite(payload);
        log.info(`[TEST-SO-VENDOR] Result for ${store}: ${result.action || "error"}`);
        res.json({ success: true, store, testId, payload_sent: payload, netsuite_result: result });
    } catch (e: any) {
        const errData = e?.response?.data || e.message;
        log.error(`[TEST-SO-VENDOR] Error for ${store}:`, errData);
        res.status(500).json({ success: false, store, testId, payload_sent: payload, error: errData });
    }
});

// ─── Stage ──────────────────────────────────────────────────────────────────
router.get("/stage-so", async (_req: any, res: any) => {
    try {
        const result = await stageSalesOrders();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Sync ───────────────────────────────────────────────────────────────────
router.get("/sync-so", async (_req: any, res: any) => {
    try {
        const results = await syncSalesOrdersToNetsuite();
        res.json({ success: true, count: results.length, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get("/staged-so-products", async (req: any, res: any) => {
    try {
        const all = req.query.all === "1" || req.query.all === "true";
        const limit = req.query.limit != null ? parseInt(req.query.limit, 10) : undefined;
        const skip = req.query.skip != null ? parseInt(req.query.skip, 10) : undefined;
        const data = await getAllStagedSalesOrderProducts({ limit, skip, all });
        res.json({ success: true, ...data });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// One sync-so iteration: POST full staged doc (from GET /staged-so-products) as JSON, or { otherrefnum, order_source? } to load DB row
router.post("/sync-so-one", async (req: any, res: any) => {
    try {
        const out = await syncSingleSalesOrderToNetsuite(req.body || {});
        const badRequest =
            out.error === "Body must include otherrefnum" ||
            (Array.isArray((out as any).candidates) && (out as any).candidates.length > 0);
        if (badRequest) {
            return res.status(400).json({ success: false, ...out });
        }
        res.json({ success: out.success !== false, ...out });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Reset one staged SO for retry (clears ns_failed, ns_error, ns_retry_count, etc.)
router.post("/reset-one-so", async (req: any, res: any) => {
    try {
        const out = await resetOneStagedSalesOrderForResync(req.body || {});
        const badRequest =
            out.error === "Body must include otherrefnum" ||
            (Array.isArray(out.candidates) && out.candidates.length > 0);
        // `out` already includes `success` — avoid `{ success, ...out }` (duplicate key + lint error).
        if (!out.success && badRequest) {
            return res.status(400).json(out);
        }
        if (!out.success) {
            return res.status(404).json(out);
        }
        res.json(out);
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Retry failed ───────────────────────────────────────────────────────────
router.get("/retry-failed-so", async (req: any, res: any) => {
    try {
        const resetAll = req.query.all === "1" || req.query.all === "true";
        const result = await retryFailedSalesOrders(resetAll);
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Migrate ────────────────────────────────────────────────────────────────
router.get("/migrate-so", async (_req: any, res: any) => {
    try {
        const result = await migrateSalesOrderSchema();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get("/migrate-so-multivendor", async (_req: any, res: any) => {
    try {
        const result = await migrateMultiVendorSchema();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Reset sync flags ──────────────────────────────────────────────────────
router.get("/reset-so-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const count = await col.countDocuments({
            $or: [
                { ns_synced: true },
                { ns_failed: true },
                { ns_error: { $exists: true } },
                { ns_retry_count: { $exists: true } },
            ]
        });
        res.json({ success: true, action: "dry_run", orders_with_sync_flags: count });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/reset-so-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const result = await col.updateMany(
            {},
            {
                $set: { ns_synced: false },
                $unset: {
                    ns_synced_at: "", ns_result: "", ns_error: "",
                    ns_error_at: "", ns_retry_count: "", ns_failed: "",
                }
            }
        );
        log.info(`[RESET-SO-SYNC] Reset ${result.modifiedCount} orders`);
        res.json({ success: true, action: "reset", matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e: any) {
        log.error("[RESET-SO-SYNC] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Reset only orders that failed with ns_result: "no_items"
// GET  /reset-no-items  → dry-run (count only)ƒrese
// POST /reset-no-items  → actually reset
router.get("/reset-no-items", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const count = await col.countDocuments({ ns_result: "no_items" });
        res.json({ success: true, action: "dry_run", no_items_count: count });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/reset-no-items", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const result = await col.updateMany(
            { ns_result: "no_items" },
            {
                $unset: { ns_synced: "", ns_synced_at: "", ns_result: "" }
            }
        );
        log.info(`[RESET-NO-ITEMS] Reset ${result.modifiedCount} orders`);
        res.json({ success: true, action: "reset", matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e: any) {
        log.error("[RESET-NO-ITEMS] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});


// ─── Reset orders that failed with known RESTlet errors (channel / line-item) ─
// These were failing because of bugs now fixed in the RESTlet.
// GET  /reset-errored-so  → dry-run (shows count + sample errors)
// POST /reset-errored-so  → clears ns_error, ns_failed, ns_retry_count so they retry
const RETRIABLE_ERROR_PATTERNS = [
    "Channels/Lead Source",
    "valid line item",
    "VALID_LINE_ITEM_REQD",
    "USER_ERROR",
];
router.get("/reset-errored-so", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        // Find orders with any of the known retriable error patterns
        const orFilter = RETRIABLE_ERROR_PATTERNS.map(p => ({ ns_error: { $regex: p, $options: "i" } }));
        const count = await col.countDocuments({ $or: orFilter });
        const samples = await col.find({ $or: orFilter }, {
            projection: { otherrefnum: 1, ns_error: 1, ns_retry_count: 1, order_source: 1, store_type: 1 }
        }).limit(10).toArray();
        res.json({
            success: true, action: "dry_run",
            retriable_count: count,
            error_patterns: RETRIABLE_ERROR_PATTERNS,
            sample_orders: samples,
            hint: "POST /api/v4/reset-errored-so to reset these for retry"
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/reset-errored-so", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const orFilter = RETRIABLE_ERROR_PATTERNS.map(p => ({ ns_error: { $regex: p, $options: "i" } }));
        const result = await col.updateMany(
            { $or: orFilter },
            {
                $set:  { ns_synced: false },
                $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
            }
        );
        log.info(`[RESET-ERRORED-SO] Reset ${result.modifiedCount} errored orders for retry`);
        res.json({
            success: true, action: "reset",
            matched: result.matchedCount,
            modified: result.modifiedCount,
            message: `${result.modifiedCount} orders reset — they will retry on the next sync cycle`
        });
    } catch (e: any) {
        log.error("[RESET-ERRORED-SO] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});


// Re-stage Walmart orders with corrupt trandate (year > 2030 or ns_failed)
// GET  /restage-walmart  → dry-run (count only)
// POST /restage-walmart  → delete from suite_sales_order so staging re-inserts them
router.get("/restage-walmart", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const failed = await col.countDocuments({ order_source: "walmart", ns_failed: true });
        const corruptDate = await col.countDocuments({
            order_source: "walmart",
            trandate: { $gt: new Date("2030-01-01") }
        });
        const total = await col.countDocuments({ order_source: "walmart" });
        res.json({ success: true, action: "dry_run", walmart_total: total, failed, corrupt_trandate: corruptDate });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/restage-walmart", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_sales_order");
        const result = await col.deleteMany({
            order_source: "walmart",
            $or: [
                { ns_failed: true },
                { trandate: { $gt: new Date("2030-01-01") } }
            ]
        });
        log.info(`[RESTAGE-WALMART] Deleted ${result.deletedCount} corrupt/failed Walmart orders for re-staging`);
        res.json({ success: true, action: "deleted_for_restage", deleted: result.deletedCount });
    } catch (e: any) {
        log.error("[RESTAGE-WALMART] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// NETSUITE REST API - SALES ORDERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /salesOrder
 * List Sales Orders from NetSuite via REST API
 *
 * Headers:
 *   Prefer: respond-async
 *   X-NetSuite-Idempotency-Key: string
 *
 * Query:
 *   q: SuiteQL query string
 *   limit: number (default SALES_ORDER_LIST_DEFAULT_LIMIT, max SALES_ORDER_LIST_ABS_MAX)
 *   offset: number (default 0)
 *   expandItems: boolean — passed to each per-id GET when details=true
 *   details: boolean (default true) — after list, GET /record/v1/salesOrder/{id} for each row; false = raw list only
 *   fetchAll: boolean — paged list + detail GETs per order (not unbounded)
 *   maxRecords: with fetchAll, max sales orders (default SALES_ORDER_FETCH_ALL_DEFAULT_MAX, cap SALES_ORDER_FETCH_ALL_ABS_MAX)
 *   pageSize: with fetchAll, list page size per NetSuite request (1–1000, optional)
 *   persistDb | saveToDb: true — upsert into Mongo `ns_rest_sales_order_detail_dump` (netsuite DB).
 *     Always persists the full per-id GET payload (even when details=false on the HTTP response).
 */
router.get("/salesOrder", async (req: any, res: any) => {
    const prefer = req.headers.prefer;
    const idempotencyKey = req.headers["x-netsuite-idempotency-key"];
    const fetchAll = req.query.fetchAll === "true";
    const persistDb = parsePersistDbFlag(req);

    try {
        // fetchAll: capped batch of full records (parallel detail fetches, shared NS concurrency)
        if (fetchAll) {
            const rawMax = req.query.maxRecords != null ? parseInt(String(req.query.maxRecords), 10) : NaN;
            const maxRecords = Number.isFinite(rawMax)
                ? Math.min(Math.max(1, rawMax), SALES_ORDER_FETCH_ALL_ABS_MAX)
                : SALES_ORDER_FETCH_ALL_DEFAULT_MAX;

            const rawPage = req.query.pageSize != null ? parseInt(String(req.query.pageSize), 10) : NaN;
            const pageSize = Number.isFinite(rawPage) ? Math.min(Math.max(1, rawPage), 1_000) : undefined;

            log.info(
                `[SalesOrder List] fetchAll — maxRecords=${maxRecords}` +
                    (pageSize != null ? `, pageSize=${pageSize}` : "")
            );

            const allRecords = await fetchAllSalesOrders({
                q: req.query.q,
                expandSubResources: req.query.expandItems === "true" ? "item" : undefined,
                maxRecords,
                pageSize,
            });
            const persistResult = await persistRestSalesOrderItems(allRecords, {
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
                persist: persistResult,
                limits: {
                    defaultMax: SALES_ORDER_FETCH_ALL_DEFAULT_MAX,
                    absMax: SALES_ORDER_FETCH_ALL_ABS_MAX,
                },
            });
        }

        const rawListLimit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : NaN;
        const listLimit = Number.isFinite(rawListLimit)
            ? Math.min(Math.max(1, rawListLimit), SALES_ORDER_LIST_ABS_MAX)
            : SALES_ORDER_LIST_DEFAULT_LIMIT;

        const rawOffset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : 0;
        const listOffset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

        const expandOnDetail = req.query.expandItems === "true" ? "item" : undefined;
        const wantDetails = restListWantDetails(req.query);

        const listOptions = {
            q: req.query.q,
            limit: listLimit,
            offset: listOffset,
            // Always load ids from list first; line expansion happens on per-id GET when details=true
            expandSubResources: wantDetails ? undefined : expandOnDetail,
        };

        if (prefer === "respond-async") {
            if (!idempotencyKey) {
                return res.status(400).json({ success: false, error: "X-NetSuite-Idempotency-Key required for async" });
            }
            const data = await listSalesOrders(listOptions);
            if (!wantDetails) {
                const listOnly = normalizeSalesOrderListItems(data);
                let rowsForPersist = listOnly;
                if (persistDb && listOnly.length > 0) {
                    log.info(
                        `[SalesOrder List] persistDb=true + details=false → per-id GET for Mongo (${listOnly.length} row(s))`
                    );
                    rowsForPersist = await hydrateSalesOrdersFromListRows(listOnly, expandOnDetail);
                }
                const persistResult = await persistRestSalesOrderItems(rowsForPersist, {
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
                    persist: persistResult,
                });
            }
            const listItems = normalizeSalesOrderListItems(data);
            if (wantDetails && listItems.length === 0 && data && typeof data === "object") {
                log.warn(
                    `[SalesOrder List] details=true but no list rows — keys: ${Object.keys(data).join(", ")}`
                );
            }
            const items = await hydrateSalesOrdersFromListRows(listItems, expandOnDetail);
            const persistResult = await persistRestSalesOrderItems(items, {
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
                ? `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder`
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
                ids: listItems.map((row: any) => extractSalesOrderIdFromListItem(row)).filter(Boolean),
                recordDetailBase,
                persistDb,
                persist: persistResult,
                items,
            });
        }

        const data = await listSalesOrders(listOptions);

        if (!wantDetails) {
            const listOnly = normalizeSalesOrderListItems(data);
            let rowsForPersist = listOnly;
            if (persistDb && listOnly.length > 0) {
                log.info(
                    `[SalesOrder List] persistDb=true + details=false → per-id GET for Mongo (${listOnly.length} row(s))`
                );
                rowsForPersist = await hydrateSalesOrdersFromListRows(listOnly, expandOnDetail);
            }
            const persistResult = await persistRestSalesOrderItems(rowsForPersist, {
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
                persist: persistResult,
            });
        }

        const listItems = normalizeSalesOrderListItems(data);
        if (wantDetails && listItems.length === 0 && data && typeof data === "object") {
            log.warn(
                `[SalesOrder List] details=true but no list rows — keys: ${Object.keys(data).join(", ")}`
            );
        }
        const items = await hydrateSalesOrdersFromListRows(listItems, expandOnDetail);
        const persistResult = await persistRestSalesOrderItems(items, {
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
            ? `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/record/v1/salesOrder`
            : null;

        return res.json({
            success: true,
            details: true,
            limit: listLimit,
            offset: listOffset,
            hasMore: data.hasMore,
            totalResults: data.totalResults,
            count: items.length,
            ids: listItems.map((row: any) => extractSalesOrderIdFromListItem(row)).filter(Boolean),
            recordDetailBase,
            persistDb,
            persist: persistResult,
            items,
        });
    } catch (e: any) {
        log.error("[SalesOrder List] Error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /salesOrder/:id
 * Get single Sales Order by ID
 * Query: persistDb | saveToDb — upsert this record into `ns_rest_sales_order_detail_dump`
 */
router.get("/salesOrder/:id", async (req: any, res: any) => {
    const { id } = req.params;
    const expandSubResources = req.query.expandItems === "true" ? "item" : undefined;
    const persistDb = parsePersistDbFlag(req);

    try {
        const data = await getSalesOrder(id, expandSubResources);
        if (persistDb) {
            const persistResult = await persistRestSalesOrderItems([data], {
                save: true,
                queryContext: {
                    mode: "single_record_get",
                    id: String(id),
                    dbPayloadSource: "per_id_get",
                },
            });
            return res.json({ success: true, data, persistDb, persist: persistResult });
        }
        res.json({ success: true, data });
    } catch (e: any) {
        log.error(`[SalesOrder Get] ${id} Error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
