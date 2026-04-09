"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageBills = void 0;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
// Same VENDOR_MAP as PO stage — resolves distributor + payment_type to NetSuite vendor
const VENDOR_MAP = {
    "dandh": {
        default: { name: "D&H", id: 119 },
        dll: { name: "D&H - DLL", id: 118 }
    },
    "ingram": {
        default: { name: "Ingram Micro - NET", id: 133 },
        dll: { name: "Ingram Micro - DLL", id: 269 }
    },
    "suppliesnetwork": {
        default: { name: "Distribution Management", id: 268 },
        dll: { name: "Distribution Management - DLL", id: 131 }
    },
    "synnex": {
        default: { name: "TD Synnex - Term", id: 116 },
        dll: { name: "TD Synnex - DLL", id: 117 }
    },
    "techdata": {
        default: { name: "TD Synnex - Term", id: 116 },
        dll: { name: "TD Synnex - DLL", id: 117 }
    }
};
// Distributor -> stocking warehouse code (from po_management defaults)
const DISTRIBUTOR_WAREHOUSE = {
    "dandh": "MW",
    "ingram": "MW",
    "suppliesnetwork": "MW",
    "synnex": "MW",
    "techdata": "MW"
};
function resolveVendor(distributor, paymentType) {
    const key = (distributor || "").trim().toLowerCase();
    const isDLL = (paymentType || "").trim().toUpperCase() === "DLL";
    const entry = VENDOR_MAP[key];
    if (!entry) {
        logger_config_1.default.warn(`[Bill Stage] Unknown distributor: "${distributor}" -- vendor_id will be null`);
        return { name: distributor || "", id: null };
    }
    return isDLL ? entry.dll : entry.default;
}
// Parse date safely -- output "M/D/YYYY" to avoid timezone shift in NetSuite.
// Handles ISO ("2026-03-16T23:00:00"), space-separated ("2026-03-16 23:00:00"),
// garbage ("0000-00-00"), null, undefined.
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
const stageBills = async () => {
    logger_config_1.default.info("[Bill Stage] Starting...");
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_vendor_bill");
    // Source: ebp_pomanager.po_bills -- invoices linked to POs
    const bills_cursor = po_db.collection("po_bills").find({
        invoiceType: { $in: ["Invoice", "Sales Order", "IN"] },
        invoiceDate: { $gte: "2026-01-01" }
    });
    const staged = [];
    let skippedCount = 0;
    const skipReasons = {};
    function markSkip(doc, reason) {
        doc.ns_skip = true;
        doc.ns_skip_reason = reason;
        skippedCount++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
    }
    for await (const bill of bills_cursor) {
        // Must have poNumber and invoiceNumber to form a unique key
        if (!bill.poNumber)
            continue;
        if (!bill.invoiceNumber) {
            logger_config_1.default.warn(`[Bill Stage] PO ${bill.poNumber} missing invoiceNumber -- skipping source doc`);
            continue;
        }
        const poNum = Number(bill.poNumber);
        const invNum = String(bill.invoiceNumber);
        const refNum = `PO${poNum}-${invNum}`;
        const vendor = resolveVendor(bill.distributor, bill.paymentType);
        const invoiceDate = toSafeDate(bill.invoiceDate);
        const dueDate = toSafeDate(bill.dueDate);
        // Derive stocking_warehouse from distributor if not on the bill
        const distKey = (bill.distributor || "").trim().toLowerCase();
        const stockingWarehouse = bill.stocking_warehouse || DISTRIBUTOR_WAREHOUSE[distKey] || "";
        // Build items array -- filter out entries with no SKU
        const items = [];
        if (Array.isArray(bill.items)) {
            for (const item of bill.items) {
                const sku = String(item.sku || item.itemId || "").trim();
                if (!sku)
                    continue;
                items.push({
                    sku,
                    qty: String(item.qty || item.quantity || "0"),
                    price: String(item.price || item.unitPrice || item.cost || "0")
                });
            }
        }
        const doc = {
            po_number: poNum,
            invoice_number: invNum,
            reference_number: refNum,
            distributor: vendor.name,
            vendor_id: vendor.id,
            invoice_type: bill.invoiceType || "",
            invoice_date: invoiceDate,
            due_date: dueDate,
            total_amount: String(bill.totalAmount || "0"),
            items,
            summary: bill.summary ?? null,
            terms: bill.terms || "",
            payment_type: bill.paymentType || "",
            po_type: bill.poType || "",
            stocking_warehouse: stockingWarehouse,
            website_order_number: bill.websiteOrderNumber || ""
        };
        // Validation: mark skip reasons (staged but never sent to NetSuite)
        if (!dueDate) {
            markSkip(doc, "no_dueDate");
        }
        else if (items.length === 0) {
            markSkip(doc, "no_items");
        }
        else if (!invoiceDate) {
            markSkip(doc, "no_invoiceDate");
        }
        staged.push(doc);
    }
    logger_config_1.default.info(`[Bill Stage] Found ${staged.length} bills (${skippedCount} marked skip: ${JSON.stringify(skipReasons)})`);
    if (staged.length > 0) {
        // Upsert by composite key: po_number + invoice_number
        // Use $set for data fields only -- never overwrite ns_ sync tracking fields
        // on docs that are already synced or in-progress.
        await collection.bulkWrite(staged.map(bill => {
            // Separate data fields from skip flags
            const { ns_skip, ns_skip_reason, ...dataFields } = bill;
            // Base update: always refresh data fields
            const update = { $set: dataFields };
            // For skip-marked bills, set skip flags
            // For non-skip bills, clear any stale skip flags from previous runs
            if (ns_skip) {
                update.$set.ns_skip = true;
                update.$set.ns_skip_reason = ns_skip_reason;
            }
            else {
                // Only clear skip flags if they exist (don't touch synced docs)
                update.$unset = { ns_skip: "", ns_skip_reason: "" };
            }
            return {
                updateOne: {
                    filter: {
                        po_number: bill.po_number,
                        invoice_number: bill.invoice_number,
                        // Don't overwrite already-synced bills
                        ns_synced: { $ne: true }
                    },
                    update,
                    upsert: true
                }
            };
        }));
    }
    logger_config_1.default.info(`[Bill Stage] Staged ${staged.length} bills to netsuite.suite_vendor_bill`);
    return { processed: staged.length, skipped: skippedCount, reasons: skipReasons };
};
exports.stageBills = stageBills;
