"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_client_1 = require("../services/netsuite.client");
const router = (0, express_1.Router)();
// ─── Sync Classification Tree (NetSuite → MongoDB) ─────────────────────────
// GET /sync-class-tree → fetches all classes from NetSuite, builds nested tree, stores in MongoDB
router.get("/sync-class-tree", async (_req, res) => {
    try {
        logger_config_1.default.info("[CLASS-TREE] Fetching classifications from NetSuite...");
        const response = await (0, netsuite_client_1.callDiagnostic)({ sections: ["fetch_class_tree"] });
        const data = response?.fetch_class_tree;
        if (!data || data.error) {
            return res.status(500).json({ success: false, error: data?.error || "No data returned" });
        }
        const flat = data.classifications || [];
        logger_config_1.default.info(`[CLASS-TREE] Got ${flat.length} classifications. Building tree...`);
        // Build nested tree from flat list
        const nodeMap = {};
        for (const c of flat) {
            nodeMap[c.id] = { internalid: c.id, name: c.name, fullname: c.fullname, children: [] };
        }
        const roots = [];
        for (const c of flat) {
            if (c.parent && nodeMap[c.parent]) {
                nodeMap[c.parent].children.push(nodeMap[c.id]);
            }
            else if (!c.parent) {
                roots.push(nodeMap[c.id]);
            }
        }
        // Store each root as a separate document in MongoDB
        const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = nsDb.collection("netsuite_classifications");
        // Clean and replace
        await col.deleteMany({});
        if (roots.length > 0) {
            await col.insertMany(roots);
        }
        await col.createIndex({ internalid: 1 }, { unique: true });
        logger_config_1.default.info(`[CLASS-TREE] Done. ${roots.length} root classes stored with nested children.`);
        res.json({
            success: true,
            total_classifications: flat.length,
            root_classes: roots.length,
            tree: roots,
        });
    }
    catch (e) {
        logger_config_1.default.error("[CLASS-TREE] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Diagnostic ─────────────────────────────────────────────────────────────
router.get("/diagnostic", async (_req, res) => {
    try {
        const result = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["account", "subsidiaries", "locations", "custom_fields", "forms"],
        });
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
router.post("/diagnostic", async (req, res) => {
    try {
        const result = await (0, netsuite_client_1.callDiagnostic)(req.body);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Delete All SOs (Pending Fulfillment) ───────────────────────────────────
// GET  /delete-all-so → dry-run
// POST /delete-all-so → delete in batches
router.get("/delete-all-so", async (_req, res) => {
    try {
        const result = await (0, netsuite_client_1.callDiagnostic)({ sections: ["delete_all_so"], confirm: false });
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
router.post("/delete-all-so", async (req, res) => {
    try {
        const batchSize = parseInt(req.query.batch) || 200;
        let totalDeleted = 0, totalFailed = 0, batchNum = 0, done = false;
        logger_config_1.default.info(`[DELETE-SO] Starting bulk delete (batch size: ${batchSize})`);
        while (!done) {
            batchNum++;
            logger_config_1.default.info(`[DELETE-SO] Batch ${batchNum}...`);
            const result = await (0, netsuite_client_1.callDiagnostic)({ sections: ["delete_all_so"], confirm: true, batch_size: batchSize });
            const batch = result?.delete_all_so;
            if (!batch || batch.error) {
                return res.status(500).json({
                    success: false, error: batch?.error || "Unknown error",
                    batches_completed: batchNum - 1, total_deleted: totalDeleted, total_failed: totalFailed,
                });
            }
            totalDeleted += batch.deleted_count || 0;
            totalFailed += batch.failed_count || 0;
            done = batch.done || batch.found_in_batch === 0;
            logger_config_1.default.info(`[DELETE-SO] Batch ${batchNum}: deleted ${batch.deleted_count}, failed ${batch.failed_count}, remaining ${batch.remaining}`);
        }
        logger_config_1.default.info(`[DELETE-SO] Done. Total deleted: ${totalDeleted}, failed: ${totalFailed}`);
        res.json({
            success: true, status_filter: "Pending Fulfillment",
            total_deleted: totalDeleted, total_failed: totalFailed,
            batches: batchNum, message: "All Pending Fulfillment Sales Orders deleted.",
        });
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Cleanup (test SOs + all POs) ──────────────────────────────────────────
// GET  /cleanup → dry-run
// POST /cleanup → delete
router.get("/cleanup", async (_req, res) => {
    try {
        const result = await (0, netsuite_client_1.callCleanup)({ action: "list_all" });
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
router.post("/cleanup", async (_req, res) => {
    try {
        let totalDeletedPO = 0, totalDeletedSO = 0, batchNum = 0;
        let poDone = false, soDone = false;
        while (!poDone || !soDone) {
            batchNum++;
            logger_config_1.default.info(`[CLEANUP] Batch ${batchNum}...`);
            const result = await (0, netsuite_client_1.callCleanup)({ action: "delete_all" });
            const po = result?.purchase_orders;
            const so = result?.test_sales_orders;
            if (po) {
                totalDeletedPO += po.deleted || 0;
                poDone = po.done || (po.deleted === 0 && po.remaining <= 0);
            }
            else {
                poDone = true;
            }
            if (so) {
                totalDeletedSO += so.deleted || 0;
                soDone = so.done || (so.deleted === 0 && so.remaining <= 0);
            }
            else {
                soDone = true;
            }
            logger_config_1.default.info(`[CLEANUP] Batch ${batchNum}: PO deleted ${po?.deleted || 0} (remaining ~${po?.remaining || 0}), SO deleted ${so?.deleted || 0} (remaining ~${so?.remaining || 0})`);
        }
        res.json({ success: true, total_deleted_po: totalDeletedPO, total_deleted_so: totalDeletedSO, batches: batchNum });
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Bill ───────────────────────────────────────────────────────────────────
router.post("/bill-test", async (req, res) => {
    try {
        const result = await (0, netsuite_client_1.postToNetsuiteForBill)(req.body);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
router.get("/test-bill-flow", async (req, res) => {
    try {
        const poNumber = req.query.po || "987612345";
        const result = await (0, netsuite_client_1.postToNetsuiteForBill)({
            action: "create",
            po_number: poNumber,
            invoice_number: "INV-TEST-" + Date.now(),
            invoice_date: new Date().toISOString().split("T")[0],
            memo: "Test bill created from PO " + poNumber,
        });
        res.json({ success: true, ...result });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});
exports.default = router;
