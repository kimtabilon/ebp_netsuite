"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const sales_order_sync_1 = require("../services/sales_order.sync");
async function testSync() {
    const orderId = "111-9801937-1483404"; // The SO you want to test
    console.log(`Starting test sync for SO: ${orderId}`);
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection("suite_sales_order");
    const order = await collection.findOne({ otherrefnum: orderId });
    if (!order) {
        console.error(`Order ${orderId} not found in suite_sales_order.`);
        process.exit(1);
    }
    console.log(`Order found. Sending to NetSuite...`);
    const result = await (0, sales_order_sync_1.syncOneOrder)(collection, order, true);
    console.log("\n--- Sync Result ---");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}
testSync().catch(console.error);
