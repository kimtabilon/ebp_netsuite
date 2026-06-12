"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageCreditBillsDummy = exports.stageBills = void 0;
exports.runFunctionForBills = runFunctionForBills;
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
// ─── Shared helpers ────────────────────────────────────────────────────────────
function buildItemsArray(rawItems) {
    const items = [];
    if (!Array.isArray(rawItems))
        return items;
    for (const item of rawItems) {
        const sku = String(item.sku || item.itemId || "").trim();
        if (!sku)
            continue;
        items.push({
            sku,
            qty: String(item.qty || item.quantity || "0"),
            price: String(item.price || item.unitPrice || item.cost || "0"),
            ...(item.serials && Array.isArray(item.serials) ? { serials: item.serials } : {})
        });
    }
    return items;
}
// Fields that are part of "business content" — used for change detection
const BILL_CONTENT_FIELDS = [
    "invoice_number",
    "distributor",
    "vendor_id",
    "invoice_type",
    "invoice_date",
    "due_date",
    "total_amount",
    "items",
    "terms",
    "payment_type",
    "po_type",
    "stocking_warehouse",
    "website_order_number",
    "summary"
];
/** Returns true if two staged bill payloads have identical business content. */
function isStagedBillContentEqual(a, b) {
    for (const field of BILL_CONTENT_FIELDS) {
        const aVal = JSON.stringify(a?.[field] ?? null);
        const bVal = JSON.stringify(b?.[field] ?? null);
        if (aVal !== bVal)
            return false;
    }
    return true;
}
function buildBulkOp(bill, changed = false) {
    const { ns_skip, ns_skip_reason, _changed, ns_synced, ns_sync, ns_result, ns_error, ns_error_at, last_synced_at, ns_retry_count, staged_at, ...dataFields } = bill;
    const now = new Date();
    const update = {
        $set: dataFields,
        $setOnInsert: {
            staged_at: now
        }
    };
    // If content changed → reset sync flags so document gets re-synced
    if (changed) {
        update.$unset = {
            ns_synced: "",
            ns_sync: "",
            ns_result: "",
            ns_error: "",
            ns_error_at: "",
            last_synced_at: "",
            ns_retry_count: ""
        };
    }
    // Always update timestamp
    update.$set.updated_at = now;
    if (ns_skip) {
        update.$set.ns_skip = true;
        update.$set.ns_skip_reason = ns_skip_reason;
    }
    else {
        // Clear any stale skip flags
        update.$unset = update.$unset || {};
        update.$unset.ns_skip = "";
        update.$unset.ns_skip_reason = "";
    }
    return {
        updateOne: {
            filter: {
                po_number: bill.po_number,
                invoice_number: bill.invoice_number
            },
            update,
            upsert: true
        }
    };
}
const STAGE_DUMMY_WORKERS = 10;
const stageBills = async () => {
    logger_config_1.default.info(`[Bill Stage Dummy] Starting streaming approach...`);
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_vendor_bill_dummy");
    const poCollection = ns_db.collection("suite_purchase_order_dummy");
    // Strict filter: invoiceType case-insensitive, all required fields present
    const filter = {
        $and: [
            { invoiceType: { $in: [/^invoice$/i, /^sales order$/i, /^in$/i] } },
            { invoiceDate: { $exists: true, $ne: "" } },
            { dueDate: { $exists: true, $ne: "" } },
            { invoiceDate: { $gte: "2026-01-01" } },
            { poNumber: { $exists: true, $gt: 0 } },
            { invoiceNumber: { $exists: true, $ne: "" } },
            { items: { $exists: true, $ne: [], $not: { $size: 0 } } }
        ]
    };
    // ── Step 1: Detect duplicate invoiceNumbers via Aggregation (Memory Safe) ──
    logger_config_1.default.info(`[Bill Stage Dummy] Running aggregation to detect duplicate invoice numbers...`);
    const duplicateAgg = await po_db.collection("po_bills").aggregate([
        { $match: filter },
        { $group: { _id: "$invoiceNumber", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $project: { _id: 1 } }
    ]).toArray();
    const duplicatedInvoiceNumbers = new Set(duplicateAgg.map(d => String(d._id)));
    if (duplicatedInvoiceNumbers.size > 0) {
        logger_config_1.default.warn(`[Bill Stage Dummy] Found ${duplicatedInvoiceNumbers.size} duplicated invoiceNumbers.`);
    }
    // ── Step 2: Stream Cursor ──
    const bills_cursor = po_db.collection("po_bills").find(filter);
    let total = 0;
    let processed = 0;
    let updated = 0;
    let skippedCount = 0;
    let unchangedCount = 0;
    const skipReasons = {};
    function markSkip(doc, reason) {
        doc.ns_skip = true;
        doc.ns_skip_reason = reason;
        skippedCount++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        logger_config_1.default.warn(`[Bill Stage Dummy][SKIP] PO: ${doc.po_number || "-"} | Invoice: ${doc.invoice_number || "-"} | Reason: ${reason}`);
    }
    logger_config_1.default.info(`[Bill Stage Dummy] Streaming bills from cursor in high-speed batches...`);
    let batch = [];
    async function processBatch(currentBatch) {
        const bulkOps = [];
        // 1. Gather keys for this batch
        const poNums = currentBatch.map(b => Number(b.poNumber));
        const invNums = currentBatch.map(b => String(b.invoiceNumber));
        // 2. High-speed bulk lookups (2 queries instead of 1000!)
        const [poDocsArray, existingBillsArray] = await Promise.all([
            poCollection.find({ po_number: { $in: poNums } }).toArray(),
            collection.find({
                po_number: { $in: poNums },
                invoice_number: { $in: invNums }
            })
                .project({ ...Object.fromEntries(BILL_CONTENT_FIELDS.map(f => [f, 1])), _id: 0 })
                .toArray()
        ]);
        const poDocMap = new Map(poDocsArray.map(d => [d.po_number, d]));
        const existingBillMap = new Map(existingBillsArray.map(d => [`${d.po_number}-${d.invoice_number}`, d]));
        // 3. Process records synchronously using maps
        for (const bill of currentBatch) {
            const poNum = Number(bill.poNumber);
            const invNum = String(bill.invoiceNumber);
            // Filter duplicates
            if (duplicatedInvoiceNumbers.has(invNum)) {
                skippedCount++;
                skipReasons["duplicate_invoiceNumber"] = (skipReasons["duplicate_invoiceNumber"] || 0) + 1;
                continue;
            }
            // Diagnostics from map
            const poDoc = poDocMap.get(poNum);
            const po_exist = !!poDoc;
            const po_sync = !!(poDoc && poDoc.ns_synced === true);
            const refNum = `PO${poNum}-${invNum}`;
            const vendor = resolveVendor(bill.distributor, bill.paymentType);
            const invoiceDate = toSafeDate(bill.invoiceDate);
            const dueDate = toSafeDate(bill.dueDate);
            const distKey = (bill.distributor || "").trim().toLowerCase();
            const stockingWarehouse = bill.stocking_warehouse || DISTRIBUTOR_WAREHOUSE[distKey] || "";
            const items = buildItemsArray(bill.items);
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
                website_order_number: bill.websiteOrderNumber || "",
                ...{ po_exist, po_sync }
            };
            // Validation
            if (!dueDate)
                markSkip(doc, "no_dueDate");
            else if (items.length === 0)
                markSkip(doc, "no_items");
            else if (!invoiceDate)
                markSkip(doc, "no_invoiceDate");
            processed++;
            // Detect Changes using map
            let changed = false;
            const existing = existingBillMap.get(`${poNum}-${invNum}`);
            if (!existing) {
                changed = true;
            }
            else if (!isStagedBillContentEqual(doc, existing)) {
                changed = true;
            }
            else if (doc.ns_skip) {
                changed = true;
            }
            else {
                unchangedCount++;
            }
            if (changed) {
                updated++;
            }
            bulkOps.push(buildBulkOp(doc, changed));
        }
        // 4. Flush batch
        if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps, { ordered: false });
        }
    }
    // ── Stream and Batch ──
    for await (const bill of bills_cursor) {
        total++;
        batch.push(bill);
        if (batch.length >= 500) {
            await processBatch(batch);
            batch = [];
        }
    }
    if (batch.length > 0) {
        await processBatch(batch);
    }
    logger_config_1.default.info(`[Bill Stage Dummy] Done — total=${total}, processed=${processed}, updated=${updated}, unchanged=${unchangedCount}, skipped=${skippedCount}`);
    return {
        processed: updated, // return the number of updated records for backwards compatibility
        skipped: skippedCount,
        reasons: skipReasons
    };
};
exports.stageBills = stageBills;
const stageCreditBillsDummy = async () => {
    logger_config_1.default.info(`[Credit Bill Stage Dummy] Starting... (workers: ${STAGE_DUMMY_WORKERS})`);
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_credit_memo_bill");
    const poCollection = ns_db.collection("suite_purchase_order_dummy");
    const billCollection = ns_db.collection("suite_vendor_bill_dummy");
    const poManagementCol = po_db.collection("po_management");
    // Strict filter for Credit Memos (Case-insensitive $nin for Invoice/Sales Order/IN)
    const filter = {
        $and: [
            {
                invoiceType: {
                    $in: [
                        /^CreditMemo$/i,
                        /^RMA CC$/i,
                        /^Credit Memo$/i,
                        /^RMA RTC$/i
                    ]
                }
            },
            { invoiceDate: { $exists: true, $ne: "" } },
            { dueDate: { $exists: true, $ne: "" } },
            { invoiceDate: { $gte: "2026-01-01" } },
            { poNumber: { $exists: true, $gt: 0 } },
            { invoiceNumber: { $exists: true, $ne: "" } },
            { items: { $exists: true, $ne: [], $not: { $size: 0 } } }
        ]
    };
    const bills = await po_db.collection("po_bills").find(filter).toArray();
    const billCount = bills.length;
    logger_config_1.default.info(`[Credit Bill Stage Dummy] Found ${billCount} bills matching criteria`);
    const invoiceNumberCount = {};
    for (const bill of bills) {
        const invNum = String(bill.invoiceNumber);
        invoiceNumberCount[invNum] = (invoiceNumberCount[invNum] || 0) + 1;
    }
    const duplicatedInvoiceNumbers = new Set(Object.entries(invoiceNumberCount)
        .filter(([_, count]) => count > 1)
        .map(([invNum]) => invNum));
    let dupSkipCount = 0;
    const candidates = bills.filter(bill => {
        if (duplicatedInvoiceNumbers.has(String(bill.invoiceNumber))) {
            dupSkipCount++;
            return false;
        }
        return true;
    });
    const staged = [];
    let skippedCount = dupSkipCount;
    const skipReasons = {
        ...(dupSkipCount > 0 ? { duplicate_invoice_number: dupSkipCount } : {})
    };
    function markSkip(doc, reason) {
        doc.ns_skip = true;
        doc.ns_skip_reason = reason;
        skippedCount++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        logger_config_1.default.warn(`[Credit Bill Stage][SKIP] PO: ${doc.po_number} | Invoice: ${doc.invoice_number} | Reason: ${reason}`);
    }
    // Gather keys for bulk queries
    const poNums = candidates.map(b => Number(b.poNumber));
    const invNums = candidates.map(b => String(b.invoiceNumber));
    logger_config_1.default.info(`[Credit Bill Stage Dummy] Performing bulk database lookups for ${candidates.length} bills...`);
    const [poDocsArray, billDocsArray, existingCreditDocsArray, poManagementDocsArray] = await Promise.all([
        poCollection.find({ po_number: { $in: poNums } }).toArray(),
        billCollection.find({ po_number: { $in: poNums } }).toArray(),
        collection.find({
            po_number: { $in: poNums },
            invoice_number: { $in: invNums }
        })
            .project({ ...Object.fromEntries(BILL_CONTENT_FIELDS.map(f => [f, 1])), _id: 0 })
            .toArray(),
        poManagementCol.find({
            $or: [
                { po_number: { $in: poNums } },
                { po_number: { $in: poNums.map(String) } }
            ]
        }).toArray()
    ]);
    const poDocMap = new Map(poDocsArray.map(d => [d.po_number, d]));
    const billDocMap = new Map(billDocsArray.map(d => [d.po_number, d]));
    const poManagementMap = new Map(poManagementDocsArray.map(d => [Number(d.po_number), d]));
    const existingCreditMap = new Map(existingCreditDocsArray.map(d => [`${d.po_number}-${d.invoice_number}`, d]));
    logger_config_1.default.info(`[Credit Bill Stage Dummy] Processing staging data in memory...`);
    for (const bill of candidates) {
        const poNum = Number(bill.poNumber);
        const invNum = String(bill.invoiceNumber);
        const poDoc = poDocMap.get(poNum);
        const po_exist = !!poDoc;
        const po_sync = !!(poDoc && poDoc.ns_synced === true);
        const billDoc = billDocMap.get(poNum);
        const bill_exist = !!billDoc;
        const bill_sync = !!(billDoc && billDoc.ns_synced === true);
        const refNum = `PO${poNum}-${invNum}`;
        const vendor = resolveVendor(bill.distributor, bill.paymentType);
        const invoiceDate = toSafeDate(bill.invoiceDate);
        const dueDate = toSafeDate(bill.dueDate);
        const distKey = (bill.distributor || "").trim().toLowerCase();
        const stockingWarehouse = bill.stocking_warehouse || DISTRIBUTOR_WAREHOUSE[distKey] || "";
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
            items: [],
            summary: bill.summary ?? null,
            terms: bill.terms || "",
            payment_type: bill.paymentType || "",
            po_type: bill.poType || "",
            stocking_warehouse: stockingWarehouse,
            website_order_number: bill.websiteOrderNumber || ""
        };
        // ─── Price Reconciliation Logic ───
        const rawItems = buildItemsArray(bill.items);
        // Inject serials from po_management (bulletproof extraction)
        const poMgmtDoc = poManagementMap.get(poNum);
        let serials = [];
        if (poMgmtDoc) {
            if (poMgmtDoc.distributor_items2?.serials) {
                serials = poMgmtDoc.distributor_items2.serials;
            }
            else if (poMgmtDoc.distributor_items?.serials) {
                serials = poMgmtDoc.distributor_items.serials;
            }
            else if (poMgmtDoc.serials) {
                serials = poMgmtDoc.serials;
            }
            else if (Array.isArray(poMgmtDoc.order_items)) {
                // Try looking inside the first order item
                const firstItem = poMgmtDoc.order_items[0];
                if (firstItem) {
                    if (firstItem.distributor_items2?.serials) {
                        serials = firstItem.distributor_items2.serials;
                    }
                    else if (firstItem.serials) {
                        serials = firstItem.serials;
                    }
                }
            }
        }
        if (Array.isArray(serials) && serials.length > 0) {
            for (const item of rawItems) {
                item.serials = serials;
            }
        }
        if (poDoc && Array.isArray(poDoc.order_items)) {
            for (const bItem of rawItems) {
                const poItem = poDoc.order_items.find((p) => p.sku === bItem.sku);
                if (poItem) {
                    const billPrice = parseFloat(bItem.price);
                    const poCost = parseFloat(poItem.cost);
                    const qty = parseFloat(bItem.qty);
                    // 1. Always keep the original billed item
                    doc.items.push(bItem);
                    // 2. Add a separate price adjustment line if prices differ
                    if (Math.abs(billPrice - poCost) >= 0.01) {
                        const adjustmentAmount = (billPrice - poCost) * qty;
                        doc.items.push({
                            sku: "Price Adjustment",
                            qty: "1",
                            price: adjustmentAmount.toFixed(2)
                        });
                    }
                }
                else {
                    // No matching PO item – keep as is
                    doc.items.push(bItem);
                }
            }
        }
        else {
            // No PO document or no order_items – just use raw items
            doc.items.push(...rawItems);
        }
        if (!dueDate) {
            markSkip(doc, "no_dueDate");
        }
        else if (doc.items.length === 0) {
            markSkip(doc, "no_items");
        }
        else if (!invoiceDate) {
            markSkip(doc, "no_invoiceDate");
        }
        Object.assign(doc, { po_exist, po_sync, bill_exist, bill_sync });
        staged.push(doc);
    }
    // ── Build bulk operations (skipping already staged documents) ──────────────
    const bulkOps = [];
    let changedCount = 0;
    for (const bill of staged) {
        let changed = false;
        const existing = existingCreditMap.get(`${bill.po_number}-${bill.invoice_number}`);
        if (!existing) {
            changed = true;
        }
        else if (!isStagedBillContentEqual(bill, existing)) {
            changed = true;
        }
        else if (bill.ns_skip) {
            changed = true;
        }
        if (changed) {
            changedCount++;
        }
        // Always push to update at least the updated_at timestamp,
        // but if `changed` is true, it resets sync flags for a fresh sync.
        bulkOps.push(buildBulkOp(bill, changed));
    }
    // ── BulkWrite staged bills to suite_credit_memo_bill ──────────────────
    if (bulkOps.length > 0) {
        try {
            const CHUNK_SIZE = 500;
            for (let i = 0; i < bulkOps.length; i += CHUNK_SIZE) {
                const chunk = bulkOps.slice(i, i + CHUNK_SIZE);
                await collection.bulkWrite(chunk, { ordered: false });
            }
            logger_config_1.default.info(`[Credit Bill Stage Dummy] BulkWrite done — newly staged: ${changedCount}`);
        }
        catch (dbErr) {
            logger_config_1.default.error(`[Credit Bill Stage Dummy] BulkWrite ERROR: ${dbErr.message}`);
            if (dbErr.writeErrors) {
                logger_config_1.default.error(`[Credit Bill Stage Dummy] First write error: ${JSON.stringify(dbErr.writeErrors[0])}`);
            }
        }
    }
    logger_config_1.default.info(`[Credit Bill Stage Dummy] Done. Staged ${staged.length} bills.`);
    return {
        processed: staged.length,
        skipped: skippedCount,
        reasons: { ...skipReasons, duplicated_invoice_numbers: duplicatedInvoiceNumbers.size }
    };
};
exports.stageCreditBillsDummy = stageCreditBillsDummy;
// export const stageBills = async (): Promise<{ processed: number; skipped: number; reasons: Record<string, number> }> => {
//     log.info("[Bill Stage] Starting...");
//     const po_db = await getDb("ebp_pomanager");
//     const ns_db = await getDb("netsuite");
//     const collection = ns_db.collection<StagedBill>("suite_vendor_bill");
//     // Source: ebp_pomanager.po_bills -- invoices linked to POs
//     const bills_cursor = po_db.collection("po_bills").find({
//         invoiceType: { $in: ["Invoice", "Sales Order", "IN"] },
//         invoiceDate: { $gte: "2026-01-01" }
//     });
//     const staged: StagedBill[] = [];
//     let skippedCount = 0;
//     const skipReasons: Record<string, number> = {};
//     function markSkip(doc: StagedBill, reason: string) {
//         doc.ns_skip = true;
//         doc.ns_skip_reason = reason;
//         skippedCount++;
//         skipReasons[reason] = (skipReasons[reason] || 0) + 1;
//         console.log(`[Bill Stage][SKIP] PO: ${doc.po_number || "-"} | Invoice: ${doc.invoice_number || "-"} | Reason: ${reason}`);
//     }
//     for await (const bill of bills_cursor) {
//         // Only stage if bill has a valid poNumber
//         if (!bill.poNumber) {
//             log.warn(`[Bill Stage] Skipping bill with missing poNumber`);
//             console.log(`[Bill Stage][SKIP] PO: - | Invoice: ${bill.invoiceNumber || "-"} | Reason: no_poNumber`);
//             skippedCount++;
//             skipReasons["no_poNumber"] = (skipReasons["no_poNumber"] || 0) + 1;
//             continue;
//         }
//         // Must have invoiceNumber to form a unique key
//         if (!bill.invoiceNumber) {
//             log.warn(`[Bill Stage] PO ${bill.poNumber} missing invoiceNumber -- skipping source doc`);
//             console.log(`[Bill Stage][SKIP] PO: ${bill.poNumber} | Invoice: - | Reason: no_invoiceNumber`);
//             skippedCount++;
//             skipReasons["no_invoiceNumber"] = (skipReasons["no_invoiceNumber"] || 0) + 1;
//             continue;
//         }
//         // Check if PO exists in NetSuite via REST API
//         const poExists = await poExistsInNetSuite(bill.poNumber);
//         if (!poExists) {
//             log.warn(`[Bill Stage] PO ${bill.poNumber} does not exist in NetSuite -- skipping bill`);
//             skippedCount++;
//             skipReasons["po_not_in_netsuite"] = (skipReasons["po_not_in_netsuite"] || 0) + 1;
//             continue;
//         }
//         const poNum = Number(bill.poNumber);
//         const invNum = String(bill.invoiceNumber);
//         const refNum = `PO${poNum}-${invNum}`;
//         const vendor       = resolveVendor(bill.distributor, bill.paymentType);
//         const invoiceDate  = toSafeDate(bill.invoiceDate);
//         const dueDate      = toSafeDate(bill.dueDate);
//         const distKey      = (bill.distributor || "").trim().toLowerCase();
//         const stockingWarehouse = bill.stocking_warehouse || DISTRIBUTOR_WAREHOUSE[distKey] || "";
//         const items        = buildItemsArray(bill.items);
//         const doc: StagedBill = {
//             po_number:            poNum,
//             invoice_number:       invNum,
//             reference_number:     refNum,
//             distributor:          vendor.name,
//             vendor_id:            vendor.id,
//             invoice_type:         bill.invoiceType || "",
//             invoice_date:         invoiceDate,
//             due_date:             dueDate,
//             total_amount:         String(bill.totalAmount || "0"),
//             items,
//             summary:              bill.summary ?? null,
//             terms:                bill.terms || "",
//             payment_type:         bill.paymentType || "",
//             po_type:              bill.poType || "",
//             stocking_warehouse:   stockingWarehouse,
//             website_order_number: bill.websiteOrderNumber || ""
//         };
//         // Validation: mark skip reasons (staged but never sent to NetSuite)
//         if (!dueDate) {
//             markSkip(doc, "no_dueDate");
//         } else if (items.length === 0) {
//             markSkip(doc, "no_items");
//         } else if (!invoiceDate) {
//             markSkip(doc, "no_invoiceDate");
//         }
//         staged.push(doc);
//     }
//     log.info(`[Bill Stage] Found ${staged.length} bills (${skippedCount} marked skip: ${JSON.stringify(skipReasons)})`);
//     if (staged.length > 0) {
//         const result = await collection.bulkWrite(
//             staged.map(bill => buildBulkOp(bill, bill._changed || false)) as any
//         );
//         log.info(`[Bill Stage] BulkWrite done — upserted: ${result.upsertedCount}, modified: ${result.modifiedCount}`);
//     }
//     log.info(`[Bill Stage] Staged ${staged.length} bills to netsuite.suite_vendor_bill`);
//     return { processed: staged.length, skipped: skippedCount, reasons: skipReasons };
// };
async function runFunctionForBills() {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const DUMP_COL = "dump_bill";
        const SUITE_COL = "suite_vendor_bill_dummy";
        // 1. Get all dump Bills
        const dumpDocs = await ns_db.collection(DUMP_COL)
            .find({})
            .project({ "bill.tranid": 1 })
            .toArray();
        // 2. Build Set of dump bill reference numbers
        const dumpSet = new Set();
        for (const doc of dumpDocs) {
            let tranId = doc.bill?.tranid;
            if (!tranId)
                continue;
            const refNum = String(tranId).trim().toUpperCase();
            if (refNum) {
                dumpSet.add(refNum);
            }
        }
        // 3. Get all dummy Bills
        const suiteDocs = await ns_db.collection(SUITE_COL)
            .find({})
            .project({ reference_number: 1, ns_synced: 1 })
            .toArray();
        const dummySet = new Set();
        const unsyncedDummySet = new Set();
        const ghostBills = [];
        for (const doc of suiteDocs) {
            const refNum = String(doc.reference_number || "").trim().toUpperCase();
            if (!refNum)
                continue;
            dummySet.add(refNum);
            if (doc.ns_synced !== true) {
                unsyncedDummySet.add(refNum);
            }
            // Check 2: Exist in dummy and ns_synced: true but not in dump_bill
            if (doc.ns_synced === true && !dumpSet.has(refNum)) {
                ghostBills.push(doc.reference_number);
            }
        }
        // Check 1: Exist in dump_bill and not in dummy at all
        const onlyInDump = [];
        for (const refNum of dumpSet) {
            if (!dummySet.has(refNum)) {
                onlyInDump.push(refNum);
            }
        }
        // Check 3: Exist in dump_bill but in dummy their ns_synced is false
        const existInDumpButUnsyncedInDummy = [];
        for (const refNum of dumpSet) {
            if (unsyncedDummySet.has(refNum)) {
                existInDumpButUnsyncedInDummy.push(refNum);
            }
        }
        // 5. Print results
        console.log(`\n======================================================`);
        console.log(`📊 BILL DUMP VS DUMMY RECONCILIATION REPORT`);
        console.log(`======================================================`);
        console.log(`Bills only in Dump (Exist in dump_bill, not in dummy at all): ${onlyInDump.length}`);
        console.log(onlyInDump);
        console.log(`\nBills in Dump but in Dummy their ns_synced is false: ${existInDumpButUnsyncedInDummy.length}`);
        console.log(existInDumpButUnsyncedInDummy);
        console.log(`\nGhost Bills (Exist in dummy with ns_synced: true, not in dump_bill): ${ghostBills.length}`);
        console.log(ghostBills);
        console.log(`======================================================\n`);
    }
    catch (err) {
        console.error("Error >>>", err);
    }
}
