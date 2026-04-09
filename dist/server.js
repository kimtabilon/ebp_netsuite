"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const dotenv_1 = __importDefault(require("dotenv"));
const node_cron_1 = __importDefault(require("node-cron"));
const logger_config_1 = __importDefault(require("./config/logger.config"));
const mongdodb_config_1 = require("./config/mongdodb.config");
const sales_order_sync_1 = require("./services/sales_order.sync");
const po_sync_1 = require("./services/po.sync");
const concurrency_config_1 = require("./config/concurrency.config");
// Route modules
const so_route_1 = __importDefault(require("./route/so.route"));
const po_route_1 = __importDefault(require("./route/po.route"));
const diagnostic_route_1 = __importDefault(require("./route/diagnostic.route"));
const bill_route_1 = __importDefault(require("./route/bill.route"));
const item_route_1 = __importDefault(require("./route/item.route"));
const ns_rest_records_route_1 = __importDefault(require("./route/ns_rest_records.route"));
const index_route_1 = __importDefault(require("./route/index.route"));
const sales_order_stage_1 = require("./services/sales_order.stage");
dotenv_1.default.config();
// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app_1.default.get('/', (req, res) => {
    res.send('NetSuite Integration Server is running');
});
app_1.default.use("/api/v4", so_route_1.default);
app_1.default.use("/api/v4", po_route_1.default);
app_1.default.use("/api/v4", bill_route_1.default);
app_1.default.use("/api/v4", diagnostic_route_1.default);
app_1.default.use("/api/v4", item_route_1.default);
app_1.default.use("/api/v4", ns_rest_records_route_1.default);
app_1.default.use("/api/v4", index_route_1.default);
// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = 5002;
const server = app_1.default.listen(PORT, () => {
    logger_config_1.default.info(`Server running at http://localhost:${PORT}`);
    logger_config_1.default.info(`──── Sales Orders ────`);
    logger_config_1.default.info(`  Stage SO:        GET  /stage-so`);
    logger_config_1.default.info(`  Staged products: GET  /staged-so-products?limit=&skip=&all=true`);
    logger_config_1.default.info(`  Sync SO:         GET  /sync-so`);
    logger_config_1.default.info(`  Sync one SO:     POST /sync-so-one`);
    logger_config_1.default.info(`  Reset one SO:    POST /reset-one-so`);
    logger_config_1.default.info(`  Retry Failed SO: GET  /retry-failed-so`);
    logger_config_1.default.info(`  Reset SO Sync:   GET|POST /reset-so-sync`);
    logger_config_1.default.info(`  Migrate SO:      GET  /migrate-so`);
    logger_config_1.default.info(`  Migrate MV:      GET  /migrate-so-multivendor`);
    logger_config_1.default.info(`  Test SO Flow:    GET  /test-so-flow`);
    logger_config_1.default.info(`  Test Vendor SO:  GET  /test-so-vendor?store=amazon|walmart|newegg|ebay|shopify`);
    logger_config_1.default.info(`  Direct SO Test:  POST /so-test`);
    logger_config_1.default.info(`  Delete All SO:   GET|POST /delete-all-so`);
    logger_config_1.default.info(`──── Purchase Orders ────`);
    logger_config_1.default.info(`  Sync PO:         GET  /sync-po`);
    logger_config_1.default.info(`  Retry Failed PO: GET  /retry-failed-po`);
    logger_config_1.default.info(`  Test PO Flow:    POST /test-po-flow?type=dropship|stocking`);
    logger_config_1.default.info(`  Direct PO Test:  POST /po-test`);
    logger_config_1.default.info(`  Dropship Ready:  GET  /dropship-ready`);
    logger_config_1.default.info(`  Delete All PO:   GET|POST /delete-all-po`);
    logger_config_1.default.info(`──── Vendor Bills ────`);
    logger_config_1.default.info(`  Stage Bills:     GET  /stage-bill`);
    logger_config_1.default.info(`  Sync Bills:      GET  /sync-bill`);
    logger_config_1.default.info(`  Retry Failed:    GET  /retry-failed-bill`);
    logger_config_1.default.info(`  Reset Sync:      GET|POST /reset-bill-sync`);
    logger_config_1.default.info(`  Bill Ready:      GET  /bill-ready`);
    logger_config_1.default.info(`  Direct Bill:     POST /bill-test`);
    logger_config_1.default.info(`──── Cron Schedule ────`);
    logger_config_1.default.info(`  SO:   every 20 min  (:00, :20, :40)`);
    logger_config_1.default.info(`  PO:   every 20 min  (:07, :27, :47)`);
    logger_config_1.default.info(`  Bill: every 20 min  (:14, :34, :54) [DISABLED]`);
    logger_config_1.default.info(`  SO retry:   daily 3:00 AM`);
    logger_config_1.default.info(`  PO retry:   daily 3:15 AM`);
    logger_config_1.default.info(`  Bill retry: daily 3:30 AM [DISABLED]`);
    logger_config_1.default.info(`──── Items & Diagnostics ────`);
    logger_config_1.default.info(`  Items:           GET  /netsuite-items`);
    logger_config_1.default.info(`  Items Full:      GET  /netsuite-items-full`);
    logger_config_1.default.info(`  POs:             GET  /netsuite-po`);
    logger_config_1.default.info(`  Diagnostic:      GET|POST /diagnostic`);
    logger_config_1.default.info(`  Cleanup:         GET|POST /cleanup`);
    logger_config_1.default.info(`──── NetSuite REST record dumps (SuiteTalk) — base /api/v4 ────`);
    logger_config_1.default.info(`  Inventory items: GET  /api/v4/inventoryItem?persistDb=true  (+ /api/v4/inventoryItem/:id)`);
    logger_config_1.default.info(`  Class (NS):      GET  /api/v4/classification (+ /api/v4/classification/:id)`);
    logger_config_1.default.info(`  Item fulfill.:   GET  /api/v4/itemFulfillment (+ /api/v4/itemFulfillment/:id)`);
    logger_config_1.default.info(`  Item receipts:   GET  /api/v4/itemReceipt (+ /api/v4/itemReceipt/:id)`);
    // Ensure indexes after server boots (non-blocking)
    ensureIndexes().catch(err => logger_config_1.default.error("[STARTUP] Index creation failed", { error: err.message }));
});
// ═══════════════════════════════════════════════════════════════════════════════
// MONGODB INDEXES — created once on startup, idempotent
// ═══════════════════════════════════════════════════════════════════════════════
async function ensureIndexes() {
    const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
    // suite_sales_order indexes
    const soCol = nsDb.collection("suite_sales_order");
    await soCol.createIndex({ otherrefnum: 1, order_source: 1 }, { unique: true, name: "idx_so_otherrefnum_source", background: true });
    await soCol.createIndex({ ns_synced: 1, ns_failed: 1, ns_result: 1 }, { name: "idx_so_sync_status", background: true });
    // suite_purchase_order indexes
    const poCol = nsDb.collection("suite_purchase_order");
    await poCol.createIndex({ po_number: 1 }, { unique: true, name: "idx_po_number", background: true });
    await poCol.createIndex({ ns_synced: 1, ns_failed: 1, ns_result: 1 }, { name: "idx_po_sync_status", background: true });
    await poCol.createIndex({ po_type: 1, ns_synced: 1, ns_failed: 1, website_order_number: 1 }, { name: "idx_po_dropship_lookup", background: true });
    const nsRestSoDump = nsDb.collection("ns_rest_sales_order_detail_dump");
    await nsRestSoDump.createIndex({ ns_internal_id: 1 }, { unique: true, name: "idx_ns_rest_so_dump_internal_id", background: true });
    await nsRestSoDump.createIndex({ dumped_at: -1 }, { name: "idx_ns_rest_so_dump_dumped_at", background: true });
    const nsRestPoDump = nsDb.collection("ns_rest_purchase_order_detail_dump");
    await nsRestPoDump.createIndex({ ns_internal_id: 1 }, { unique: true, name: "idx_ns_rest_po_dump_internal_id", background: true });
    await nsRestPoDump.createIndex({ dumped_at: -1 }, { name: "idx_ns_rest_po_dump_dumped_at", background: true });
    const restDumpSpecs = [
        { name: "inv_item", coll: "ns_rest_inventory_item_detail_dump" },
        { name: "classification", coll: "ns_rest_classification_detail_dump" },
        { name: "item_fulfillment", coll: "ns_rest_item_fulfillment_detail_dump" },
        { name: "item_receipt", coll: "ns_rest_item_receipt_detail_dump" },
    ];
    for (const { name, coll } of restDumpSpecs) {
        const c = nsDb.collection(coll);
        await c.createIndex({ ns_internal_id: 1 }, { unique: true, name: `idx_ns_rest_${name}_dump_internal_id`, background: true });
        await c.createIndex({ dumped_at: -1 }, { name: `idx_ns_rest_${name}_dump_dumped_at`, background: true });
    }
    logger_config_1.default.info("[STARTUP] MongoDB indexes ensured for suite_sales_order, suite_purchase_order, NS REST SO/PO dump, inventory/classification/IF/IR dump collections");
}
// ═══════════════════════════════════════════════════════════════════════════════
// CRON SAFETY — wraps a sync function with a hard timeout so a hung call
// can never block the guard flag forever.
// ═══════════════════════════════════════════════════════════════════════════════
const CRON_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — generous but finite
function withTimeout(fn, label, ms = CRON_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`[CRON] ${label} timed out after ${ms / 1000}s`));
        }, ms);
        fn().then((val) => { clearTimeout(timer); resolve(val); }, (err) => { clearTimeout(timer); reject(err); });
    });
}
// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════════
// ─── Every 20 min — Sales Orders (staging + sync) ─────────────────────────
// SO at :00, :20, :40 — runs before PO (PO at :07, :27, :47)
let soSyncRunning = false;
async function runSOSync() {
    if (soSyncRunning) {
        logger_config_1.default.warn("[CRON] [SO] Skipping — previous sync still running");
        return;
    }
    soSyncRunning = true;
    try {
        logger_config_1.default.info("[CRON] [SO] Step 1 — Staging sales orders...");
        await withTimeout(() => (0, sales_order_stage_1.stageSalesOrders)(), "SO-Stage");
        logger_config_1.default.info("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
        await withTimeout(() => (0, sales_order_sync_1.syncSalesOrdersToNetsuite)(), "SO-Sync");
    }
    catch (err) {
        logger_config_1.default.error("[CRON] [SO] Error", { error: err.message });
    }
    finally {
        soSyncRunning = false;
    }
}
// cron.schedule("0,20,40 * * * *", runSOSync);  // every 20 min at :00, :20, :40
// ─── Every 20 min — Purchase Orders (staging + sync) ──────────────────────
// PO at :07, :27, :47 — 7-min offset from SO to avoid API overlap.
// Governance per PO: Stocking ~42 units, Dropship ~77 units (RESTlet limit 5,000)
// Batches: 50 stocking + 20 dropship per cron run, 5 parallel workers
let poSyncRunning = false;
// cron.schedule("7,27,47 * * * *", async () => {
//     if (poSyncRunning) {
//         log.warn("[CRON] [PO] Skipping — previous sync still running");
//         return;
//     }
//     poSyncRunning = true;
//     try {
//         log.info("[CRON] [PO] Step 1 — Staging purchase orders...");
//         await withTimeout(() => stagePurchaseOrders(), "PO-Stage");
//         log.info("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
//         await withTimeout(() => syncPurchaseOrdersToNetsuite(), "PO-Sync");
//     } catch (err: any) {
//         log.error("[CRON] [PO] Error", { error: err.message });
//     } finally {
//         poSyncRunning = false;
//     }
// });
// ─── Every 20 min — Bill sync offset from PO ─────────────────────────────
// SO at :00/:30 → PO at :07/:27/:47 → Bill at :14/:34/:54
// 7-min gap between each job. Bills depend on PO being synced first.
let billSyncRunning = false;
// cron.schedule("14,34,54 * * * *", async () => {
//     if (billSyncRunning) {
//         log.warn("[CRON] [BILL] Skipping — previous sync still running");
//         return;
//     }
//     billSyncRunning = true;
//     try {
//         log.info("[CRON] [BILL] Step 1 — Staging bills...");
//         await stageBills();
//         log.info("[CRON] [BILL] Step 2 — Pushing to NetSuite...");
//         await syncBillsToNetsuite();
//     } catch (err: any) {
//         log.error("[CRON] [BILL] Error", { error: err.message });
//     } finally {
//         billSyncRunning = false;
//     }
// });
// ─── Daily 3 AM — Auto-retry permanently failed SOs ─────────────────────────
node_cron_1.default.schedule("0 3 * * *", async () => {
    logger_config_1.default.info("[CRON] [SO-RETRY] Resetting permanently failed SOs for retry...");
    try {
        const result = await (0, sales_order_sync_1.retryFailedSalesOrders)(true);
        logger_config_1.default.info(`[CRON] [SO-RETRY] Reset ${result.count} failed orders for retry`);
    }
    catch (err) {
        logger_config_1.default.error("[CRON] [SO-RETRY] Error", { error: err.message });
    }
});
// ─── Daily 3:15 AM — Auto-retry permanently failed POs ──────────────────────
node_cron_1.default.schedule("15 3 * * *", async () => {
    logger_config_1.default.info("[CRON] [PO-RETRY] Resetting permanently failed POs for retry...");
    try {
        const result = await (0, po_sync_1.retryFailedPurchaseOrders)(true);
        logger_config_1.default.info(`[CRON] [PO-RETRY] Reset ${result.count} failed POs for retry`);
    }
    catch (err) {
        logger_config_1.default.error("[CRON] [PO-RETRY] Error", { error: err.message });
    }
});
// ─── Daily 3:30 AM — Auto-retry permanently failed Bills ────────────────
// cron.schedule("30 3 * * *", async () => {
//     log.info("[CRON] [BILL-RETRY] Resetting permanently failed bills for retry...");
//     try {
//         const result = await retryFailedBills(true);
//         log.info(`[CRON] [BILL-RETRY] Reset ${result.count} failed bills for retry`);
//     } catch (err: any) {
//         log.error("[CRON] [BILL-RETRY] Error", { error: err.message });
//     }
// });
// ─── Every 30 mins — Item Sync (Phase 1 + Phase 2 chained) ──────────────────
// Phase 1: SuiteQL bulk fetch (5 parallel workers, 5000/page → ~12-16s for 96k)
// Phase 2: Sublists — only runs when Phase 1 pulled new/updated items
// Incremental runs are near-instant — safe to run every 30 min.
let itemSyncRunning = false;
// cron.schedule("10,35 * * * *", async () => {
//     if (itemSyncRunning) {
//         log.warn("[CRON] [ITEM] Skipping — previous sync still running");
//         return;
//     }
//     itemSyncRunning = true;
//     try {
//         log.info("[CRON] [ITEM] Syncing items...");
//         const result = await runItemFullSync();
//         log.info(`[CRON] [ITEM] Done. Pulled: ${result.totalPulled}, inserted: ${result.inserted}, updated: ${result.updated}, incremental: ${result.incremental}`);
//     } catch (err: any) {
//         log.error("[CRON] [ITEM] Error", { error: err.message });
//     } finally {
//         itemSyncRunning = false;
//     }
// });
// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    logger_config_1.default.info(`[SHUTDOWN] Received ${signal} — shutting down gracefully...`);
    // 1. Stop accepting new HTTP connections
    server.close(() => logger_config_1.default.info("[SHUTDOWN] HTTP server closed"));
    // 2. Drain any workers waiting for concurrency slots
    (0, concurrency_config_1.drainQueue)();
    // 3. Wait for in-flight sync jobs to finish (up to 30s)
    const deadline = Date.now() + 30000;
    while ((soSyncRunning || poSyncRunning) && Date.now() < deadline) {
        logger_config_1.default.info(`[SHUTDOWN] Waiting for in-flight syncs... SO=${soSyncRunning}, PO=${poSyncRunning}`);
        await new Promise(r => setTimeout(r, 2000));
    }
    if (soSyncRunning || poSyncRunning) {
        logger_config_1.default.warn("[SHUTDOWN] Timed out waiting for syncs — forcing exit");
    }
    logger_config_1.default.info("[SHUTDOWN] Done. Bye.");
    process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Catch unhandled rejections so they don't silently kill the process
process.on("unhandledRejection", (reason) => {
    logger_config_1.default.error("[PROCESS] Unhandled rejection", { error: reason?.message || String(reason) });
});
// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════
// Kick off full item sync if DB is empty or never completed (10s delay for DB connection)
// setTimeout(async () => {
//     try {
//         const nsDb = await getDb("netsuite");
//         const count = await nsDb.collection("netsuite_items_full").countDocuments();
//         const meta = await nsDb.collection("sync_metadata").findOne({ _id: "item_full_sync" } as any);
//         if (count === 0 || !meta?.completedAt) {
//             itemSyncRunning = true;
//             try {
//                 log.info(`[STARTUP] [ITEM] Items in DB: ${count} — running full sync...`);
//                 const result = await runItemFullSync();
//                 log.info(`[STARTUP] [ITEM] Done. Pulled: ${result.totalPulled}, inserted: ${result.inserted}, updated: ${result.updated}`);
//             } finally {
//                 itemSyncRunning = false;
//             }
//         } else {
//             log.info(`[STARTUP] [ITEM] Items in DB: ${count} — skipping (next sync via cron)`);
//         }
//     } catch (err: any) {
//         log.error("[STARTUP] [ITEM] Error", { error: err.message });
//         itemSyncRunning = false;
//     }
// }, 10_000);
