"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
async function run() {
    try {
        const db = await (0, mongdodb_config_1.getDb)("netsuite");
        const collections = ["suite_credit_memo_bill", "suite_credit_memo_bill_dummy"];
        for (const colName of collections) {
            const collection = db.collection(colName);
            console.log(`Resetting sync flags in ${colName}...`);
            const countBefore = await collection.countDocuments({});
            console.log(`  Total documents in ${colName}: ${countBefore}`);
            const result = await collection.updateMany({}, {
                $unset: {
                    ns_synced: "",
                    ns_synced_at: "",
                    ns_vendor_credit_id: "",
                    ns_result: "",
                    ns_failed: "",
                    ns_error: "",
                    ns_error_at: ""
                }
            });
            console.log(`  Successfully reset sync flags for ${result.modifiedCount} documents in ${colName}.`);
        }
    }
    catch (e) {
        console.error("Error:", e.message);
    }
    process.exit(0);
}
run();
