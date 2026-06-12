"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const mongdodb_config_1 = require("../config/mongdodb.config");
const item_fulfillment_stage_1 = require("../services/item_fulfillment.stage");
const item_fulfillment_sync_1 = require("../services/item_fulfillment.sync");
const netsuite_client_1 = require("../services/netsuite.client");
const item_fulfillment_stage_2 = require("../services/item_fulfillment.stage");
const router = (0, express_1.Router)();
// ─── Direct IF RESTlet test call ────────────────────────────────────────────
// POST /if-test  Body: full payload
router.post("/if-test", async (req, res) => {
    try {
        const result = await (0, netsuite_client_1.postToNetsuiteForIF)(req.body);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Stage Item Fulfillments ─────────────────────────────────────────────────
// GET /stage-if-dummy → stages Dropship Shipped POs to  
router.get("/stage-if-dummy", async (_req, res) => {
    try {
        const result = await (0, item_fulfillment_stage_1.stageItemFulfillmentsDummy)();
        res.json({ success: true, ...result });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Sync Item Fulfillments ──────────────────────────────────────────────────
// GET /sync-if → sends pending staged IFs to NetSuite
router.get("/sync-if", async (_req, res) => {
    try {
        const results = await (0, item_fulfillment_sync_1.syncItemFulfillmentsToNetsuite)();
        const success = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        res.json({ success: true, total: results.length, synced: success, failed, results });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── IF Sync Status ──────────────────────────────────────────────────────────
// GET /if-sync-status → counts by sync state
router.get("/if-sync-status", async (_req, res) => {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = ns_db.collection(item_fulfillment_stage_2.IF_COLLECTION);
        const total = await col.countDocuments({});
        const synced = await col.countDocuments({ ns_synced: true });
        const failed = await col.countDocuments({ ns_failed: true });
        const skipped = await col.countDocuments({ ns_skip: true });
        const waitingForSO = await col.countDocuments({ so_synced: { $ne: true } });
        const pending = await col.countDocuments({
            ns_synced: { $ne: true },
            ns_failed: { $ne: true },
            ns_skip: { $ne: true },
            so_synced: true
        });
        res.json({
            success: true,
            collection: item_fulfillment_stage_2.IF_COLLECTION,
            total,
            synced,
            failed,
            skipped,
            pending,
            waiting_for_so: waitingForSO
        });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Reset IF sync flags ─────────────────────────────────────────────────────
// POST /reset-if-sync → reset all ns_ flags so records re-sync
router.post("/reset-if-sync", async (_req, res) => {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = ns_db.collection(item_fulfillment_stage_2.IF_COLLECTION);
        const result = await col.updateMany({}, {
            $set: { ns_synced: false },
            $unset: { ns_synced_at: "", ns_result: "", ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "", ns_internal_id: "" }
        });
        logger_config_1.default.info(`[RESET-IF-SYNC] Reset ${result.modifiedCount} records`);
        res.json({ success: true, modified: result.modifiedCount });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Retry failed IFs ───────────────────────────────────────────────────────
// GET /retry-failed-if
router.get("/retry-failed-if", async (_req, res) => {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = ns_db.collection(item_fulfillment_stage_2.IF_COLLECTION);
        const result = await col.updateMany({ ns_failed: true }, {
            $set: { ns_synced: false, ns_failed: false },
            $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "" }
        });
        logger_config_1.default.info(`[RETRY-IF] Reset ${result.modifiedCount} failed records`);
        const syncResults = await (0, item_fulfillment_sync_1.syncItemFulfillmentsToNetsuite)();
        res.json({ success: true, reset: result.modifiedCount, synced: syncResults.length, results: syncResults });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
exports.default = router;
