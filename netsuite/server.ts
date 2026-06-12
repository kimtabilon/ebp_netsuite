import app from "./app";
import dotenv from "dotenv";
import cron from "node-cron";
import log from "./config/logger.config";
import { getDb } from "./config/mongdodb.config";
import { syncDummySalesOrdersToNetsuite } from "./services/sales_order.sync";
import { stagePurchaseOrders } from "./services/po.stage";
import { syncPurchaseOrdersToNetsuite, } from "./services/po.sync";
import { runFunctionForBills, stageBills, stageCreditBillsDummy } from "./services/bill.stage";
import { syncBillsToNetsuite, retryFailedBills, syncStagedDummyBillsOnce, } from "./services/bill.sync";
import { runItemFullSync } from "./controller/netsuite_item_full";
import { drainQueue } from "./config/concurrency.config";

// Route modules
import soRoutes from "./route/so.route";
import poRoutes from "./route/po.route";
import diagnosticRoutes from "./route/diagnostic.route";
import billRoutes from "./route/bill.route";
import itemRoutes from "./route/item.route";
import nsRestRecordRoutes from "./route/ns_rest_records.route";
import indexRoutes from "./route/index.route";
import creditMemoRoutes from "./route/credit_memo.route";
import itemFulfillmentRoutes from "./route/item_fulfillment.route";
import { stageSalesOrders, } from "./services/sales_order.stage";
import { NS_REST_COMPARE_LOG_COLLECTION } from "./config/ns_rest_compare.fields";
import { createMongoWatcher } from "./services/mongo_watcher.service";


import { getWare2SoOrderOutbound } from "./services/warehouse.w2g"
import { syncAllWare2GoInboundShipments } from "./services/inbound.w2g"
dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.send('NetSuite Integration Server is running');
})
app.use("/api/v4", soRoutes);
app.use("/api/v4", poRoutes);
app.use("/api/v4", billRoutes);
app.use("/api/v4", diagnosticRoutes);
app.use("/api/v4", itemRoutes);
app.use("/api/v4", nsRestRecordRoutes);
app.use("/api/v4", indexRoutes);
app.use("/api/v4", creditMemoRoutes);
app.use("/api/v4", itemFulfillmentRoutes);

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = 5002;
const server = app.listen(PORT, async () => {
    log.info(`Server running at http://localhost:${PORT}`);
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

    const nsRestSoDump = nsDb.collection("ns_rest_sales_order_detail_dump");
    await nsRestSoDump.createIndex(
        { ns_internal_id: 1 },
        { unique: true, name: "idx_ns_rest_so_dump_internal_id", background: true }
    );
    await nsRestSoDump.createIndex(
        { dumped_at: -1 },
        { name: "idx_ns_rest_so_dump_dumped_at", background: true }
    );

    const nsRestPoDump = nsDb.collection("ns_rest_purchase_order_detail_dump");
    await nsRestPoDump.createIndex(
        { ns_internal_id: 1 },
        { unique: true, name: "idx_ns_rest_po_dump_internal_id", background: true }
    );
    await nsRestPoDump.createIndex(
        { dumped_at: -1 },
        { name: "idx_ns_rest_po_dump_dumped_at", background: true }
    );

    const restDumpSpecs: { name: string; coll: string }[] = [
        { name: "inv_item", coll: "ns_rest_inventory_item_detail_dump" },
        { name: "classification", coll: "ns_rest_classification_detail_dump" },
        { name: "item_fulfillment", coll: "ns_rest_item_fulfillment_detail_dump" },
        { name: "item_receipt", coll: "ns_rest_item_receipt_detail_dump" },
    ];
    for (const { name, coll } of restDumpSpecs) {
        const c = nsDb.collection(coll);
        await c.createIndex(
            { ns_internal_id: 1 },
            { unique: true, name: `idx_ns_rest_${name}_dump_internal_id`, background: true }
        );
        await c.createIndex(
            { dumped_at: -1 },
            { name: `idx_ns_rest_${name}_dump_dumped_at`, background: true }
        );
    }

    const nsRestCompareLog = nsDb.collection(NS_REST_COMPARE_LOG_COLLECTION);
    await nsRestCompareLog.createIndex(
        { compared_at: -1 },
        { name: "idx_ns_rest_compare_log_compared_at", background: true }
    );
    await nsRestCompareLog.createIndex(
        { record_type: 1, ns_internal_id: 1, compared_at: -1 },
        { name: "idx_ns_rest_compare_log_type_id_time", background: true }
    );

    log.info(
        "[STARTUP] MongoDB indexes ensured for suite_sales_order, suite_purchase_order, NS REST SO/PO dump, inventory/classification/IF/IR dump, compare diff log"
    );
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

// 1. W2G dummp cron jobs 
// Job 1: Runs every 2 hours
cron.schedule('0 */2 * * *', async () => {
    try {
        await getWare2SoOrderOutbound();
    } catch (error: any) {
        log.info(' W2g SO Outbound cron failed : ', error)

    }
    try {
        await syncAllWare2GoInboundShipments();
    } catch (error: any) {
        log.info(' W2g Inbound Shipment cron failed : ', error)

    }
    log.info('Every 2 hours job executed at: ' + new Date().toISOString());
});

// // Job 2: Runs every Saturday at 00:00 (midnight)
cron.schedule('0 0 * * 6', async () => {

    try {
        await getWare2SoOrderOutbound({ forceRestart: false, retryFailedOnly: false, all: true });
    } catch (error: any) {
        log.info('Weekly W2g SO Outbound cron cron failed : ', error)

    }
    try {
        await syncAllWare2GoInboundShipments({ forceRestart: false, retryFailedOnly: false, all: true });
    } catch (error: any) {
        log.info('Weekly W2g Inbound Shipment cron failed : ', error)

    }
    log.info('Weekly Saturday job executed at: ' + new Date().toISOString());
});



// Define a flag outside the cron job
let isSyncJobRunning = false;

cron.schedule('0 */5 * * *', async () => {

    if (isSyncJobRunning) {
        log.info('Previous sync job is still running. Skipping this cron run.');
        return;
    }

    isSyncJobRunning = true;
    log.info('Starting scheduled sync job...');


    try {
        try {
            await stageSalesOrders();
            console.log("SO run")
        } catch (error) {
            console.log(error)
        }
        try {

            await syncDummySalesOrdersToNetsuite();
            console.log("SO sync run")
        } catch (error) {
            console.log(error)
        }
        try {
            await stagePurchaseOrders();
            console.log("PO stage run")
        } catch (error) {
            console.log(error)
        }
        try {
            await syncPurchaseOrdersToNetsuite();
            console.log("PO sync run")
        } catch (error) {
            console.log(error)
        }
        try {
            await stageBills();
            console.log("Bill stage run")
        } catch (error) {
            console.log(error)
        }
        try {

            await syncStagedDummyBillsOnce();
            console.log("Bill Sync run")
        } catch (error) {
            console.log(error)
        }




    } catch (error: any) {
        log.error('Sync cron job failed: ', error);
    } finally {
        isSyncJobRunning = false;
        log.info('Scheduled sync job finished.');
    }
});

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
    // while ((soSyncRunning || poSyncRunning) && Date.now() < deadline) {
    //     log.info(`[SHUTDOWN] Waiting for in-flight syncs... SO=${soSyncRunning}, PO=${poSyncRunning}`);
    //     await new Promise(r => setTimeout(r, 2_000));
    // }

    // if (soSyncRunning || poSyncRunning) {
    //     log.warn("[SHUTDOWN] Timed out waiting for syncs — forcing exit");
    // }

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
