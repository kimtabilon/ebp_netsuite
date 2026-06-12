"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const sales_order_sync_1 = require("../services/sales_order.sync");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const SELECTED_REFS = [
    "1207857592", "1206930887", "1204754926", "1208470774",
    "1206952447", "1210498033", "1208477474", "1209635011"
];
async function updateAndSyncNeweggBusiness() {
    logger_config_1.default.info(`🚀 Starting Newegg → Newegg Business update and sync for ${SELECTED_REFS.length} orders...`);
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collections = ["suite_sales_order"];
    for (const colName of collections) {
        const collection = ns_db.collection(colName);
        const orders = await collection.find({ otherrefnum: { $in: SELECTED_REFS } }).toArray();
        if (orders.length === 0) {
            logger_config_1.default.info(`[${colName}] No matching orders found.`);
            continue;
        }
        logger_config_1.default.info(`[${colName}] Found ${orders.length} orders to update.`);
        for (const order of orders) {
            logger_config_1.default.info(`🔄 Updating and Syncing ${order.otherrefnum} in ${colName}...`);
            // 1. Update store_type in MongoDB and clear ALL sync/ID fields
            await collection.updateOne({ _id: order._id }, {
                $set: {
                    store_type: "newegg_business",
                    ns_synced: false
                },
                $unset: {
                    ns_result: "",
                    ns_error: "",
                    ns_error_at: "",
                    ns_retry_count: "",
                    ns_failed: "",
                    ns_synced_at: "",
                    ns_id: "",
                    ns_internal_id: "",
                    ns_result_data: ""
                }
            });
            // 2. Fetch the updated doc
            const updatedOrder = await collection.findOne({ _id: order._id });
            // 3. Sync to NetSuite
            try {
                const result = await (0, sales_order_sync_1.syncOneOrder)(collection, updatedOrder, true);
                if (result.success) {
                    logger_config_1.default.info(`✅ ${order.otherrefnum} → ${result.action || "Done"}`);
                }
                else {
                    logger_config_1.default.error(`❌ ${order.otherrefnum} → ${result.error || "Unknown Error"}`);
                }
            }
            catch (err) {
                logger_config_1.default.error(`💥 ${order.otherrefnum} → Exception: ${err.message}`);
            }
        }
    }
    logger_config_1.default.info("\n🎉 Task Complete!");
}
updateAndSyncNeweggBusiness().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
