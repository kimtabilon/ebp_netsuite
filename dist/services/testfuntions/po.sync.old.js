"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pOSWithError = exports.batchSyncDummyToSuitePO = exports.retryFailedPurchaseOrders = void 0;
const mongdodb_config_1 = require("../../config/mongdodb.config");
const netsuite_client_1 = require("./../netsuite.client");
const sync_config_1 = require("../../config/sync.config");
const concurrency_config_1 = require("../../config/concurrency.config");
const logger_config_1 = __importDefault(require("../../config/logger.config"));
const axios_1 = __importDefault(require("axios"));
// ── Governance budget ────────────────────────────────────────────────────────
// RESTlet limit: 5,000 units/invocation
// Stocking PO:  ~42 units (4 SKUs)  → ~119 POs per invocation (never hit — 1 PO/call)
// Dropship PO:  ~77 units (1 SKU)   → ~64 POs per invocation  (never hit — 1 PO/call)
// Each HTTP call = 1 RESTlet invocation, so governance is never a concern.
// Batch limits below control server-side concurrency + NetSuite rate limits.
const PARALLEL_WORKERS = 1;
const BATCH_SIZE = 10; // POs per RESTlet call (batch mode)
const STOCKING_BATCH = 200; // raised — fewer HTTP calls now
const DROPSHIP_BATCH = 200; // raised — fewer HTTP calls now
// Results we consider fully resolved and should never re-queue
// (matches the pattern in sales_order.sync.ts)
const RESOLVED_RESULTS = ["created", "updated", "no_items", "skipped_no_po_number"];
// Parse created_at safely — sends "M/D/YYYY" to avoid UTC→timezone date shift.
// NetSuite trandate only needs a date, not a time.
function toSafeISO(raw) {
    if (!raw)
        return "";
    const d = new Date(String(raw).replace(" ", "T"));
    if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2030)
        return "";
    // Extract local date parts to avoid timezone offset shifting the day
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
// export const syncPurchaseOrdersToNetsuite = async (): Promise<any[]> => {
//     log.info(`[NS PO Sync] Starting purchase order sync — mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, batchSize: ${BATCH_SIZE}, stopOnError: ${STOP_ON_ERROR}`);
//     const ns_db = await getDb("netsuite");
//     const collection = ns_db.collection("suite_purchase_order_dummy");
//     const soCollection = ns_db.collection("suite_sales_order");
//     // Base filter: skip permanently failed and already-resolved POs.
//     // update mode: re-queue everything except resolved and permanently failed
//     // skip mode:   only pick up unsynced POs
//     const baseFilter = { ns_synced: { $exists: false } };
//     // ── Phase 1: Stocking POs (no SO dependency) ────────────────────────
//     const stockingOrders = await collection
//         .find({ ...baseFilter, po_type: { $ne: "Dropship" } })
//         .limit(STOCKING_BATCH)
//         .toArray();
//     // ── Phase 2: Dropship POs (only if SO is synced) ────────────────────
//     // Strategy: find synced SO order numbers first, then fetch matching POs.
//     // Old approach fetched first N POs and hoped some had synced SOs — failed
//     // when early POs in natural order all lacked synced SOs.
//     let dropshipOrders: any[] = [];
//     const syncedSOs = await soCollection
//         .find({ ns_synced: true, ns_result: "created" })
//         .project({ otherrefnum: 1 })
//         .toArray();
//     if (syncedSOs.length > 0) {
//         const syncedOrderNumbers = syncedSOs.map((s: any) => s.otherrefnum);
//         dropshipOrders = await collection
//             .find({
//                 ...baseFilter,
//                 po_type: "Dropship",
//                 website_order_number: { $in: syncedOrderNumbers }
//             })
//             .limit(DROPSHIP_BATCH)
//             .toArray();
//         log.info(`[NS PO Sync] Dropship: ${syncedSOs.length} synced SOs, ${dropshipOrders.length} POs ready`);
//     }
//     const orders = [...stockingOrders, ...dropshipOrders];
//     if (orders.length === 0) {
//         log.info("[NS PO Sync] No unsynced purchase orders. Skipping.");
//         return [];
//     }
//     log.info(`[NS PO Sync] Found ${orders.length} POs to process${TEST_MODE ? " (TEST MODE)" : ""}`);
//     // In TEST_MODE or STOP_ON_ERROR, fall back to serial processing
//     if (TEST_MODE || STOP_ON_ERROR) {
//         return syncSerial(collection, orders);
//     }
//     // ── Split orders into batches of BATCH_SIZE ───────────────────────────
//     const batches: any[][] = [];
//     for (let i = 0; i < orders.length; i += BATCH_SIZE) {
//         batches.push(orders.slice(i, i + BATCH_SIZE));
//     }
//     log.info(`[NS PO Sync] Split ${orders.length} POs into ${batches.length} batches of up to ${BATCH_SIZE}`);
//     // ── Parallel sync with worker pool (one batch per worker iteration) ──
//     let sent = 0;
//     let errors = 0;
//     let skipped = 0;
//     const results: any[] = [];
//     let batchIndex = 0;
//     async function worker() {
//         while (batchIndex < batches.length) {
//             const bi = batchIndex++;
//             const batchResults = await syncBatchPO(collection, batches[bi]);
//             for (const entry of batchResults) {
//                 results.push(entry);
//                 if (entry.action === "no_items" || entry.action === "skipped") skipped++;
//                 else if (entry.success === false) errors++;
//                 else sent++;
//             }
//         }
//     }
//     await Promise.all(
//         Array.from({ length: Math.min(PARALLEL_WORKERS, batches.length) }, () => worker())
//     );
//     log.info(`[NS PO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}, batches: ${batches.length}`);
//     return results;
// };
// ── Process a batch of POs: single RESTlet call + per-PO MongoDB updates ──────
async function syncBatchPO(collection, batch) {
    const t0 = Date.now();
    const results = [];
    // Build payloads & filter out invalid POs
    const validPOs = [];
    const payloads = [];
    for (const po of batch) {
        if (!po.po_number && po.po_number !== 0) {
            logger_config_1.default.warn(`[NS PO Sync] Skipping PO _id=${po._id} — missing po_number`);
            await collection.updateOne({ _id: po._id }, { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "skipped_no_po_number" } });
            results.push({ po_number: null, success: true, action: "skipped", reason: "missing_po_number" });
            continue;
        }
        validPOs.push(po);
        payloads.push({
            action: sync_config_1.SYNC_MODE_PO,
            po_number: po.po_number,
            otherrefnum: String(po.po_number),
            vendor_id: po.vendor_id,
            distributor: po.distributor,
            distributor_order_number: po.distributor_order_number,
            status: po.status,
            invoice: po.invoice,
            tracking: po.tracking,
            order_items: po.order_items,
            website_order_number: po.website_order_number,
            po_type: po.po_type || "",
            stocking_warehouse: po.stocking_warehouse || "",
            created_at: toSafeISO(po.created_at)
        });
    }
    if (payloads.length === 0)
        return results;
    try {
        // Single HTTP call for the entire batch via concurrency semaphore
        const batchLabel = `PO batch [${validPOs.map((p) => p.po_number).join(",")}]`;
        const response = await (0, concurrency_config_1.withConcurrency)(() => (0, netsuite_client_1.postBatchToNetsuiteForPO)(payloads), batchLabel);
        const ms = Date.now() - t0;
        // Defensive: RESTlet always returns { results: [...] } in batch mode
        let nsResults = [];
        if (response && Array.isArray(response.results)) {
            nsResults = response.results;
        }
        else if (Array.isArray(response.batch)) {
            // Some RESTlet versions may return { batch: [...] }
            nsResults = response.batch;
        }
        else if (Array.isArray(response)) {
            nsResults = response;
        }
        else {
            logger_config_1.default.error(`[NS PO Sync] Unexpected batch response format`, response);
        }
        logger_config_1.default.debug(`[NS PO Sync] Batch response result:`, nsResults);
        logger_config_1.default.debug(`[NS PO Sync] Batch response:`, response);
        // Process each result from the batch response
        for (let i = 0; i < validPOs.length; i++) {
            const po = validPOs[i];
            const result = nsResults[i];
            logger_config_1.default.debug(`Result for PO ${po.po_number}:`, result);
            if (!result) {
                // No result for this PO — shouldn't happen but handle gracefully
                logger_config_1.default.error(`[NS PO Sync] No result for PO ${po.po_number} in batch response`);
                await markFailed(collection, po, "no_result_in_batch");
                results.push({ po_number: po.po_number, success: false, error: "no_result_in_batch", ms });
                continue;
            }
            // Governance exhausted — RESTlet couldn't process this PO
            if (result.error === "governance_exhausted") {
                logger_config_1.default.warn(`[NS PO Sync] Governance exhausted for PO ${po.po_number} — will retry next cycle`);
                results.push({ po_number: po.po_number, success: false, error: "governance_exhausted", ms });
                continue;
            }
            // no_items = SKUs not found in NetSuite — mark as error
            if (result.action === "no_items") {
                logger_config_1.default.error(`[NS PO Sync] No items — failed: ${po.po_number}`);
                await markFailed(collection, po, "no_items");
                results.push({ po_number: po.po_number, success: false, error: "no_items", ms });
                continue;
            }
            // NetSuite returned success: false
            if (result.success === false) {
                logger_config_1.default.error(`[NS PO Sync] Failed: ${po.po_number} → ${result.error}`);
                await markFailed(collection, po, result.error);
                results.push({ po_number: po.po_number, success: false, error: result.error, ms });
                continue;
            }
            // Mark as synced
            await markSynced(collection, po, { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action });
            logger_config_1.default.info(`[NS PO Sync] Synced: ${po.po_number} → ${result.action}`);
            results.push({ po_number: po.po_number, ...result, ms });
        }
        logger_config_1.default.info(`[NS PO Sync] Batch of ${validPOs.length} completed in ${ms}ms`);
    }
    catch (e) {
        const ms = Date.now() - t0;
        const errMsg = e?.response?.data || e.message;
        logger_config_1.default.error(`[NS PO Sync] Batch call failed (${ms}ms): ${errMsg} — falling back to individual calls`);
        // Fallback: process each PO individually
        for (const po of validPOs) {
            const entry = await syncOnePO(collection, po);
            results.push(entry);
        }
    }
    return results;
}
// ── Process a single PO: RESTlet call + MongoDB status update ─────────────
async function syncOnePO(collection, po) {
    const t0 = Date.now();
    // Guard: skip POs without a valid po_number — prevents ghost records in NetSuite
    if (!po.po_number && po.po_number !== 0) {
        logger_config_1.default.warn(`[NS PO Sync] Skipping PO _id=${po._id} — missing po_number`);
        await collection.updateOne({ _id: po._id }, { $set: { ns_synced: true, ns_synced_at: new Date(), ns_result: "skipped_no_po_number" } });
        return { po_number: null, success: true, action: "skipped", reason: "missing_po_number" };
    }
    try {
        const result = await (0, concurrency_config_1.withConcurrency)(() => (0, netsuite_client_1.postToNetsuiteForPO)({
            action: sync_config_1.SYNC_MODE_PO,
            po_number: po.po_number,
            otherrefnum: String(po.po_number),
            vendor_id: po.vendor_id,
            distributor: po.distributor,
            distributor_order_number: po.distributor_order_number,
            status: po.status,
            invoice: po.invoice,
            tracking: po.tracking,
            order_items: po.order_items,
            website_order_number: po.website_order_number,
            po_type: po.po_type || "",
            stocking_warehouse: po.stocking_warehouse || "",
            created_at: toSafeISO(po.created_at)
        }), `PO ${po.po_number}`);
        const ms = Date.now() - t0;
        // no_items = SKUs not found in NetSuite — mark as error
        if (result.action === "no_items") {
            logger_config_1.default.error(`[NS PO Sync] No items — failed: ${po.po_number} (${ms}ms)`);
            await markFailed(collection, po, "no_items");
            return { po_number: po.po_number, success: false, error: "no_items", ms };
        }
        // If NetSuite returned success: false
        if (result.success === false) {
            logger_config_1.default.error(`[NS PO Sync] Failed: ${po.po_number} → ${result.error} (${ms}ms)`);
            await markFailed(collection, po, result.error);
            return { po_number: po.po_number, success: false, error: result.error, ms };
        }
        // Mark as synced
        await markSynced(collection, po, { ns_synced: true, ns_synced_at: new Date(), ns_result: result.action });
        logger_config_1.default.info(`[NS PO Sync] Synced: ${po.po_number} → ${result.action} (${ms}ms)`);
        return { po_number: po.po_number, ...result, ms };
    }
    catch (e) {
        const ms = Date.now() - t0;
        const errMsg = e?.response?.data || e.message;
        logger_config_1.default.error(`[NS PO Sync] Error: ${po.po_number}: ${errMsg} (${ms}ms)`);
        await markFailed(collection, po, errMsg);
        return { po_number: po.po_number, success: false, error: errMsg, ms };
    }
}
async function markSynced(collection, doc, update) {
    await collection.updateOne({ _id: doc._id }, {
        $set: update,
        $unset: {
            ns_error: "",
            ns_error_at: "",
            ns_retry_count: "",
            ns_failed: "",
            ns_skip_reason: ""
        }
    });
}
// ── Serial fallback for TEST_MODE / STOP_ON_ERROR ─────────────────────────
async function syncSerial(collection, orders) {
    let sent = 0, errors = 0, skipped = 0;
    const results = [];
    for (const po of orders) {
        const entry = await syncOnePO(collection, po);
        results.push(entry);
        if (entry.action === "no_items" || entry.action === "skipped") {
            skipped++;
            continue;
        }
        if (entry.success === false) {
            errors++;
            if (sync_config_1.STOP_ON_ERROR) {
                logger_config_1.default.error(`[NS PO Sync] STOP_ON_ERROR — halting batch.`);
                break;
            }
            continue;
        }
        sent++;
        if (sync_config_1.TEST_MODE) {
            logger_config_1.default.info(`[NS PO Sync] TEST_MODE — stopping after first insert/update`);
            break;
        }
    }
    logger_config_1.default.info(`[NS PO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
    return results;
}
// ─── Mark order as failed with retry tracking ────────────────────────────────
async function markFailed(collection, order, error) {
    const retryCount = (order.ns_retry_count || 0) + 1;
    const permanentlyFailed = true; //retryCount >= MAX_RETRIES;
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
        logger_config_1.default.error(`[NS PO Sync] PO ${order.po_number} no retries — marked as permanently failed.`);
        console.error(`Purchase order sync failed for PO #${order.po_number}:`, error);
    }
    await collection.updateOne({ _id: order._id }, update);
}
// ─── Retry failed POs ────────────────────────────────────────────────────────
const retryFailedPurchaseOrders = async (resetAll = false) => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_purchase_order_dummy");
    const filter = resetAll
        ? { $or: [{ ns_synced: false, ns_error: { $exists: true } }, { ns_failed: true }] }
        : { ns_synced: false, ns_error: { $exists: true }, ns_failed: { $ne: true } };
    const failedOrders = await collection.find(filter).toArray();
    if (failedOrders.length === 0) {
        return { message: "No failed POs to retry.", count: 0 };
    }
    const result = await collection.updateMany({ _id: { $in: failedOrders.map((o) => o._id) } }, {
        $set: { ns_synced: false },
        $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
    });
    const orderList = failedOrders.map((o) => ({
        po_number: o.po_number,
        previousError: o.ns_error,
        retryCount: o.ns_retry_count || 0
    }));
    return {
        message: `Reset ${result.modifiedCount} failed POs for retry.`,
        count: result.modifiedCount,
        orders: orderList
    };
};
exports.retryFailedPurchaseOrders = retryFailedPurchaseOrders;
// export const testSyncDummyToSuitePO = async (): Promise<any[]> => {
//     const ns_db = await getDb("netsuite");
//     const dummyCol = ns_db.collection("suite_purchase_order_dummy");
//     const results: any[] = [];
//     log.info(`[testSyncDummyToSuitePO] Starting FULL sync from dummy to NetSuite (no limit, no local suite_purchase_order usage)...`);
//     let netsuitePOs: any[] = [];
//     try {
//         const resp = await axios.get("http://localhost:5002/api/v4/purchaseOrder-details-test", {
//             params: { limit: 10000, details: true }
//         });
//         netsuitePOs = Array.isArray(resp.data.records) ? resp.data.records : [];
//     } catch (err) {
//         log.error("[testSyncDummyToSuitePO] Failed to fetch NetSuite POs from API", err);
//         throw err;
//     }
//     // Build map: otherRefNum -> NetSuite PO
//     const nsMap = new Map();
//     for (const po of netsuitePOs) {
//         if (po.otherRefNum) nsMap.set(String(po.otherRefNum), po);
//     }
//     // Fetch all dummy POs
//     const dummyPOs = await dummyCol.find({}).toArray();
//     const fieldsToSync = [
//         "website_order_number", "distributor", "distributor_order_number", "status", "invoice", "vendor_id", "tracking", "order_items", "po_type", "stocking_warehouse", "created_at", "updated_at"
//     ];
//     for (const dummy of dummyPOs) {
//         let status: any = {
//             po_number: dummy.po_number,
//             alreadyExist: false,
//             updated: false,
//             updatedFields: {},
//             ns_synced: false,
//             skipped: false,
//             ns_error: false,
//             errorDetails: null,
//             action: null,
//             netsuiteResult: null
//         };
//         let dummyUpdate: any = {};
//         try {
//             if (!dummy.po_number && dummy.po_number !== 0) {
//                 status.skipped = true;
//                 status.errorDetails = "missing_po_number";
//                 status.action = "skipped";
//                 log.warn(`[testSyncDummyToSuitePO] Skipped PO (missing po_number):`, dummy);
//                 dummyUpdate = {
//                     $set: {
//                         ns_synced: false,
//                         ns_synced_at: new Date(),
//                         ns_result: "skipped_no_po_number",
//                         ns_error: "missing_po_number"
//                     }
//                 };
//                 await dummyCol.updateOne({ _id: dummy._id }, dummyUpdate);
//                 results.push(status);
//                 continue;
//             }
//             const nsPO = nsMap.get(String(dummy.po_number));
//             // Build NetSuite payload
//             const payload: any = {
//                 action: SYNC_MODE,
//                 po_number: dummy.po_number,
//                 otherrefnum: String(dummy.po_number),
//                 vendor_id: dummy.vendor_id,
//                 distributor: dummy.distributor,
//                 distributor_order_number: dummy.distributor_order_number,
//                 status: dummy.status,
//                 invoice: dummy.invoice,
//                 tracking: dummy.tracking,
//                 order_items: dummy.order_items,
//                 website_order_number: dummy.website_order_number,
//                 po_type: dummy.po_type || "",
//                 stocking_warehouse: dummy.stocking_warehouse || "",
//                 created_at: toSafeISO(dummy.created_at)
//             };
//             if (nsPO) {
//                 status.alreadyExist = true;
//                 // Compare only mapped fields
//                 const updatedFields: any = {};
//                 for (const field of fieldsToSync) {
//                     let dummyVal = dummy[field];
//                     let nsVal = nsPO[field];
//                     if (JSON.stringify(dummyVal) !== JSON.stringify(nsVal)) {
//                         updatedFields[field] = { old: nsVal, new: dummyVal };
//                     }
//                 }
//                 if (Object.keys(updatedFields).length > 0) {
//                     status.updated = true;
//                     status.updatedFields = updatedFields;
//                     log.info(`[testSyncDummyToSuitePO] Updating PO ${dummy.po_number} in NetSuite. Changed fields:`, updatedFields);
//                     // Update in NetSuite
//                     try {
//                         // Use a fixed concurrency label to serialize all NetSuite calls in this function
//                         const nsResult = await withConcurrency(() => postToNetsuiteForPO(payload), `testSyncDummyToSuitePO`);
//                         status.netsuiteResult = nsResult;
//                         if (nsResult.success === false) {
//                             status.ns_error = true;
//                             status.errorDetails = nsResult.error || "Unknown NetSuite error";
//                             status.action = "error";
//                             log.error(`[testSyncDummyToSuitePO] NetSuite update failed for PO ${dummy.po_number}:`, status.errorDetails);
//                             dummyUpdate = {
//                                 $set: {
//                                     ns_synced: false,
//                                     ns_synced_at: new Date(),
//                                     ns_result: "error",
//                                     ns_error: status.errorDetails
//                                 }
//                             };
//                         } else if (nsResult.action === "no_items") {
//                             status.ns_error = true;
//                             status.errorDetails = "no_items";
//                             status.action = "error";
//                             log.error(`[testSyncDummyToSuitePO] NetSuite update failed (no_items) for PO ${dummy.po_number}`);
//                             dummyUpdate = {
//                                 $set: {
//                                     ns_synced: false,
//                                     ns_synced_at: null,
//                                     ns_error_at: new Date(),
//                                     ns_result: "no_items",
//                                     ns_error: "no_items"
//                                 }
//                             };
//                         } else {
//                             status.ns_synced = true;
//                             status.action = nsResult.action || "updated";
//                             log.info(`[testSyncDummyToSuitePO] NetSuite update success for PO ${dummy.po_number}:`, nsResult.action);
//                             dummyUpdate = {
//                                 $set: {
//                                     ns_synced: true,
//                                     ns_synced_at: new Date(),
//                                     ns_result: nsResult.action || "updated"
//                                 },
//                                 $unset: { ns_error: "" }
//                             };
//                         }
//                     } catch (err: any) {
//                         status.ns_error = true;
//                         status.errorDetails = err?.response?.data || err.message || String(err);
//                         status.action = "error";
//                         log.error(`[testSyncDummyToSuitePO] Exception during NetSuite update for PO ${dummy.po_number}:`, status.errorDetails);
//                         dummyUpdate = {
//                             $set: {
//                                 ns_synced: false,
//                                 ns_synced_at: new Date(),
//                                 ns_result: "error",
//                                 ns_error: status.errorDetails
//                             }
//                         };
//                     }
//                 } else {
//                     status.action = "already_up_to_date";
//                     status.ns_synced = true;
//                     log.info(`[testSyncDummyToSuitePO] PO ${dummy.po_number} already up to date. No action needed.`);
//                     dummyUpdate = {
//                         $set: {
//                             ns_synced: true,
//                             ns_synced_at: new Date(),
//                             ns_result: "already_up_to_date"
//                         },
//                         $unset: { ns_error: "" }
//                     };
//                 }
//             } else {
//                 log.info(`[testSyncDummyToSuitePO] PO ${dummy.po_number} does not exist in NetSuite. Creating...`);
//                 try {
//                     // Use a fixed concurrency label to serialize all NetSuite calls in this function
//                     const nsResult = await withConcurrency(() => postToNetsuiteForPO(payload), `testSyncDummyToSuitePO`);
//                     status.netsuiteResult = nsResult;
//                     if (nsResult.success === false) {
//                         status.ns_error = true;
//                         status.errorDetails = nsResult.error || "Unknown NetSuite error";
//                         status.action = "error";
//                         log.error(`[testSyncDummyToSuitePO] NetSuite create failed for PO ${dummy.po_number}:`, status.errorDetails);
//                         dummyUpdate = {
//                             $set: {
//                                 ns_synced: false,
//                                 ns_synced_at: new Date(),
//                                 ns_result: "error",
//                                 ns_error: status.errorDetails
//                             }
//                         };
//                     } else if (nsResult.action === "no_items") {
//                         status.ns_error = true;
//                         status.errorDetails = "no_items";
//                         status.action = "error";
//                         log.error(`[testSyncDummyToSuitePO] NetSuite create failed (no_items) for PO ${dummy.po_number}`);
//                         dummyUpdate = {
//                             $set: {
//                                 ns_synced: false,
//                                 ns_synced_at: null,
//                                 ns_error_at: new Date(),
//                                 ns_result: "no_items",
//                                 ns_error: "no_items"
//                             }
//                         };
//                     } else {
//                         status.ns_synced = true;
//                         status.action = nsResult.action || "created";
//                         log.info(`[testSyncDummyToSuitePO] NetSuite create success for PO ${dummy.po_number}:`, nsResult.action);
//                         dummyUpdate = {
//                             $set: {
//                                 ns_synced: true,
//                                 ns_synced_at: new Date(),
//                                 ns_result: nsResult.action || "created"
//                             },
//                             $unset: { ns_error: "" }
//                         };
//                     }
//                 } catch (err: any) {
//                     status.ns_error = true;
//                     status.errorDetails = err?.response?.data || err.message || String(err);
//                     status.action = "error";
//                     log.error(`[testSyncDummyToSuitePO] Exception during NetSuite create for PO ${dummy.po_number}:`, status.errorDetails);
//                     dummyUpdate = {
//                         $set: {
//                             ns_synced: false,
//                             ns_synced_at: new Date(),
//                             ns_result: "error",
//                             ns_error: status.errorDetails
//                         }
//                     };
//                 }
//             }
//         } catch (err: any) {
//             status.ns_error = true;
//             status.errorDetails = err?.response?.data || err.message || String(err);
//             status.action = "error";
//             log.error(`[testSyncDummyToSuitePO] General exception for PO ${dummy.po_number}:`, status.errorDetails);
//             dummyUpdate = {
//                 $set: {
//                     ns_synced: false,
//                     ns_synced_at: new Date(),
//                     ns_result: "error",
//                     ns_error: status.errorDetails
//                 }
//             };
//         }
//         // Always update dummy collection with sync status and status fields
//         if (Object.keys(dummyUpdate).length > 0) {
//             // Add status fields to the update
//             dummyUpdate.$set = {
//                 ...dummyUpdate.$set,
//                 alreadyExist: status.alreadyExist,
//                 updated: status.updated,
//                 updatedFields: status.updatedFields,
//                 skipped: status.skipped,
//                 ns_error: status.ns_error,
//                 errorDetails: status.errorDetails,
//                 action: status.action,
//                 netsuiteResult: status.netsuiteResult
//             };
//             await dummyCol.updateOne({ _id: dummy._id }, dummyUpdate);
//         }
//         results.push(status);
//     }
//     log.info(`[testSyncDummyToSuitePO] Sync complete. Processed ${results.length} POs.`);
//     log.info(`[testSyncDummyToSuitePO]   results ${JSON.stringify(results)} `);
//     return results;
// };
const batchSyncDummyToSuitePO = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const dummyCol = ns_db.collection("suite_purchase_order_dummy");
    const results = [];
    console.log("Sync starting");
    let netsuitePOs = [];
    try {
        const resp = await axios_1.default.get("http://localhost:5002/api/v4/purchaseOrder", {
            params: {
                fetchAll: true,
                untilExhausted: true,
                persistDb: true,
                pageSize: 10000
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log("Finished dummping  to DB in NS_REST_PO_DUMP_COLLECTION ! Total pulled:", resp.data.count);
        netsuitePOs = Array.isArray(resp.data.records) ? resp.data.records : [];
    }
    catch (err) {
        const safeError = err?.response?.data || err?.message || String(err);
        logger_config_1.default.error("POS fetching from the netsuit api failed", safeError);
    }
    // Build map: otherRefNum -> NetSuite PO
    const nsMap = new Map();
    for (const po of netsuitePOs) {
        if (po.otherRefNum)
            nsMap.set(String(po.otherRefNum), po);
    }
    // Fetch dummy POs where:
    // - ns_synced is false or missing
    // - OR ns_synced is true AND ns_result in ["skipped", "no_items", "error"]
    const dummyPOs = await dummyCol.find({
        $or: [
            { ns_synced: false },
            { ns_synced: { $exists: false } },
            { ns_synced: true, ns_result: { $in: ["skipped", "no_items", "error"] } }
        ]
    }).toArray();
    console.log(`[batchSyncDummyToSuitePO] Found ${dummyPOs.length} dummy POs to sync.`);
    const fieldsToSync = [
        "website_order_number", "distributor", "distributor_order_number", "status", "invoice", "vendor_id", "tracking", "order_items", "po_type", "stocking_warehouse", "created_at", "updated_at"
    ];
    // Batch processing
    const BATCH_SIZE = 10; // You can adjust this as needed
    for (let i = 0; i < dummyPOs.length; i += BATCH_SIZE) {
        const batch = dummyPOs.slice(i, i + BATCH_SIZE);
        const payloads = [];
        const poRefs = [];
        // Prepare payloads for NetSuite
        for (const dummy of batch) {
            if (!dummy.po_number && dummy.po_number !== 0) {
                // Mark as skipped, always set ns_error
                await dummyCol.updateOne({ _id: dummy._id }, {
                    $set: {
                        ns_synced: false,
                        ns_synced_at: new Date(),
                        ns_result: "skipped_no_po_number",
                        ns_error: "missing_po_number"
                    }
                });
                results.push({ po_number: dummy.po_number, skipped: true, errorDetails: "missing_po_number", action: "skipped" });
                continue;
            }
            const nsPO = nsMap.get(String(dummy.po_number));
            // Build NetSuite payload
            const payload = {
                action: sync_config_1.SYNC_MODE_PO,
                po_number: dummy.po_number,
                otherrefnum: String(dummy.po_number),
                vendor_id: dummy.vendor_id,
                distributor: dummy.distributor,
                distributor_order_number: dummy.distributor_order_number,
                status: dummy.status,
                invoice: dummy.invoice,
                tracking: dummy.tracking,
                order_items: dummy.order_items,
                website_order_number: dummy.website_order_number,
                po_type: dummy.po_type || "",
                stocking_warehouse: dummy.stocking_warehouse || "",
                created_at: toSafeISO(dummy.created_at)
            };
            payloads.push(payload);
            poRefs.push({ dummy, nsPO });
        }
        if (payloads.length === 0)
            continue;
        // Batch post to NetSuite
        let nsResults = [];
        try {
            const batchLabel = `batchSyncDummyToSuitePO batch [${payloads.map((p) => p.po_number).join(",")}]`;
            const response = await (0, concurrency_config_1.withConcurrency)(() => (0, netsuite_client_1.postBatchToNetsuiteForPO)(payloads), batchLabel);
            if (response && Array.isArray(response.results)) {
                nsResults = response.results;
            }
            else if (Array.isArray(response.batch)) {
                nsResults = response.batch;
            }
            else if (Array.isArray(response)) {
                nsResults = response;
            }
            else {
                logger_config_1.default.error(`[batchSyncDummyToSuitePO] Unexpected batch response format`, response);
            }
        }
        catch (err) {
            logger_config_1.default.error(`[batchSyncDummyToSuitePO] Batch call failed:`, err?.response?.data || err.message || String(err));
        }
        // Process each result from the batch response
        for (let j = 0; j < poRefs.length; j++) {
            const { dummy, nsPO } = poRefs[j];
            const nsResult = nsResults[j];
            let dummyUpdate = {};
            let status = {
                po_number: dummy.po_number,
                alreadyExist: !!nsPO,
                updated: false,
                updatedFields: {},
                ns_synced: false,
                skipped: false,
                ns_error: false,
                errorDetails: null,
                action: null,
                netsuiteResult: nsResult
            };
            if (!nsResult) {
                status.ns_error = true;
                status.errorDetails = "no_result_in_batch";
                status.action = "error";
                dummyUpdate = {
                    $set: {
                        ns_synced: false,
                        ns_synced_at: new Date(),
                        ns_result: "error",
                        ns_error: "no_result_in_batch"
                    }
                };
            }
            else if (nsResult.success === false) {
                status.ns_error = true;
                status.errorDetails = nsResult.error || "Unknown NetSuite error";
                status.action = "error";
                dummyUpdate = {
                    $set: {
                        ns_synced: false,
                        ns_synced_at: new Date(),
                        ns_result: "error",
                        ns_error: status.errorDetails
                    }
                };
            }
            else if (nsResult.action === "no_items") {
                status.skipped = true;
                status.action = "no_items";
                status.ns_error = true;
                status.errorDetails = nsResult.error || "no_items";
                dummyUpdate = {
                    $set: {
                        ns_synced: false,
                        ns_synced_at: null,
                        ns_error_at: new Date(),
                        ns_result: "no_items",
                        ns_error: nsResult.error || "no_items"
                    }
                };
            }
            else if (nsResult.action === "skipped") {
                status.skipped = true;
                status.action = "skipped";
                dummyUpdate = {
                    $set: {
                        ns_synced: true,
                        ns_synced_at: new Date(),
                        ns_result: "skipped"
                    },
                    $unset: { ns_error: "", ns_error_at: "" }
                };
            }
            else {
                status.ns_synced = true;
                status.action = nsResult.action || (nsPO ? "updated" : "created");
                status.alreadyExist = !!nsPO;
                let updatedFields = {};
                if (nsPO) {
                    for (const field of fieldsToSync) {
                        let dummyVal = dummy[field];
                        let nsVal = nsPO[field];
                        if (JSON.stringify(dummyVal) !== JSON.stringify(nsVal)) {
                            updatedFields[field] = { old: nsVal, new: dummyVal };
                        }
                    }
                    if (Object.keys(updatedFields).length > 0) {
                        status.updated = true;
                        status.updatedFields = updatedFields;
                    }
                }
                dummyUpdate = {
                    $set: {
                        ns_synced: true,
                        ns_synced_at: new Date(),
                        ns_result: nsResult.action || (nsPO ? "updated" : "created"),
                        alreadyExist: !!nsPO,
                        updatedFields: Object.keys(updatedFields).length > 0 ? updatedFields : undefined
                    },
                    $unset: { ns_error: "" }
                };
                // Remove updatedFields if not present
                if (!Object.keys(updatedFields).length) {
                    delete dummyUpdate.$set.updatedFields;
                }
            }
            await dummyCol.updateOne({ _id: dummy._id }, dummyUpdate);
            results.push(status);
        }
    }
    logger_config_1.default.info(`[batchSyncDummyToSuitePO] Sync complete. Processed ${results.length} POs.`);
    logger_config_1.default.info(`[batchSyncDummyToSuitePO]   results ${JSON.stringify(results)} `);
    return results;
};
exports.batchSyncDummyToSuitePO = batchSyncDummyToSuitePO;
// export const pOSWithError = async (): Promise<any> => {
//     const ns_db = await getDb("netsuite");
//     const dummyCol = ns_db.collection("suite_purchase_order_dummy");
//     const failedOrders = await dummyCol.find({ ns_error: "no_items" }).toArray();
//     console.log(`${failedOrders.length} failed orders found with 'no_items' error.`);
//     // Loop through each failed order
//     for (const order of failedOrders) {
//         const poNumber = order.po_number || "Unknown PO";
//         // Extract just the SKUs from the order_items array
//         const skus = Array.isArray(order.order_items) 
//             ? order.order_items.map((item: any) => item.sku).join(", ")
//             : "No items array";
//         console.log(`PO Number: ${poNumber} | SKUs: ${skus}`);
//     }
// };
const pOSWithError = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const dummyCol = ns_db.collection("suite_purchase_order_dummy");
    const failedOrders = await dummyCol.find({ ns_error: "no_items" }).toArray();
    console.log(`${failedOrders.length} failed orders found with 'no_items' error.`);
    const globalUniqueSkus = new Set();
    for (const order of failedOrders) {
        const poNumber = order.po_number || "Unknown PO";
        if (Array.isArray(order.order_items)) {
            const orderSkus = order.order_items.map((item) => item.sku);
            // Log the unique SKUs for this specific PO
            const uniqueOrderSkus = [...new Set(orderSkus)];
            console.log(`PO Number: ${poNumber} | SKUs: ${uniqueOrderSkus.join(", ")}`);
            // Add to the global set
            uniqueOrderSkus.forEach((sku) => {
                if (sku)
                    globalUniqueSkus.add(sku);
            });
        }
        else {
            console.log(`PO Number: ${poNumber} | SKUs: No items array`);
        }
    }
    // Print the master list of all missing unique SKUs at the end
    console.log("\n======================================");
    console.log(`TOTAL UNIQUE MISSING SKUS: ${globalUniqueSkus.size}`);
    console.log([...globalUniqueSkus].join(", "));
    console.log("======================================\n");
};
exports.pOSWithError = pOSWithError;
// export const resetDummyPOsWithError = async (): Promise<any> => {
//     const ns_db = await getDb("netsuite");
//     const dummyCol = ns_db.collection("suite_purchase_order_dummy");
//     const failedOrders = await dummyCol.find({ ns_error:"no_items" }).toArray();
//     console.log(failedOrders.length ,"faield order")
//     if (failedOrders.length === 0) {
//         return { message: "No Dummy POs to reset.", count: 0 };
//     }
//     let modifiedCount = 0;
//     for (const doc of failedOrders) {
//         const result = await dummyCol.updateOne(
//             { _id: doc._id },
//             {
//                 $set: { 
//                     ns_synced: false,
//                     ns_error_at: doc.ns_synced_at || new Date(),
//                     ns_synced_at: null // Resets the synced_at timestamp
//                 }
//             }
//         );
//         modifiedCount += result.modifiedCount;
//     }
//     console.log(modifiedCount)
//     return {
//         message: `Reset ${modifiedCount} dummy POs with error.`,
//         count: modifiedCount
//     };
// };
