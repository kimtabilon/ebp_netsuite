"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
async function autoHealSalesOrders() {
    logger_config_1.default.info("🚀 Starting Enhanced Sales Order Auto-Heal...");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const dumpCollection = ns_db.collection("so_dump_test");
    const dummyCollection = ns_db.collection("suite_sales_order");
    // 1. Fetch all NetSuite Dump records
    logger_config_1.default.info("[Auto-Heal] Fetching NetSuite Dump records...");
    const dumpDocs = await dumpCollection.find({}, {
        projection: { "so.id": 1, "so.otherRefNum": 1, "so.tranid": 1, "so.createdDate": 1 }
    }).toArray();
    const dumpMap = new Map();
    for (const doc of dumpDocs) {
        const ref = String(doc.so?.otherRefNum || "").trim();
        if (ref)
            dumpMap.set(ref, doc);
    }
    logger_config_1.default.info(`[Auto-Heal] NetSuite Dump: ${dumpMap.size} unique references`);
    // 2. Fetch records from Staging that need healing
    logger_config_1.default.info("[Auto-Heal] Identifying records to heal in MongoDB...");
    const dummyDocs = await dummyCollection.find({
        ns_synced: { $ne: true }
    }, {
        projection: { otherrefnum: 1 }
    }).toArray();
    const bulkOps = [];
    for (const doc of dummyDocs) {
        const ref = String(doc.otherrefnum || "").trim();
        const inDump = dumpMap.get(ref);
        if (inDump) {
            // Determine sync time from NetSuite's creation date
            const nsCreatedDate = inDump.so.createdDate ? new Date(inDump.so.createdDate) : new Date();
            bulkOps.push({
                updateOne: {
                    filter: { _id: doc._id },
                    update: {
                        $set: {
                            ns_synced: true,
                            ns_result: "auto_healed",
                            ns_internal_id: inDump.so.id,
                            ns_tranid: inDump.so.tranid,
                            ns_synced_at: new Date(), // Current time of update
                            ns_note: "Auto-healed: Record found in NetSuite dump"
                        },
                        $unset: {
                            ns_failed: "",
                            ns_error: "",
                            ns_error_at: "",
                            ns_retry_count: ""
                        }
                    }
                }
            });
        }
    }
    if (bulkOps.length > 0) {
        logger_config_1.default.info(`[Auto-Heal] Found ${bulkOps.length} records already in NetSuite. Healing...`);
        try {
            const result = await dummyCollection.bulkWrite(bulkOps, { ordered: false });
            logger_config_1.default.info(`🎉 Successfully healed ${result.modifiedCount} Sales Orders!`);
        }
        catch (err) {
            logger_config_1.default.error(`❌ BulkWrite failed: ${err.message}`);
            if (err.writeErrors) {
                logger_config_1.default.error(`   - First error: ${JSON.stringify(err.writeErrors[0].errmsg || err.writeErrors[0].err?.errmsg)}`);
            }
        }
    }
    else {
        logger_config_1.default.info("✨ No records found that need healing.");
    }
}
autoHealSalesOrders().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
