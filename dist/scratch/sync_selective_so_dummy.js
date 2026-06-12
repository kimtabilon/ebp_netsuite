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
    "eco-1489", "eco-1490", "eco-1491", "eco-1492", "eco-1493",
    "eco-1494", "eco-1497", "eco-1499", "eco-1500", "eco-1501",
    "eco-1502", "eco-1503", "eco-1498", "eco-1504", "eco-1505",
    "eco-1506", "eco-1507", "eco-1508", "eco-1509", "eco-1510",
    "eco-1511", "eco-1512", "eco-1513", "eco-1514", "eco-1516",
    "eco-1517", "eco-1518", "eco-1520", "eco-1519", "eco-1521",
    "eco-1522", "eco-1523", "eco-1524", "eco-1525", "eco-1526"
];
async function syncSelectiveOrdersDummy() {
    logger_config_1.default.info(`🚀 Starting selective SO sync (DUMMY) for ${SELECTED_REFS.length} orders...`);
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_sales_order");
    const orders = await collection.find({
        otherrefnum: { $in: SELECTED_REFS }
    }).toArray();
    logger_config_1.default.info(`📦 Found ${orders.length} matching orders in MongoDB (Dummy).`);
    if (orders.length === 0) {
        logger_config_1.default.warn("⚠️ No matching orders found in Dummy. Exiting.");
        return;
    }
    let successCount = 0;
    let failCount = 0;
    for (const order of orders) {
        logger_config_1.default.info(`🔄 Syncing ${order.otherrefnum} (Dummy)...`);
        try {
            // Use the exported syncOneOrder function with the CORRECT collection (Dummy)
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
    logger_config_1.default.info(`🎉 SELECTIVE SYNC (DUMMY) COMPLETE`);
    logger_config_1.default.info(`✅ Success: ${successCount}`);
    logger_config_1.default.info(`❌ Failed:  ${failCount}`);
    logger_config_1.default.info(`📦 Total:   ${orders.length}`);
    logger_config_1.default.info("==============================");
}
syncSelectiveOrdersDummy().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
