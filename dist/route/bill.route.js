"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const mongdodb_config_1 = require("../config/mongdodb.config");
const bill_stage_1 = require("../services/bill.stage");
const bill_sync_1 = require("../services/bill.sync");
const netsuite_client_1 = require("../services/netsuite.client");
const router = (0, express_1.Router)();
// ─── Direct Bill RESTlet call ────────────────────────────────────────────────
router.post("/bill-test", async (req, res) => {
    try {
        const result = await (0, netsuite_client_1.postToNetsuiteForBill)(req.body);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Test bill from raw po_bills document ────────────────────────────────────
// Accepts a raw po_bills MongoDB document, transforms it to RESTlet payload,
// and sends it directly to NetSuite. Useful for testing with real data.
function toSafeDate(raw) {
    if (!raw)
        return "";
    const str = String(raw).trim();
    if (!str || str === "0000-00-00" || str.startsWith("0000"))
        return "";
    const d = new Date(str.replace(" ", "T"));
    if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2030)
        return "";
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
router.post("/bill-from-raw", async (req, res) => {
    try {
        const raw = req.body;
        if (!raw.poNumber) {
            return res.status(400).json({ success: false, error: "Missing poNumber in raw document" });
        }
        const poNum = Number(raw.poNumber);
        const invNum = String(raw.invoiceNumber || "");
        const refNum = `PO${poNum}-${invNum}`;
        const payload = {
            action: req.query.action || "skip",
            po_number: poNum,
            invoice_number: invNum,
            reference_number: refNum,
            invoice_date: toSafeDate(raw.invoiceDate),
            due_date: toSafeDate(raw.dueDate),
            line_items: Array.isArray(raw.items) ? raw.items : [],
            po_type: raw.poType || "",
            stocking_warehouse: raw.stocking_warehouse || "MW"
        };
        logger_config_1.default.info(`[BILL-FROM-RAW] Sending bill ${refNum} to NetSuite`, { payload });
        const result = await (0, netsuite_client_1.postToNetsuiteForBill)(payload);
        res.json({ success: true, payload_sent: payload, netsuite_response: result });
    }
    catch (e) {
        logger_config_1.default.error("[BILL-FROM-RAW] Error:", e?.response?.data || e.message);
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});
// ─── Stage Bills (ebp_pomanager.po_bills -> suite_vendor_bill) ───────────────
router.get("/stage-bill", async (_req, res) => {
    try {
        const result = await (0, bill_stage_1.stageBills)();
        res.json({ success: true, ...result });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Sync Bills (suite_vendor_bill -> NetSuite ERP) ──────────────────────────
router.get("/sync-bill", async (_req, res) => {
    try {
        const results = await (0, bill_sync_1.syncBillsToNetsuite)();
        res.json({ success: true, count: results.length, results });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Reset Bill sync flags ───────────────────────────────────────────────────
// GET  /reset-bill-sync -> dry-run (count docs with ns_ flags)
// POST /reset-bill-sync -> unset all ns_ fields
router.get("/reset-bill-sync", async (_req, res) => {
    try {
        const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = nsDb.collection("suite_vendor_bill");
        const count = await col.countDocuments({
            $or: [
                { ns_synced: true },
                { ns_failed: true },
                { ns_error: { $exists: true } },
                { ns_retry_count: { $exists: true } },
            ]
        });
        res.json({ success: true, action: "dry_run", bills_with_sync_flags: count });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
router.post("/reset-bill-sync", async (_req, res) => {
    try {
        const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
        const col = nsDb.collection("suite_vendor_bill");
        const result = await col.updateMany({}, {
            $set: { ns_synced: false },
            $unset: {
                ns_synced_at: "", ns_result: "", ns_error: "",
                ns_error_at: "", ns_retry_count: "", ns_failed: "",
                ns_skip: "", ns_skip_reason: ""
            }
        });
        logger_config_1.default.info(`[RESET-BILL-SYNC] Reset ${result.modifiedCount} bills`);
        res.json({ success: true, action: "reset", matched: result.matchedCount, modified: result.modifiedCount });
    }
    catch (e) {
        logger_config_1.default.error("[RESET-BILL-SYNC] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Retry failed Bills ──────────────────────────────────────────────────────
router.get("/retry-failed-bill", async (req, res) => {
    try {
        const resetAll = req.query.all === "1" || req.query.all === "true";
        const result = await (0, bill_sync_1.retryFailedBills)(resetAll);
        res.json({ success: true, ...result });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── Bills with synced POs (ready to sync) ───────────────────────────────────
router.get("/bill-ready", async (_req, res) => {
    try {
        const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
        const billColl = nsDb.collection("suite_vendor_bill");
        const poColl = nsDb.collection("suite_purchase_order");
        // All unsynced, non-failed, non-skipped bills
        const pendingBills = await billColl
            .find({ ns_synced: { $ne: true }, ns_failed: { $ne: true }, ns_skip: { $ne: true } })
            .project({ po_number: 1, invoice_number: 1, reference_number: 1, invoice_date: 1, due_date: 1, total_amount: 1 })
            .toArray();
        if (pendingBills.length === 0) {
            return res.json({ success: true, total_pending: 0, ready: 0, waiting: 0, bills: [] });
        }
        const poNumbers = Array.from(new Set(pendingBills.map((b) => b.po_number)));
        const syncedPOs = await poColl
            .find({ po_number: { $in: poNumbers }, ns_synced: true, ns_result: "created" })
            .project({ po_number: 1 })
            .toArray();
        const syncedPOSet = new Set(syncedPOs.map((p) => p.po_number));
        const readyBills = pendingBills.filter((b) => syncedPOSet.has(b.po_number));
        res.json({
            success: true,
            total_pending: pendingBills.length,
            ready: readyBills.length,
            waiting: pendingBills.length - readyBills.length,
            bills: readyBills
        });
    }
    catch (e) {
        logger_config_1.default.error("[BILL-READY] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// ─── List invoices for a synced Dropship PO ─────────────────────────────────
// GET /dropship-bills?po=228047  → bills from po_bills where PO is synced + Dropship
// No ?po param → list all synced Dropship POs with their invoice numbers
router.get("/dropship-bills", async (req, res) => {
    try {
        const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
        const poDb = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
        // Find synced Dropship POs
        const poFilter = { po_type: "Dropship", ns_synced: true, ns_result: "created" };
        const poParam = req.query.po;
        if (poParam) {
            poFilter.po_number = Number(poParam);
        }
        const syncedPOs = await nsDb.collection("suite_purchase_order")
            .find(poFilter)
            .project({ po_number: 1, website_order_number: 1, distributor: 1, vendor_id: 1 })
            .toArray();
        if (syncedPOs.length === 0) {
            return res.json({ success: true, count: 0, message: poParam ? "PO " + poParam + " not found or not synced as Dropship" : "No synced Dropship POs", pos: [] });
        }
        const poNumbers = syncedPOs.map((p) => p.po_number);
        // Pull invoices from po_bills for those PO numbers
        const bills = await poDb.collection("po_bills")
            .find({ poNumber: { $in: poNumbers } })
            .project({ poNumber: 1, invoiceNumber: 1, invoiceType: 1, invoiceDate: 1, dueDate: 1, totalAmount: 1, items: 1, poType: 1 })
            .toArray();
        // Group by PO
        const poMap = {};
        for (const po of syncedPOs) {
            poMap[po.po_number] = {
                po_number: po.po_number,
                website_order_number: po.website_order_number,
                distributor: po.distributor,
                invoices: []
            };
        }
        for (const bill of bills) {
            const entry = poMap[bill.poNumber];
            if (entry) {
                entry.invoices.push({
                    invoiceNumber: bill.invoiceNumber,
                    invoiceType: bill.invoiceType,
                    invoiceDate: bill.invoiceDate,
                    dueDate: bill.dueDate,
                    totalAmount: bill.totalAmount,
                    itemCount: Array.isArray(bill.items) ? bill.items.length : 0
                });
            }
        }
        const result = Object.values(poMap);
        res.json({
            success: true,
            count: result.length,
            total_invoices: bills.length,
            pos: result
        });
    }
    catch (e) {
        logger_config_1.default.error("[DROPSHIP-BILLS] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});
exports.default = router;
