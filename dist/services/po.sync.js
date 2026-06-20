"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncPurchaseOrdersToNetsuite = void 0;
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_client_1 = require("./netsuite.client");
const sync_config_1 = require("../config/sync.config");
const concurrency_config_1 = require("../config/concurrency.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
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
const syncPurchaseOrdersToNetsuite = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const dummyCol = ns_db.collection("suite_purchase_order_dummy");
    const results = [];
    logger_config_1.default.info("[syncPurchaseOrdersToNetsuite] Fast Sync starting with cursor-based processing...");
    const filter = { $or: [{ ns_synced: null }] };
    const totalToProcess = await dummyCol.countDocuments(filter);
    logger_config_1.default.info(`[syncPurchaseOrdersToNetsuite] Found ${totalToProcess} dummy POs to sync.`);
    if (totalToProcess === 0)
        return [];
    const allDocs = await dummyCol.find(filter).toArray();
    const BATCH_SIZE = 1;
    // Use parallel workers (matching NS_MAX_CONCURRENT) to process batches efficiently
    const workers = Array.from({ length: 2 }, async () => {
        while (true) {
            const batch = allDocs.splice(0, BATCH_SIZE);
            if (batch.length === 0)
                break;
            const payloads = [];
            const poRefs = [];
            // Prepare payloads for NetSuite
            for (const dummy of batch) {
                if (!dummy.po_number && dummy.po_number !== 0) {
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
                poRefs.push({ dummy });
            }
            if (payloads.length === 0)
                continue;
            // Batch post to NetSuite
            let nsResults = [];
            try {
                const batchLabel = `syncPurchaseOrdersToNetsuite batch [${payloads.map((p) => p.po_number).join(",")}]`;
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
                    logger_config_1.default.error(`[syncPurchaseOrdersToNetsuite] Unexpected batch response format`, response);
                }
            }
            catch (err) {
                const safeError = err?.response?.data || err?.message || String(err);
                logger_config_1.default.error(`[syncPurchaseOrdersToNetsuite] Batch call failed:`, safeError);
            }
            // Process each result from the batch response
            for (let j = 0; j < poRefs.length; j++) {
                const { dummy } = poRefs[j];
                const nsResult = nsResults[j];
                let dummyUpdate = {};
                let status = {
                    po_number: dummy.po_number,
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
                    status.alreadyExist = true; // Mark as already existing
                    dummyUpdate = {
                        $set: {
                            ns_synced: true,
                            ns_synced_at: new Date(),
                            ns_result: "skipped",
                            alreadyExist: true
                        },
                        $unset: { ns_error: "", ns_error_at: "" }
                    };
                }
                else {
                    status.ns_synced = true;
                    status.action = nsResult.action || "created";
                    // Set alreadyExist flag: false for created, true for updated
                    const isUpdate = status.action === "updated";
                    status.alreadyExist = isUpdate;
                    dummyUpdate = {
                        $set: {
                            ns_synced: true,
                            ns_synced_at: new Date(),
                            ns_result: status.action,
                            alreadyExist: isUpdate,
                            ns_linked_so: nsResult.linkedSo || null,
                            ns_internal_id: nsResult.internalId || null
                        },
                        $unset: { ns_error: "" }
                    };
                }
                await dummyCol.updateOne({ _id: dummy._id }, dummyUpdate);
                results.push(status);
            }
        }
    });
    await Promise.all(workers);
    logger_config_1.default.info(`[syncPurchaseOrdersToNetsuite] Fast Sync complete. Processed ${results.length} POs.`);
    return results;
};
exports.syncPurchaseOrdersToNetsuite = syncPurchaseOrdersToNetsuite;
