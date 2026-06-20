"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMainSyncJob = exports.runW2gWeekly = exports.runW2gEvery2Hours = void 0;
const app_1 = __importDefault(require("./app"));
const dotenv_1 = __importDefault(require("dotenv"));
const node_cron_1 = __importDefault(require("node-cron"));
const logger_config_1 = __importDefault(require("./config/logger.config"));
const mongdodb_config_1 = require("./config/mongdodb.config");
const sales_order_sync_1 = require("./services/sales_order.sync");
const po_stage_1 = require("./services/po.stage");
const po_sync_1 = require("./services/po.sync");
const bill_stage_1 = require("./services/bill.stage");
const bill_sync_1 = require("./services/bill.sync");
const concurrency_config_1 = require("./config/concurrency.config");
// Route modules
const so_route_1 = __importDefault(require("./route/so.route"));
const po_route_1 = __importDefault(require("./route/po.route"));
const diagnostic_route_1 = __importDefault(require("./route/diagnostic.route"));
const bill_route_1 = __importDefault(require("./route/bill.route"));
const item_route_1 = __importDefault(require("./route/item.route"));
const ns_rest_records_route_1 = __importDefault(require("./route/ns_rest_records.route"));
const index_route_1 = __importDefault(require("./route/index.route"));
const credit_memo_route_1 = __importDefault(require("./route/credit_memo.route"));
const item_fulfillment_route_1 = __importDefault(require("./route/item_fulfillment.route"));
const sales_order_stage_1 = require("./services/sales_order.stage");
const ns_rest_compare_fields_1 = require("./config/ns_rest_compare.fields");
const warehouse_w2g_1 = require("./services/warehouse.w2g");
const inbound_w2g_1 = require("./services/inbound.w2g");
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
app_1.default.use("/api/v4", credit_memo_route_1.default);
app_1.default.use("/api/v4", item_fulfillment_route_1.default);
// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = 5002;
const server = app_1.default.listen(PORT, async () => {
    logger_config_1.default.info(`Server running at http://localhost:${PORT}`);
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
    const nsRestCompareLog = nsDb.collection(ns_rest_compare_fields_1.NS_REST_COMPARE_LOG_COLLECTION);
    await nsRestCompareLog.createIndex({ compared_at: -1 }, { name: "idx_ns_rest_compare_log_compared_at", background: true });
    await nsRestCompareLog.createIndex({ record_type: 1, ns_internal_id: 1, compared_at: -1 }, { name: "idx_ns_rest_compare_log_type_id_time", background: true });
    logger_config_1.default.info("[STARTUP] MongoDB indexes ensured for suite_sales_order, suite_purchase_order, NS REST SO/PO dump, inventory/classification/IF/IR dump, compare diff log");
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
// CRON JOBS & MANUAL TRIGGERS
// ═══════════════════════════════════════════════════════════════════════════════
const runW2gEvery2Hours = async () => {
    try {
        await (0, warehouse_w2g_1.getWare2SoOrderOutbound)();
    }
    catch (error) {
        logger_config_1.default.info(' W2g SO Outbound cron failed : ', error);
    }
    try {
        await (0, inbound_w2g_1.syncAllWare2GoInboundShipments)();
    }
    catch (error) {
        logger_config_1.default.info(' W2g Inbound Shipment cron failed : ', error);
    }
    logger_config_1.default.info('Every 2 hours job executed at: ' + new Date().toISOString());
};
exports.runW2gEvery2Hours = runW2gEvery2Hours;
const runW2gWeekly = async () => {
    try {
        await (0, warehouse_w2g_1.getWare2SoOrderOutbound)({ forceRestart: false, retryFailedOnly: false, all: true });
    }
    catch (error) {
        logger_config_1.default.info('Weekly W2g SO Outbound cron failed : ', error);
    }
    try {
        await (0, inbound_w2g_1.syncAllWare2GoInboundShipments)({ forceRestart: false, retryFailedOnly: false, all: true });
    }
    catch (error) {
        logger_config_1.default.info('Weekly W2g Inbound Shipment cron failed : ', error);
    }
    logger_config_1.default.info('Weekly Saturday job executed at: ' + new Date().toISOString());
};
exports.runW2gWeekly = runW2gWeekly;
let isSyncJobRunning = false;
const runMainSyncJob = async () => {
    if (isSyncJobRunning) {
        logger_config_1.default.info('Previous sync job is still running. Skipping this cron run.');
        return;
    }
    isSyncJobRunning = true;
    logger_config_1.default.info('Starting scheduled sync job...');
    try {
        try {
            await (0, sales_order_stage_1.stageSalesOrders)();
            console.log("SO run");
        }
        catch (error) {
            console.log(error);
        }
        try {
            await (0, sales_order_sync_1.syncDummySalesOrdersToNetsuite)();
            console.log("SO sync run");
        }
        catch (error) {
            console.log(error);
        }
        try {
            await (0, po_stage_1.stagePurchaseOrders)();
            console.log("PO stage run");
        }
        catch (error) {
            console.log(error);
        }
        try {
            await (0, po_sync_1.syncPurchaseOrdersToNetsuite)();
            console.log("PO sync run");
        }
        catch (error) {
            console.log(error);
        }
        try {
            await (0, bill_stage_1.stageBills)();
            console.log("Bill stage run");
        }
        catch (error) {
            console.log(error);
        }
        try {
            await (0, bill_sync_1.syncStagedDummyBillsOnce)();
            console.log("Bill Sync run");
        }
        catch (error) {
            console.log(error);
        }
    }
    catch (error) {
        logger_config_1.default.error('Sync cron job failed: ', error);
    }
    finally {
        isSyncJobRunning = false;
        logger_config_1.default.info('Scheduled sync job finished.');
    }
};
exports.runMainSyncJob = runMainSyncJob;
// 1. W2G dummp cron jobs 
// Job 1: Runs every 2 hours
node_cron_1.default.schedule('0 */2 * * *', exports.runW2gEvery2Hours);
// Job 2: Runs every Saturday at 00:00 (midnight)
node_cron_1.default.schedule('0 0 * * 6', exports.runW2gWeekly);
// Job 3: Every 30 mins
node_cron_1.default.schedule('*/30 * * * *', exports.runMainSyncJob);
// 4. MANUAL TRIGGER ENDPOINT
// GET /api/v4/force-run-crons
app_1.default.get("/api/v4/force-run-crons", (req, res) => {
    const target = req.query.target;
    if (target === "w2g-2h") {
        (0, exports.runW2gEvery2Hours)();
        res.json({ message: "W2G 2-hour job started in the background." });
    }
    else if (target === "w2g-weekly") {
        (0, exports.runW2gWeekly)();
        res.json({ message: "W2G Weekly job started in the background." });
    }
    else if (target === "main-sync") {
        (0, exports.runMainSyncJob)();
        res.json({ message: "Main Sync job started in the background." });
    }
    else {
        // Run all
        (0, exports.runW2gEvery2Hours)();
        (0, exports.runMainSyncJob)();
        res.json({
            message: "All primary cron jobs (W2G & Main Sync) started in the background.",
            hint: "You can trigger specific ones by adding ?target=w2g-2h, ?target=w2g-weekly, or ?target=main-sync to the URL."
        });
    }
});
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
    // while ((soSyncRunning || poSyncRunning) && Date.now() < deadline) {
    //     log.info(`[SHUTDOWN] Waiting for in-flight syncs... SO=${soSyncRunning}, PO=${poSyncRunning}`);
    //     await new Promise(r => setTimeout(r, 2_000));
    // }
    // if (soSyncRunning || poSyncRunning) {
    //     log.warn("[SHUTDOWN] Timed out waiting for syncs — forcing exit");
    // }
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
