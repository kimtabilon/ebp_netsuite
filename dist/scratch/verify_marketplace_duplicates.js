"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
async function verifyDuplicates() {
    console.log("Starting Marketplace Duplicate Analysis...");
    const ebp_db = await (0, mongdodb_config_1.getDb)("ebp_marketplace");
    const amazonCol = ebp_db.collection("amazon_orders_v3");
    const targetOrders = [
        "113-4686831-4184263",
        "111-9801937-1483404",
        "112-5360521-5775420"
    ];
    for (const orderId of targetOrders) {
        console.log(`\n--- Analyzing Order: ${orderId} ---`);
        // Check Amazon
        const amazonDocs = await amazonCol.find({ AmazonOrderId: orderId }).toArray();
        console.log(`Amazon Docs found: ${amazonDocs.length}`);
        amazonDocs.forEach((doc, i) => {
            const items = doc.OrderItems || [];
            console.log(`  Doc ${i + 1} (_id: ${doc._id}): ${items.length} items`);
            items.forEach((item) => {
                console.log(`    - SKU: ${item.SellerSKU} | Qty: ${item.QuantityOrdered}`);
            });
        });
        // If not in Amazon, check Walmart just in case
        if (amazonDocs.length === 0) {
            const walmartDb = await (0, mongdodb_config_1.getDb)("walmarts");
            const walmartDocs = await walmartDb.collection("walmart_orders_v2").find({ orderNumber: orderId }).toArray();
            console.log(`Walmart Docs found: ${walmartDocs.length}`);
            walmartDocs.forEach((doc, i) => {
                const lines = doc.orderLines?.orderLine || [];
                console.log(`  Doc ${i + 1} (_id: ${doc._id}): ${lines.length} lines`);
            });
        }
    }
    process.exit(0);
}
verifyDuplicates().catch(err => {
    console.error(err);
    process.exit(1);
});
