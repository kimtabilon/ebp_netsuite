"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncStagedDummyBillsOnce = exports.retryFailedBills = exports.syncBillsToNetsuite = void 0;
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_client_1 = require("./netsuite.client");
const sync_config_1 = require("../config/sync.config");
const concurrency_config_1 = require("../config/concurrency.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const PARALLEL_WORKERS = 2;
const BILL_BATCH = 10;
// Errors that should never be retried -- mark as permanently failed immediately
const PERMANENT_ERRORS = [
    "PO not found for otherrefnum",
    "No billable PO found",
    "Missing po_number",
    "STRICT_SKU_MISMATCH"
];
function isPermanentError(error) {
    return PERMANENT_ERRORS.some(pe => error.includes(pe));
}
const syncBillsToNetsuite = async () => {
    logger_config_1.default.info(`[NS Bill Sync] Starting -- mode: ${sync_config_1.SYNC_MODE_BILL}, workers: ${PARALLEL_WORKERS}, stopOnError: ${sync_config_1.STOP_ON_ERROR}`);
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const billCollection = ns_db.collection("suite_vendor_bill");
    const poCollection = ns_db.collection("suite_purchase_order");
    // Base filter: not synced, not failed, not skipped, and must have po_number
    const filter = {
        ns_synced: { $ne: true },
        ns_failed: { $ne: true },
        ns_skip: { $ne: true },
        po_number: { $exists: true, $ne: null },
    };
    // Fetch all eligible bills (no batch limit here)
    const allBills = await billCollection.find(filter).toArray();
    if (allBills.length === 0) {
        logger_config_1.default.info("[NS Bill Sync] No bills to process. Skipping.");
        console.log("[NS Bill Sync] No bills to process. Skipping.");
        return [];
    }
    // -- PO dependency check: only sync bills whose PO is confirmed created --
    const poNumbers = Array.from(new Set(allBills.map((b) => b.po_number)));
    const syncedPOs = await poCollection
        .find({ po_number: { $in: poNumbers }, ns_synced: true, ns_result: "created" })
        .project({ po_number: 1 })
        .toArray();
    const syncedPOSet = new Set(syncedPOs.map((p) => p.po_number));
    // Only process up to BILL_BATCH bills that have synced POs
    const readyBills = allBills.filter((b) => syncedPOSet.has(b.po_number)).slice(0, BILL_BATCH);
    const waitingBills = allBills.length - readyBills.length;
    if (waitingBills > 0) {
        logger_config_1.default.info(`[NS Bill Sync] ${waitingBills} bills waiting -- PO not synced yet (will retry next cycle)`);
    }
    if (readyBills.length === 0) {
        logger_config_1.default.info("[NS Bill Sync] No bills with synced POs. Skipping.");
        return [];
    }
    logger_config_1.default.info(`[NS Bill Sync] ${readyBills.length} bills ready (${syncedPOs.length} POs synced)${sync_config_1.TEST_MODE ? " (TEST MODE)" : ""}`);
    logger_config_1.default.info(`${readyBills}`);
    if (sync_config_1.TEST_MODE || sync_config_1.STOP_ON_ERROR) {
        return syncSerial(billCollection, readyBills);
    }
    // -- Parallel sync with worker pool --
    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results = [];
    let index = 0;
    async function worker() {
        while (index < readyBills.length) {
            const i = index++;
            const entry = await syncOneBill(billCollection, readyBills[i]);
            results[i] = entry;
            if (entry.action === "skipped") {
                skipped++;
                logger_config_1.default.warn(`[NS Bill Sync] Bill ${readyBills[i]} skipped: ${entry.error}`);
            }
            else if (entry.success === false)
                errors++;
            else
                sent++;
        }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_WORKERS, readyBills.length) }, () => worker()));
    logger_config_1.default.info(`[NS Bill Sync] Done -- sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${readyBills.length}`);
    // Console summary for test/debug
    const failed = results.filter(r => r.success === false);
    const failedReasons = {};
    failed.forEach(r => {
        if (r.error) {
            failedReasons[r.error] = (failedReasons[r.error] || 0) + 1;
        }
    });
    console.log(`[NS Bill Sync] Summary: sent=${sent}, skipped=${skipped}, errors=${errors}, total=${readyBills.length}`);
    if (Object.keys(failedReasons).length > 0) {
        console.log('[NS Bill Sync] Failure reasons:', failedReasons);
    }
    return results;
};
exports.syncBillsToNetsuite = syncBillsToNetsuite;
// -- Process a single bill: RESTlet call + MongoDB status update --
async function syncOneBill(collection, bill) {
    console.log(`[NS Bill Sync] Processing bill ${bill.reference_number || bill._id} (PO ${bill.po_number})`);
    const t0 = Date.now();
    const ref = bill.reference_number || `PO${bill.po_number}-${bill.invoice_number}`;
    try {
        console.log("Trying the sync one bill -------");
        // Extract summary fields for NetSuite sync
        const freight = bill.summary?.Freight || 0;
        const salesTax = bill.summary?.SalesTax || 0;
        const shipping = bill.summary?.Shipping || 0;
        let result = await (0, concurrency_config_1.withConcurrency)(() => (0, netsuite_client_1.postToNetsuiteForBill)({
            action: sync_config_1.SYNC_MODE_BILL,
            po_number: bill.po_number,
            invoice_number: bill.invoice_number,
            reference_number: ref,
            invoice_date: bill.invoice_date,
            due_date: bill.due_date,
            line_items: bill.items,
            po_type: bill.po_type || "",
            stocking_warehouse: bill.stocking_warehouse || "",
            freight,
            salesTax,
            shipping
        }), `Bill ${ref}`);
        let poItemSkuUsed = false;
        let duplicatedPoExists = false;
        // -- Fallback Logic: If first attempt fails due to SKU mismatch, try PO Item SKU --
        if (result.success === false && (String(result.error).includes("No matching lines") || result.error_code === "STRICT_SKU_MISMATCH")) {
            logger_config_1.default.info(`[NS Bill Sync] SKU mismatch detected for ${ref} (${result.error_code || "partial"}). Attempting PO Item SKU fallback...`);
            const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
            const poCollection = ns_db.collection("suite_purchase_order_dummy");
            const allMatchingPOs = await poCollection.find({ po_number: bill.po_number }).toArray();
            let targetPO = null;
            if (allMatchingPOs.length > 1) {
                // Filter by distributor if there's a duplication
                const distributorPOs = allMatchingPOs.filter(p => String(p.distributor || "").trim().toLowerCase() === String(bill.distributor || "").trim().toLowerCase());
                if (distributorPOs.length === 1) {
                    targetPO = distributorPOs[0];
                }
                else {
                    duplicatedPoExists = true;
                    logger_config_1.default.warn(`[NS Bill Sync] Could not resolve unique PO for ${bill.po_number} (matches: ${allMatchingPOs.length}, same-distributor: ${distributorPOs.length})`);
                }
            }
            else if (allMatchingPOs.length === 1) {
                targetPO = allMatchingPOs[0];
            }
            if (targetPO && targetPO.ns_synced) {
                const poItems = targetPO.order_items || [];
                const fallbackItems = JSON.parse(JSON.stringify(bill.items));
                let changedCount = 0;
                for (let i = 0; i < fallbackItems.length; i++) {
                    if (poItems[i] && fallbackItems[i].sku !== poItems[i].sku) {
                        logger_config_1.default.info(`[NS Bill Sync] Swapping SKU for retry: ${fallbackItems[i].sku} -> ${poItems[i].sku}`);
                        fallbackItems[i].sku = poItems[i].sku;
                        changedCount++;
                    }
                }
                if (changedCount > 0) {
                    logger_config_1.default.info(`[NS Bill Sync] Retrying with ${changedCount} swapped SKUs for ${ref}`);
                    const retryResult = await (0, concurrency_config_1.withConcurrency)(() => (0, netsuite_client_1.postToNetsuiteForBill)({
                        action: sync_config_1.SYNC_MODE_BILL,
                        po_number: bill.po_number,
                        invoice_number: bill.invoice_number,
                        reference_number: ref,
                        invoice_date: bill.invoice_date,
                        due_date: bill.due_date,
                        line_items: fallbackItems,
                        po_type: bill.po_type || "",
                        stocking_warehouse: bill.stocking_warehouse || "",
                        freight,
                        salesTax,
                        shipping
                    }), `PO ${bill.po_number}`);
                    if (retryResult.success !== false) {
                        result = retryResult;
                        poItemSkuUsed = true;
                    }
                    else {
                        result = retryResult;
                    }
                }
            }
        }
        const ms = Date.now() - t0;
        if (result.success === false) {
            const errorStr = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
            logger_config_1.default.error(`[NS Bill Sync] Failed: ${ref} -> ${errorStr} (${ms}ms)`);
            // Permanent errors: skip immediately, don't waste retries
            if (isPermanentError(errorStr)) {
                await markPermanentSkip(collection, bill, errorStr);
                return { reference_number: ref, success: false, error: errorStr, ms, permanent: true };
            }
            // Update record with duplicate PO status even on failure
            await collection.updateOne({ _id: bill._id }, { $set: { duplicated_po_exists: duplicatedPoExists } });
            await markFailed(collection, bill, result.error);
            return { reference_number: ref, success: false, error: errorStr, ms };
        }
        // Save rich result from RESTlet (bill ID, line breakdown, unmatched SKUs)
        const syncUpdate = {
            ns_synced: true,
            ns_synced_at: new Date(),
            ns_result: result.action,
            po_item_sku: poItemSkuUsed,
            duplicated_po_exists: duplicatedPoExists
        };
        // Persist NetSuite bill internal ID for reference
        if (result.bill?.internalId) {
            syncUpdate.ns_bill_id = result.bill.internalId;
        }
        // Persist line breakdown for audit
        if (result.lines) {
            syncUpdate.ns_lines = result.lines;
        }
        // Persist unmatched SKUs so we can see what invoice items weren't on the PO
        if (result.unmatchedSkus && result.unmatchedSkus.length > 0) {
            syncUpdate.ns_unmatched_skus = result.unmatchedSkus;
        }
        await markSynced(collection, bill, syncUpdate);
        const lineInfo = result.lines ? ` (lines: ${result.lines.updated} kept, ${result.lines.removed} removed, final ${result.lines.final})` : "";
        logger_config_1.default.info(`[NS Bill Sync] Synced: ${ref} -> ${result.action}${lineInfo} (${ms}ms)`);
        return { reference_number: ref, ...result, ms };
    }
    catch (e) {
        const ms = Date.now() - t0;
        const rawErr = e?.response?.data || e.message;
        const errMsg = typeof rawErr === "string" ? rawErr : JSON.stringify(rawErr);
        logger_config_1.default.error(`[NS Bill Sync] Error: ${ref}: ${errMsg} (${ms}ms)`);
        if (isPermanentError(errMsg)) {
            await markPermanentSkip(collection, bill, errMsg);
            return { reference_number: ref, success: false, error: errMsg, ms, permanent: true };
        }
        await markFailed(collection, bill, rawErr);
        return { reference_number: ref, success: false, error: errMsg, ms };
    }
}
async function markSynced(collection, bill, syncUpdate) {
    await collection.updateOne({ _id: bill._id }, {
        $set: syncUpdate,
        $unset: {
            ns_error: "",
            ns_error_at: "",
            ns_retry_count: "",
            ns_failed: "",
            ns_skip_reason: ""
        }
    });
}
// -- Serial fallback for TEST_MODE / STOP_ON_ERROR --
async function syncSerial(collection, bills) {
    let sent = 0, errors = 0, skipped = 0;
    const results = [];
    for (const bill of bills) {
        const entry = await syncOneBill(collection, bill);
        results.push(entry);
        if (entry.action === "skipped") {
            skipped++;
            continue;
        }
        if (entry.success === false) {
            errors++;
            if (sync_config_1.STOP_ON_ERROR) {
                logger_config_1.default.error("[NS Bill Sync] STOP_ON_ERROR -- halting.");
                break;
            }
            continue;
        }
        sent++;
        if (sync_config_1.TEST_MODE) {
            logger_config_1.default.info("[NS Bill Sync] TEST_MODE -- stopping after first.");
            break;
        }
    }
    logger_config_1.default.info(`[NS Bill Sync] Done -- sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${bills.length}`);
    return results;
}
// --- Mark bill as failed with retry tracking ---
async function markFailed(collection, bill, error) {
    const retryCount = (bill.ns_retry_count || 0) + 1;
    const permanentlyFailed = retryCount >= sync_config_1.MAX_RETRIES;
    const update = {
        $set: {
            ns_synced: false,
            ns_error: typeof error === "string" ? error : JSON.stringify(error),
            ns_error_at: new Date(),
            ns_retry_count: retryCount,
        }
    };
    if (permanentlyFailed) {
        update.$set.ns_failed = true;
        logger_config_1.default.error(`[NS Bill Sync] Bill ${bill.reference_number} exceeded ${sync_config_1.MAX_RETRIES} retries -- marked as permanently failed.`);
    }
    await collection.updateOne({ _id: bill._id }, update);
}
// --- Mark bill as permanently skipped (not retriable) ---
async function markPermanentSkip(collection, bill, error) {
    await collection.updateOne({ _id: bill._id }, {
        $set: {
            ns_synced: false,
            ns_failed: true,
            ns_error: error,
            ns_error_at: new Date(),
            ns_skip_reason: "permanent_error"
        }
    });
    logger_config_1.default.warn(`[NS Bill Sync] Bill ${bill.reference_number} permanently failed: ${error}`);
}
// --- Retry failed bills ---
const retryFailedBills = async (resetAll = false) => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_vendor_bill");
    const filter = resetAll
        ? { $or: [{ ns_synced: false, ns_error: { $exists: true } }, { ns_failed: true }] }
        : { ns_synced: false, ns_error: { $exists: true }, ns_failed: { $ne: true } };
    const failedBills = await collection.find(filter).toArray();
    if (failedBills.length === 0) {
        return { message: "No failed bills to retry.", count: 0 };
    }
    const result = await collection.updateMany({ _id: { $in: failedBills.map((b) => b._id) } }, {
        $set: { ns_synced: false },
        $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "", ns_skip_reason: "" }
    });
    const billList = failedBills.map((b) => ({
        reference_number: b.reference_number,
        previousError: b.ns_error,
        retryCount: b.ns_retry_count || 0
    }));
    return {
        message: `Reset ${result.modifiedCount} failed bills for retry.`,
        count: result.modifiedCount,
        bills: billList
    };
};
exports.retryFailedBills = retryFailedBills;
// Fetch all eligible bills (no batch limit here)
const syncStagedDummyBillsOnce = async () => {
    logger_config_1.default.info(`[NS Bill Sync] Starting -- mode: ${sync_config_1.SYNC_MODE_BILL}, workers: ${PARALLEL_WORKERS}, stopOnError: ${sync_config_1.STOP_ON_ERROR}`);
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const billCollection = ns_db.collection("suite_vendor_bill_dummy");
    const poCollection = ns_db.collection("suite_purchase_order_dummy");
    // Base filter: not synced, not failed, not skipped, and must have po_number
    const filter = {
        ns_synced: { $exists: false },
        ns_skip: { $ne: true },
        po_number: { $exists: true, $ne: null }
    };
    const allBills = await billCollection.find(filter).toArray();
    if (allBills.length === 0) {
        logger_config_1.default.info("[NS Bill Sync] No bills to process. Skipping.");
        console.log("[NS Bill Sync] No bills to process. Skipping.");
        return [];
    }
    console.log("All Bills ", allBills.length);
    const poNumbers = Array.from(new Set(allBills.map((b) => b.po_number)));
    const syncedPOs = await poCollection
        .find({ po_number: { $in: poNumbers }, ns_synced: true, })
        .project({ po_number: 1 })
        .toArray();
    const syncedPOSet = new Set(syncedPOs.map((p) => p.po_number));
    console.log("syncedPOSet", syncedPOs?.length);
    // Process all eligible bills with synced POs (no batch limit)
    const readyBills = allBills.filter((b) => syncedPOSet.has(b.po_number));
    const waitingBills = allBills.length - readyBills.length;
    if (waitingBills > 0) {
        logger_config_1.default.info(`[NS Bill Sync] ${waitingBills} bills waiting -- PO not synced yet (will retry next cycle)`);
    }
    if (readyBills.length === 0) {
        logger_config_1.default.info("[NS Bill Sync] No bills with synced POs. Skipping.");
        return [];
    }
    console.log("syncedPOSet", readyBills?.length);
    console.log("syncedPOSet", waitingBills);
    if (sync_config_1.TEST_MODE || sync_config_1.STOP_ON_ERROR) {
        return syncSerial(billCollection, readyBills);
    }
    // Group bills by PO number to prevent concurrency errors (collision) on the same PO
    const poGroups = {};
    readyBills.forEach((bill, i) => {
        if (!poGroups[bill.po_number])
            poGroups[bill.po_number] = [];
        poGroups[bill.po_number].push({ bill, i });
    });
    const uniquePoKeys = Object.keys(poGroups);
    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results = [];
    let groupIndex = 0;
    async function worker() {
        while (groupIndex < uniquePoKeys.length) {
            const gi = groupIndex++;
            const billsInGroup = poGroups[uniquePoKeys[gi]];
            // Process all bills for this PO sequentially
            for (const item of billsInGroup) {
                const entry = await syncOneBill(billCollection, item.bill);
                results[item.i] = entry;
                if (entry.action === "skipped") {
                    skipped++;
                    logger_config_1.default.warn(`[NS Bill Sync] Bill ${item.bill.reference_number || item.bill._id} skipped: ${entry.error}`);
                }
                else if (entry.success === false) {
                    errors++;
                }
                else {
                    sent++;
                }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_WORKERS, uniquePoKeys.length) }, () => worker()));
    logger_config_1.default.info(`[NS Bill Sync] Done -- sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${readyBills.length}`);
    // Console summary for test/debug
    const failed = results.filter(r => r.success === false);
    const failedReasons = {};
    failed.forEach(r => {
        if (r.error) {
            failedReasons[r.error] = (failedReasons[r.error] || 0) + 1;
        }
    });
    console.log(`[NS Bill Sync] Summary: sent=${sent}, skipped=${skipped}, errors=${errors}, total=${readyBills.length}`);
    if (Object.keys(failedReasons).length > 0) {
        console.log('[NS Bill Sync] Failure reasons:', failedReasons);
    }
    return results;
};
exports.syncStagedDummyBillsOnce = syncStagedDummyBillsOnce;
