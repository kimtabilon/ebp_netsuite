"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mongdodb_config_1 = require("../config/mongdodb.config");
async function run() {
    try {
        const db = await (0, mongdodb_config_1.getDb)("netsuite");
        const dummyCol = db.collection("suite_purchase_order_dummy");
        const doc = await dummyCol.findOne({ po_number: 234430 });
        console.log("MongoDB PO 234430 Doc:", JSON.stringify(doc, null, 2));
    }
    catch (e) {
        console.error("Error:", e.message);
    }
    process.exit(0);
}
run();
