import { Router } from "express";
import log from "../config/logger.config";
import { getDb } from "../config/mongdodb.config";
import { stageSalesOrders } from "../services/sales_order.stage";
import { syncSalesOrdersToNetsuite, retryFailedSalesOrders } from "../services/sales_order.sync";
import { migrateSalesOrderSchema, migrateMultiVendorSchema } from "../services/sales_order.migrate";
import { postToNetsuite } from "../services/netsuite.client";
import { listSalesOrders, getSalesOrder, fetchAllSalesOrders } from "../services/netsuite.rest.client";

const router = Router();

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
 *   limit: number (default 1000)
 *   offset: number (default 0)
 *   expandItems: boolean
 *   fetchAll: boolean - If true, fetches ALL pages and gets full record details for each
 */
router.get("/salesOrder", async (req: any, res: any) => {
    const prefer = req.headers.prefer;
    const idempotencyKey = req.headers["x-netsuite-idempotency-key"];
    const fetchAll = req.query.fetchAll === "true";

    try {
        // fetchAll mode: get all pages and full record details
        if (fetchAll) {
            log.info("[SalesOrder List] fetchAll mode enabled - fetching all pages and details");
            const allRecords = await fetchAllSalesOrders({
                q: req.query.q,
                expandSubResources: req.query.expandItems === "true" ? "item" : undefined,
                maxRecords: req.query.maxRecords ? parseInt(req.query.maxRecords, 10) : undefined
            });
            return res.json({
                success: true,
                fetchAll: true,
                count: allRecords.length,
                items: allRecords
            });
        }

        const options = {
            q: req.query.q,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 1000,
            offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
            expandSubResources: req.query.expandItems === "true" ? "item" : undefined
        };

        if (prefer === "respond-async") {
            if (!idempotencyKey) {
                return res.status(400).json({ success: false, error: "X-NetSuite-Idempotency-Key required for async" });
            }
            const data = await listSalesOrders(options);
            return res.status(202).setHeader("Preference-Applied", "respond-async").json({
                success: true,
                async: true,
                idempotencyKey,
                ...data
            });
        }

        const data = await listSalesOrders(options);
        return res.json({ success: true, ...data });
    } catch (e: any) {
        log.error("[SalesOrder List] Error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /salesOrder/:id
 * Get single Sales Order by ID
 */
router.get("/salesOrder/:id", async (req: any, res: any) => {
    const { id } = req.params;
    const expandSubResources = req.query.expandItems === "true" ? "item" : undefined;

    try {
        const data = await getSalesOrder(id, expandSubResources);
        res.json({ success: true, data });
    } catch (e: any) {
        log.error(`[SalesOrder Get] ${id} Error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
