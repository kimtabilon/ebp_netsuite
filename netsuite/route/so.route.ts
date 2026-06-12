import { Router } from "express";
import axios from "axios";
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
import { persistRestSalesOrderItems, NS_REST_SO_DUMP_COLLECTION } from "../services/sales_order.rest_dump";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    runNsRestCompareBaselineBatch,
    parseCompareOrderSource,
    shouldRunBaselineCompareWithPersist,
} from "../services/ns_rest_compare.service";
import { postToNetsuite } from "../services/netsuite.client";
import {
    listSalesOrders,
    getSalesOrder,
    fetchAllSalesOrders,
    hydrateSalesOrdersFromListRows,
    extractSalesOrderIdFromListItem,
    normalizeSalesOrderListItems,
    restListWantDetails,
    nsRestFetchUntilExhaustedCap,
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
    "RCRD_HAS_BEEN_CHANGED",
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
 *   untilExhausted: with fetchAll, true — page until NetSuite ends (cap NS_REST_FETCH_UNTIL_EXHAUSTED_CAP)
 *   maxRecords: with fetchAll (ignored when untilExhausted), default/cap as above
 *   pageSize: with fetchAll, list page size per NetSuite request (1–1000, optional)
 *   persistDb | saveToDb: true — upsert into Mongo `ns_rest_sales_order_detail_dump` (netsuite DB).
 *     Always persists the full per-id GET payload (even when details=false on the HTTP response).
 *   compare: true — diff vs `suite_sales_order`; with persistDb=true compare runs by default (opt out: compare=false).
 */
router.get("/salesOrder", async (req: any, res: any) => {
    const prefer = req.headers.prefer;
    const idempotencyKey = req.headers["x-netsuite-idempotency-key"];
    const fetchAll = req.query.fetchAll === "true";
    const persistDb = parsePersistDbFlag(req);
    const compare = shouldRunBaselineCompareWithPersist(req, persistDb);

    try {
        // fetchAll: capped batch of full records (parallel detail fetches, shared NS concurrency)
        if (fetchAll) {
     
         
            let checkpoint = { lastOffset: 0, lastId: null, updatedAt: null };
      

                        const untilExhausted = req.query.untilExhausted === "true";
                        const rawMax = req.query.maxRecords != null ? parseInt(String(req.query.maxRecords), 10) : NaN;
                        const maxRecords = untilExhausted
                                ? nsRestFetchUntilExhaustedCap()
                                : Number.isFinite(rawMax)
                                    ? Math.min(Math.max(1, rawMax), SALES_ORDER_FETCH_ALL_ABS_MAX)
                                    : SALES_ORDER_FETCH_ALL_DEFAULT_MAX;

                        const rawPage = req.query.pageSize != null ? parseInt(String(req.query.pageSize), 10) : NaN;
                        const pageSize = Number.isFinite(rawPage) ? Math.min(Math.max(1, rawPage), 1_000) : undefined;

                        // Use checkpoint offset if not explicitly overridden
                        let startOffset = checkpoint.lastOffset || 0;
                        if (req.query.offset != null) {
                                const userOffset = parseInt(String(req.query.offset), 10);
                                if (Number.isFinite(userOffset) && userOffset >= 0) startOffset = userOffset;
                        }

            log.info(
                `[SalesOrder List] fetchAll — maxRecords=${maxRecords}` +
                    (untilExhausted ? ", untilExhausted=true" : "") +
                    (pageSize != null ? `, pageSize=${pageSize}` : "")
            );

            // Fetch and persist each record one by one to avoid data loss
            let totalFetched = 0;
            let totalPersisted = 0;
            let persistErrors = [];
            let failedSOs = [];
            let allRecords = [];
            try {
                const fetchIterator = await fetchAllSalesOrders({
                    q: req.query.q,
                    expandSubResources: req.query.expandItems === "true" ? "item" : undefined,
                    maxRecords: untilExhausted ? undefined : maxRecords,
                    pageSize,
                    untilExhausted,
                    offset: startOffset,
                });
                let currentOffset = startOffset;
                for (const so of fetchIterator) {
                    allRecords.push(so);
                    totalFetched++;
                    let persistOk = false;
                    if (persistDb) {
                        try {
                            const result = await persistRestSalesOrderItems([so], {
                                save: true,
                                queryContext: {
                                    mode: "fetchAll_streamed",
                                    maxRecords,
                                    untilExhausted,
                                    pageSize: pageSize ?? null,
                                    q: req.query.q ?? null,
                                    dbPayloadSource: "per_id_get",
                                },
                            });
                            if (result && result.upserted > 0) {
                                totalPersisted++;
                                persistOk = true;
                            } else if (result && result.errors > 0) {
                                persistErrors.push(result);
                                failedSOs.push(so);
                            }
                        } catch (err) {
                            persistErrors.push({ error: err, so });
                            failedSOs.push(so);
                        }
                        // Retry once if failed
                        if (!persistOk) {
                            try {
                                const retryResult = await persistRestSalesOrderItems([so], {
                                    save: true,
                                    queryContext: {
                                        mode: "fetchAll_streamed_retry",
                                        maxRecords,
                                        untilExhausted,
                                        pageSize: pageSize ?? null,
                                        q: req.query.q ?? null,
                                        dbPayloadSource: "per_id_get",
                                        retry: true,
                                    },
                                });
                                if (retryResult && retryResult.upserted > 0) {
                                    totalPersisted++;
                                    persistOk = true;
                                    // Remove from failedSOs if retry succeeded
                                    failedSOs.pop();
                                } else if (retryResult && retryResult.errors > 0) {
                                    persistErrors.push(retryResult);
                                }
                            } catch (retryErr) {
                                persistErrors.push({ error: retryErr, so, retry: true });
                            }
                        }
                        // Update checkpoint after each persist
                        try {
                            currentOffset++;
                        
                        } catch (e) {
                            log.warn("[SO API] Could not write checkpoint file", e);
                        }
                    }
                    if (totalFetched % 100 === 0) {
                        log.info(`[SO API] Fetched and persisted ${totalFetched} records so far...`);
                    }
                }
            } catch (err) {
                log.error(`[SO API] Error during fetchAll streaming:`, err);
            }

            log.info(`[SO API] fetchAll fetched ${totalFetched} records from NetSuite. Persisted: ${totalPersisted}. Errors: ${persistErrors.length}`);
            const compareResult = compare
                ? await runNsRestCompareBaselineBatch({
                      variant: "sales_order_staged",
                      items: allRecords,
                      extractId: extractSalesOrderIdFromListItem,
                      orderSource: parseCompareOrderSource(req),
                      source: {
                          api: "salesOrder",
                          mode: "fetchAll_streamed",
                          untilExhausted,
                          maxRecords,
                          pageSize: pageSize ?? null,
                      },
                  })
                : null;
            return res.json({
                success: true,
                fetchAll: true,
                untilExhausted,
                maxRecords,
                pageSize: pageSize ?? null,
                count: totalFetched,
                items: allRecords,
                persisted: totalPersisted,
                persistErrors: persistErrors.length,
                persistErrorDetails: persistErrors.length > 0 ? persistErrors.slice(0, 5) : undefined,
                failedSOs,
                persistDb,
                compare,
                compareResult,
                limits: untilExhausted
                    ? {
                          untilExhaustedCap: nsRestFetchUntilExhaustedCap(),
                          note: "Pages until NetSuite ends the list or cap is hit (env NS_REST_FETCH_UNTIL_EXHAUSTED_CAP).",
                      }
                    : {
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
                if ((persistDb || compare) && listOnly.length > 0) {
                    log.info(
                        `[SalesOrder List] persistDb/compare + details=false → per-id GET (${listOnly.length} row(s))`
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
                const compareResult = compare
                    ? await runNsRestCompareBaselineBatch({
                          variant: "sales_order_staged",
                          items: rowsForPersist,
                          extractId: extractSalesOrderIdFromListItem,
                          orderSource: parseCompareOrderSource(req),
                          source: { api: "salesOrder", mode: "list_only_async", limit: listLimit, offset: listOffset },
                      })
                    : null;
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
                    compare,
                    compareResult,
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
            const compareResult = compare
                ? await runNsRestCompareBaselineBatch({
                      variant: "sales_order_staged",
                      items,
                      extractId: extractSalesOrderIdFromListItem,
                      orderSource: parseCompareOrderSource(req),
                      source: { api: "salesOrder", mode: "list_details_async", limit: listLimit, offset: listOffset },
                  })
                : null;
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
                compare,
                compareResult,
                items,
            });
        }

        const data = await listSalesOrders(listOptions);

        if (!wantDetails) {
            const listOnly = normalizeSalesOrderListItems(data);
            let rowsForPersist = listOnly;
            if ((persistDb || compare) && listOnly.length > 0) {
                log.info(
                    `[SalesOrder List] persistDb/compare + details=false → per-id GET (${listOnly.length} row(s))`
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
            const compareResult = compare
                ? await runNsRestCompareBaselineBatch({
                      variant: "sales_order_staged",
                      items: rowsForPersist,
                      extractId: extractSalesOrderIdFromListItem,
                      orderSource: parseCompareOrderSource(req),
                      source: { api: "salesOrder", mode: "list_only", limit: listLimit, offset: listOffset },
                  })
                : null;
            return res.json({
                success: true,
                details: false,
                ...data,
                limit: listLimit,
                offset: listOffset,
                persistDb,
                persist: persistResult,
                compare,
                compareResult,
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
        const compareResult = compare
            ? await runNsRestCompareBaselineBatch({
                  variant: "sales_order_staged",
                  items,
                  extractId: extractSalesOrderIdFromListItem,
                  orderSource: parseCompareOrderSource(req),
                  source: { api: "salesOrder", mode: "list_details", limit: listLimit, offset: listOffset },
              })
            : null;
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
            compare,
            compareResult,
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
 *         compare — baseline diff (with persistDb=true runs by default unless compare=false); compareOrderSource for otherrefnum
 */
router.get("/salesOrder/:id", async (req: any, res: any) => {
    const { id } = req.params;
    const expandSubResources = req.query.expandItems === "true" ? "item" : undefined;
    const persistDb = parsePersistDbFlag(req);
    const compare = shouldRunBaselineCompareWithPersist(req, persistDb);

    try {
        const data = await getSalesOrder(id, expandSubResources);
        const compareResult = compare
            ? await runNsRestCompareBaselineBatch({
                  variant: "sales_order_staged",
                  items: [data],
                  extractId: extractSalesOrderIdFromListItem,
                  orderSource: parseCompareOrderSource(req),
                  source: { api: "salesOrder", mode: "single_record_get", id: String(id) },
              })
            : null;
        if (persistDb) {
            const persistResult = await persistRestSalesOrderItems([data], {
                save: true,
                queryContext: {
                    mode: "single_record_get",
                    id: String(id),
                    dbPayloadSource: "per_id_get",
                },
            });
            return res.json({ success: true, data, persistDb, persist: persistResult, compare, compareResult });
        }
        res.json({ success: true, data, compare, compareResult });
    } catch (e: any) {
        log.error(`[SalesOrder Get] ${id} Error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});


// ─── Sales Order Full Dump — Parallel Workers ────────────────────────────────
//
// GET /sales-order-dummy-dump           → dump ALL SOs (3 workers × ~5000 each)
// GET /sales-order-dummy-dump?test=true → test run only (1 batch × 10 records)
//
// Each worker calls GET /salesOrder with fetchAll+persistDb, starting at a
// different offset so the three workers cover the full ~14k+ dataset in parallel.
//
// Response is returned immediately (202 Accepted) — processing continues async.
// Check ns_rest_sales_order_detail_dump_dummy in MongoDB for results.
// Monitor server logs for [SO-DUMP-WORKER] progress.
//
// Optional query params:
//   test=true           → 1 batch of 10 records only (for verification)
//   batchSize=<n>       → records per worker (default 5000)
//   batchCount=<n>      → number of parallel workers (default 3)
//   pageSize=<n>        → NS list page size per internal request (default 1000)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sales-order-dummy-dump", async (req: any, res: any) => {
    const isTest    = req.query.test === "true";
    const batchSize  = isTest ? 10 : (parseInt(String(req.query.batchSize  ?? "5000"), 10) || 5000);
    const batchCount = isTest ?  1 : (parseInt(String(req.query.batchCount ?? "3"),    10) || 3);
    const pageSize   = isTest ? 10 : (parseInt(String(req.query.pageSize   ?? "1000"), 10) || 1000);

    const BASE_URL = `http://localhost:${process.env.PORT ?? 5002}/api/v4/salesOrder`;

    const mode = isTest ? `TEST (1 batch × 10)` : `FULL (${batchCount} workers × ${batchSize} each)`;
    log.info(`[SO-DUMP] Starting ${mode} dump → ${NS_REST_SO_DUMP_COLLECTION}`);

    // Build one axios task per worker, each starting at a different offset
    const tasks = Array.from({ length: batchCount }).map((_, i) => {
        const offset = i * batchSize;
        log.info(`[SO-DUMP-WORKER] Worker ${i + 1}/${batchCount}: offset=${offset}, maxRecords=${batchSize}, pageSize=${pageSize}`);
        return axios
            .get(BASE_URL, {
                params: {
                    fetchAll:   true,
                    maxRecords: batchSize,
                    offset:     offset,
                    persistDb:  true,
                    pageSize:   pageSize,
                    // expandItems intentionally omitted — hydrateSalesOrderFollowLinkSubresources
                    // already follows item sublist links; passing expandItems causes NetSuite
                    // to inline everything in one GET which fails on large SOs.
                },
                // These dumps can take many minutes for large batches
                timeout:          90 * 60 * 1000, // 90 min
                maxContentLength: Infinity,
                maxBodyLength:    Infinity,
            })
            .then((r) => ({ worker: i + 1, offset, status: r.status, count: r.data?.count ?? 0, persisted: r.data?.persisted ?? 0 }))
            .catch((err) => {
                const detail = err?.response?.data || err.message;
                log.error(`[SO-DUMP-WORKER] Worker ${i + 1} (offset ${offset}) failed:`, detail);
                return { worker: i + 1, offset, status: err?.response?.status ?? 0, error: detail, count: 0, persisted: 0 };
            });
    });

    // Return 202 immediately so the HTTP connection doesn't time out on large runs.
    // Workers continue running in the background.
    res.status(202).json({
        success: true,
        mode,
        batchCount,
        batchSize,
        pageSize,
        collection: NS_REST_SO_DUMP_COLLECTION,
        message: `${batchCount} worker(s) dispatched. Processing async — monitor logs for [SO-DUMP-WORKER] progress.`,
    });

    // Await workers in the background (after response is sent)
    try {
        const results = await Promise.all(tasks);
        const totalFetched   = results.reduce((s, r) => s + r.count,     0);
        const totalPersisted = results.reduce((s, r) => s + r.persisted,  0);
        const errors         = results.filter((r:any) => r.error);
        log.info(
            `[SO-DUMP] All workers done — fetched=${totalFetched}, persisted=${totalPersisted}, errors=${errors.length}`,
            results
        );
        if (errors.length) {
            log.warn(`[SO-DUMP] ${errors.length} worker(s) had errors:`, errors);
        }
    } catch (err: any) {
        log.error(`[SO-DUMP] Unexpected error waiting for workers:`, err?.message || err);
    }
});

export default router;
