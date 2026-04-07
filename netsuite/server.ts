import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import log from "./config/logger.config";
import { getDb } from "./config/mongdodb.config";
import { retryFailedSalesOrders, syncSalesOrdersToNetsuite } from "./services/sales_order.sync";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite, retryFailedPurchaseOrders } from "./services/po.sync";
import { stageBills } from "./services/bill.stage";
import { syncBillsToNetsuite, retryFailedBills } from "./services/bill.sync";
import { runItemFullSync } from "./controller/netsuite_item_full";
import { drainQueue } from "./config/concurrency.config";

// Route modules
import soRoutes from "./route/so.route";
import poRoutes from "./route/po.route";
import diagnosticRoutes from "./route/diagnostic.route";
import billRoutes from "./route/bill.route";
import itemRoutes from "./route/item.route";
import indexRoutes from "./route/index.route";
import { stageSalesOrders } from "./services/sales_order.stage";

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/' , (req, res) => {
    res.send('NetSuite Integration Server is running');
})
app.use("/api/v4", soRoutes);
app.use("/api/v4", poRoutes);
app.use("/api/v4", billRoutes);
app.use("/api/v4", diagnosticRoutes);
app.use("/api/v4", itemRoutes);
app.use("/api/v4", indexRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = 5002;
const server = app.listen(PORT, () => {
    log.info(`Server running at http://localhost:${PORT}`);
    log.info(`──── Sales Orders ────`);
    log.info(`  Stage SO:        GET  /stage-so`);
    log.info(`  Sync SO:         GET  /sync-so`);
    log.info(`  Retry Failed SO: GET  /retry-failed-so`);
    log.info(`  Reset SO Sync:   GET|POST /reset-so-sync`);
    log.info(`  Migrate SO:      GET  /migrate-so`);
    log.info(`  Migrate MV:      GET  /migrate-so-multivendor`);
    log.info(`  Test SO Flow:    GET  /test-so-flow`);
    log.info(`  Test Vendor SO:  GET  /test-so-vendor?store=amazon|walmart|newegg|ebay|shopify`);
    log.info(`  Direct SO Test:  POST /so-test`);
    log.info(`  Delete All SO:   GET|POST /delete-all-so`);
    log.info(`──── Purchase Orders ────`);
    log.info(`  Sync PO:         GET  /sync-po`);
    log.info(`  Retry Failed PO: GET  /retry-failed-po`);
    log.info(`  Test PO Flow:    POST /test-po-flow?type=dropship|stocking`);
    log.info(`  Direct PO Test:  POST /po-test`);
    log.info(`  Dropship Ready:  GET  /dropship-ready`);
    log.info(`  Delete All PO:   GET|POST /delete-all-po`);
    log.info(`──── Vendor Bills ────`);
    log.info(`  Stage Bills:     GET  /stage-bill`);
    log.info(`  Sync Bills:      GET  /sync-bill`);
    log.info(`  Retry Failed:    GET  /retry-failed-bill`);
    log.info(`  Reset Sync:      GET|POST /reset-bill-sync`);
    log.info(`  Bill Ready:      GET  /bill-ready`);
    log.info(`  Direct Bill:     POST /bill-test`);
    log.info(`──── Cron Schedule ────`);
    log.info(`  SO:   every 20 min  (:00, :20, :40)`);
    log.info(`  PO:   every 20 min  (:07, :27, :47)`);
    log.info(`  Bill: every 20 min  (:14, :34, :54) [DISABLED]`);
    log.info(`  SO retry:   daily 3:00 AM`);
    log.info(`  PO retry:   daily 3:15 AM`);
    log.info(`  Bill retry: daily 3:30 AM [DISABLED]`);
    log.info(`──── Items & Diagnostics ────`);
    log.info(`  Items:           GET  /netsuite-items`);
    log.info(`  Items Full:      GET  /netsuite-items-full`);
    log.info(`  POs:             GET  /netsuite-po`);
    log.info(`  Diagnostic:      GET|POST /diagnostic`);
    log.info(`  Cleanup:         GET|POST /cleanup`);

    // Ensure indexes after server boots (non-blocking)
    ensureIndexes().catch(err => log.error("[STARTUP] Index creation failed", { error: err.message }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// MONGODB INDEXES — created once on startup, idempotent
// ═══════════════════════════════════════════════════════════════════════════════
async function ensureIndexes() {
    const nsDb = await getDb("netsuite");

    // suite_sales_order indexes
    const soCol = nsDb.collection("suite_sales_order");
    await soCol.createIndex(
        { otherrefnum: 1, order_source: 1 },
        { unique: true, name: "idx_so_otherrefnum_source", background: true }
    );
    await soCol.createIndex(
        { ns_synced: 1, ns_failed: 1, ns_result: 1 },
        { name: "idx_so_sync_status", background: true }
    );

    // suite_purchase_order indexes
    const poCol = nsDb.collection("suite_purchase_order");
    await poCol.createIndex(
        { po_number: 1 },
        { unique: true, name: "idx_po_number", background: true }
    );
    await poCol.createIndex(
        { ns_synced: 1, ns_failed: 1, ns_result: 1 },
        { name: "idx_po_sync_status", background: true }
    );
    await poCol.createIndex(
        { po_type: 1, ns_synced: 1, ns_failed: 1, website_order_number: 1 },
        { name: "idx_po_dropship_lookup", background: true }
    );

    log.info("[STARTUP] MongoDB indexes ensured for suite_sales_order and suite_purchase_order");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRON SAFETY — wraps a sync function with a hard timeout so a hung call
// can never block the guard flag forever.
// ═══════════════════════════════════════════════════════════════════════════════
const CRON_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — generous but finite

function withTimeout<T>(fn: () => Promise<T>, label: string, ms = CRON_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`[CRON] ${label} timed out after ${ms / 1000}s`));
        }, ms);

        fn().then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
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
        log.warn("[CRON] [SO] Skipping — previous sync still running");
        return;
    }
    soSyncRunning = true;
    try {
        log.info("[CRON] [SO] Step 1 — Staging sales orders...");
        await withTimeout(() => stageSalesOrders(), "SO-Stage");

        log.info("[CRON] [SO] Step 2 — Pushing to NetSuite ERP...");
        await withTimeout(() => syncSalesOrdersToNetsuite(), "SO-Sync");
    } catch (err: any) {
        log.error("[CRON] [SO] Error", { error: err.message });
    } finally {
        soSyncRunning = false;
    }
}

cron.schedule("0,20,40 * * * *", runSOSync);  // every 20 min at :00, :20, :40

// ─── Every 20 min — Purchase Orders (staging + sync) ──────────────────────
// PO at :07, :27, :47 — 7-min offset from SO to avoid API overlap.
// Governance per PO: Stocking ~42 units, Dropship ~77 units (RESTlet limit 5,000)
// Batches: 50 stocking + 20 dropship per cron run, 5 parallel workers
let poSyncRunning = false;

cron.schedule("7,27,47 * * * *", async () => {
    if (poSyncRunning) {
        log.warn("[CRON] [PO] Skipping — previous sync still running");
        return;
    }
    poSyncRunning = true;
    try {
        log.info("[CRON] [PO] Step 1 — Staging purchase orders...");
        await withTimeout(() => stagePurchaseOrders(), "PO-Stage");

        log.info("[CRON] [PO] Step 2 — Pushing to NetSuite ERP...");
        await withTimeout(() => syncPurchaseOrdersToNetsuite(), "PO-Sync");
    } catch (err: any) {
        log.error("[CRON] [PO] Error", { error: err.message });
    } finally {
        poSyncRunning = false;
    }
});

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
cron.schedule("0 3 * * *", async () => {
    log.info("[CRON] [SO-RETRY] Resetting permanently failed SOs for retry...");
    try {
        const result = await retryFailedSalesOrders(true);
        log.info(`[CRON] [SO-RETRY] Reset ${result.count} failed orders for retry`);
    } catch (err: any) {
        log.error("[CRON] [SO-RETRY] Error", { error: err.message });
    }
});

// ─── Daily 3:15 AM — Auto-retry permanently failed POs ──────────────────────
cron.schedule("15 3 * * *", async () => {
    log.info("[CRON] [PO-RETRY] Resetting permanently failed POs for retry...");
    try {
        const result = await retryFailedPurchaseOrders(true);
        log.info(`[CRON] [PO-RETRY] Reset ${result.count} failed POs for retry`);
    } catch (err: any) {
        log.error("[CRON] [PO-RETRY] Error", { error: err.message });
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

async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[SHUTDOWN] Received ${signal} — shutting down gracefully...`);

    // 1. Stop accepting new HTTP connections
    server.close(() => log.info("[SHUTDOWN] HTTP server closed"));

    // 2. Drain any workers waiting for concurrency slots
    drainQueue();

    // 3. Wait for in-flight sync jobs to finish (up to 30s)
    const deadline = Date.now() + 30_000;
    while ((soSyncRunning || poSyncRunning) && Date.now() < deadline) {
        log.info(`[SHUTDOWN] Waiting for in-flight syncs... SO=${soSyncRunning}, PO=${poSyncRunning}`);
        await new Promise(r => setTimeout(r, 2_000));
    }

    if (soSyncRunning || poSyncRunning) {
        log.warn("[SHUTDOWN] Timed out waiting for syncs — forcing exit");
    }

    log.info("[SHUTDOWN] Done. Bye.");
    process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Catch unhandled rejections so they don't silently kill the process
process.on("unhandledRejection", (reason: any) => {
    log.error("[PROCESS] Unhandled rejection", { error: reason?.message || String(reason) });
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
