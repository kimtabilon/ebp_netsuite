"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const mongdodb_config_1 = require("../config/mongdodb.config");
const bill_stage_1 = require("../services/bill.stage");
const credit_memo_sync_1 = require("../services/credit_memo.sync");
const netsuite_client_1 = require("../services/netsuite.client");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const axios_1 = __importDefault(require("axios"));
const router = (0, express_1.Router)();
// ─── Direct Credit Memo RESTlet call ─────────────────────────────────────────
router.post("/credit-test", async (req, res) => {
    try {
        const result = await (0, netsuite_client_1.postToNetsuiteForCreditMemo)(req.body);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Stage Credit Memos (po_bills -> suite_credit_memo_bill) ────────────
router.get("/stage-credit", async (_req, res) => {
    try {
        const result = await (0, bill_stage_1.stageCreditBillsDummy)();
        res.json({ success: true, ...result });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Sync Credit Memos (suite_credit_memo_bill -> NetSuite ERP) ─────────
router.get("/sync-credit", async (_req, res) => {
    try {
        await (0, credit_memo_sync_1.syncCreditMemosToNetsuite)();
        res.json({ success: true, message: "Sync process completed. Check logs for details." });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Reset Credit sync flags ──────────────────────────────────────────────────
router.post("/reset-credit-sync", async (_req, res) => {
    try {
        const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = nsDb.collection("suite_credit_memo_bill");
        const result = await col.updateMany({}, {
            $set: { ns_synced: false, ns_failed: false },
            $unset: {
                ns_synced_at: "", ns_result: "", ns_error: "",
                ns_error_at: "", ns_vendor_credit_id: ""
            }
        });
        res.json({ success: true, action: "reset", modified: result.modifiedCount });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Delete All Credit Memos in NetSuite ──────────────────────────────────────
router.post("/delete-all-credit-memos", async (_req, res) => {
    try {
        const ACCOUNT = process.env.NS_ACCOUNT_ID;
        const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
        const queryUrl = `${BASE_URL}/services/rest/query/v1/suiteql`;
        logger_config_1.default.info("[API Delete Credits] Fetching Vendor Credits from NetSuite...");
        // Fetch all credits
        const query = `SELECT id, tranid FROM transaction WHERE type = 'VendCred' ORDER BY id DESC`;
        const response = await axios_1.default.post(queryUrl, { q: query }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(queryUrl, "POST"),
                "Content-Type": "application/json",
                Prefer: "transient"
            },
            timeout: 60000
        });
        const allItems = response.data.items || [];
        const matchRecords = allItems.filter((r) => r.tranid && String(r.tranid).startsWith("PO"));
        logger_config_1.default.info(`[API Delete Credits] Found ${allItems.length} total Credits, ${matchRecords.length} match "PO*" prefix`);
        if (matchRecords.length === 0) {
            return res.json({ success: true, message: "No matching vendor credits found to delete." });
        }
        const ids = matchRecords.map((r) => r.id);
        logger_config_1.default.info(`[API Delete Credits] Sending ${ids.length} IDs to cleanup RESTlet in batches of 40...`);
        const batchSize = 40;
        const deletedIds = [];
        const errors = [];
        for (let i = 0; i < ids.length; i += batchSize) {
            const chunk = ids.slice(i, i + batchSize);
            const cleanResult = await (0, netsuite_client_1.callCleanup)({
                action: "delete_ids",
                recordType: "vendorcredit",
                ids: chunk
            });
            if (cleanResult?.success) {
                deletedIds.push(...(cleanResult.data?.deleted || []));
                if (cleanResult.data?.errors) {
                    errors.push(...cleanResult.data.errors);
                }
            }
            else {
                errors.push({ batch: chunk, error: cleanResult?.error || "Cleanup RESTlet failed" });
            }
        }
        logger_config_1.default.info(`[API Delete Credits] Finished. Deleted: ${deletedIds.length}, Failed: ${errors.length}`);
        res.json({
            success: true,
            total_found: matchRecords.length,
            deleted_count: deletedIds.length,
            failed_count: errors.length,
            deleted_ids: deletedIds,
            errors: errors.length > 0 ? errors : undefined
        });
    }
    catch (e) {
        logger_config_1.default.error("[API Delete Credits] Error:", e.response?.data || e.message);
        res.status(500).json({ success: false, error: e.response?.data || e.message });
    }
});
exports.default = router;
