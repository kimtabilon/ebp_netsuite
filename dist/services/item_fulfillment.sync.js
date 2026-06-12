"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncItemFulfillmentsToNetsuite = void 0;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const netsuite_client_1 = require("./netsuite.client");
const item_fulfillment_stage_1 = require("./item_fulfillment.stage");
const MAX_CONCURRENT = parseInt(process.env.NS_MAX_CONCURRENT || "1", 10);
const syncItemFulfillmentsToNetsuite = async () => {
    logger_config_1.default.info("[IF Sync] Starting...");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection(item_fulfillment_stage_1.IF_COLLECTION);
    //     const pending = await collection.find({
    //   po_number: {
    //     $in:   [
    // 233885
    //     ]
    //   }
    // }).toArray();
    const pending = await collection.find({
        so_synced: true, po_synced: true,
        // ns_synced : false  
        ns_synced: { $exists: false }
    }).toArray();
    logger_config_1.default.info(`[IF Sync] Found ${pending.length} Item Fulfillments to sync`);
    const results = [];
    let index = 0;
    async function worker() {
        while (index < pending.length) {
            const i = index++;
            const doc = pending[i];
            const ref = `PO${doc.po_number}-${doc.website_order_number}`;
            logger_config_1.default.info(`[IF Sync] Processing: ${ref}`);
            const payload = {
                po_number: doc.po_number,
                bill_number: doc.bill_number || "",
                website_order_number: doc.website_order_number,
                ship_date: doc.ship_date,
                tracking_number: doc.tracking_number,
                weight_lbs: doc.weight_lbs || 1,
                shipping_address: doc.shipping_address,
                items: doc.items
            };
            try {
                const result = await (0, netsuite_client_1.postToNetsuiteForIF)(payload);
                if (result.success === false) {
                    await collection.updateOne({ _id: doc._id }, {
                        $set: {
                            ns_error: result.error || "sync_failed",
                            ns_error_at: new Date(),
                            ns_synced: false,
                            ns_so_number: result.soNumber,
                            ns_so_status: result.soStatus
                        }
                    });
                    logger_config_1.default.warn(`[IF Sync] ❌ Failed for ${ref}: ${result.error}${result.soStatus ? " (SO Status: " + result.soStatus + ")" : ""}`);
                    results.push({ ref, success: false, error: result.error, soNumber: result.soNumber });
                }
                else {
                    await collection.updateOne({ _id: doc._id }, {
                        $set: {
                            ns_synced: true,
                            ns_synced_at: new Date(),
                            ns_result: result.action || "created",
                            ns_internal_id: result.internalId,
                            ns_so_number: result.soNumber,
                            ns_error: null,
                            ns_error_at: null
                        }
                    });
                    logger_config_1.default.info(`[IF Sync] ✅ Success: ${ref} → NS ID ${result.internalId} (SO: ${result.soNumber})`);
                    results.push({ ref, success: true, action: result.action, internalId: result.internalId, soNumber: result.soNumber });
                }
            }
            catch (e) {
                logger_config_1.default.error(`[IF Sync] ❌ Exception for ${ref}: ${e.message}`);
                await collection.updateOne({ _id: doc._id }, {
                    $set: {
                        ns_synced: false,
                        ns_error: e.message || "sync_exception",
                        ns_error_at: new Date()
                    }
                });
                results.push({ ref, success: false, error: e.message });
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, pending.length) }, () => worker()));
    logger_config_1.default.info(`[IF Sync] Done. Processed ${results.length} records.`);
    return results;
};
exports.syncItemFulfillmentsToNetsuite = syncItemFulfillmentsToNetsuite;
