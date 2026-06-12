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
    "eco-1511", "eco-1510"
];
async function syncSelectiveOrders() {
    logger_config_1.default.info(`🚀 Starting selective SO sync for ${SELECTED_REFS.length} orders...`);
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_sales_order");
    const orders = await collection.find({
        otherrefnum: { $in: SELECTED_REFS }
    }).toArray();
    logger_config_1.default.info(`📦 Found ${orders.length} matching orders in MongoDB.`);
    if (orders.length === 0) {
        logger_config_1.default.warn("⚠️ No matching orders found. Exiting.");
        return;
    }
    let successCount = 0;
    let failCount = 0;
    for (const order of orders) {
        logger_config_1.default.info(`🔄 Syncing ${order.otherrefnum}...`);
        try {
            // Use the exported syncOneOrder function with the CORRECT collection
            const result = await (0, sales_order_sync_1.syncOneOrder)(collection, order, true);
            if (result.success) {
                successCount++;
                logger_config_1.default.info(`✅ ${order.otherrefnum} → ${result.action || "Done"}`);
            }
            else {
                failCount++;
                logger_config_1.default.error(`❌ ${order.otherrefnum} → ${result.error || "Unknown Error"}`);
            }
        }
        catch (err) {
            failCount++;
            logger_config_1.default.error(`💥 ${order.otherrefnum} → Exception: ${err.message}`);
        }
    }
    logger_config_1.default.info("\n==============================");
    logger_config_1.default.info(`🎉 SELECTIVE SYNC COMPLETE`);
    logger_config_1.default.info(`✅ Success: ${successCount}`);
    logger_config_1.default.info(`❌ Failed:  ${failCount}`);
    logger_config_1.default.info(`📦 Total:   ${orders.length}`);
    logger_config_1.default.info("==============================");
}
syncSelectiveOrders().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
