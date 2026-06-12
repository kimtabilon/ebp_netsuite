"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const normalizeRef = (val) => {
    if (!val)
        return null;
    return String(val).toUpperCase().trim();
};
async function checkParity() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const DUMP_COL = "bill_dump_test";
    const SUITE_COL = "suite_vendor_bill_dummy";
    logger_config_1.default.info("\n=== Bill Parity Check: Dump vs Dummy ===\n");
    // 1. Fetch data
    const [dumpDocs, suiteDocs] = await Promise.all([
        db.collection(DUMP_COL).find({}).project({ "bill.tranid": 1 }).toArray(),
        db.collection(SUITE_COL).find({ ns_synced: true }).project({ reference_number: 1 }).toArray()
    ]);
    logger_config_1.default.info(`Records in Dump: ${dumpDocs.length}`);
    logger_config_1.default.info(`Records in Dummy (ns_synced: true): ${suiteDocs.length}`);
    // 2. Build Maps
    const dumpMap = new Map();
    for (const d of dumpDocs) {
        const key = normalizeRef(d.bill?.tranid);
        if (key)
            dumpMap.set(key, d);
    }
    const suiteMap = new Map();
    for (const s of suiteDocs) {
        const key = normalizeRef(s.reference_number);
        if (key)
            suiteMap.set(key, s);
    }
    // 3. Find Differences
    const dumpKeys = Array.from(dumpMap.keys());
    const suiteKeys = Array.from(suiteMap.keys());
    const onlyInDump = dumpKeys.filter(k => !suiteMap.has(k));
    const onlyInSuite = suiteKeys.filter(k => !dumpMap.has(k));
    logger_config_1.default.info(`\n--- Results ---`);
    logger_config_1.default.info(`Only in Dump (Missing in Dummy): ${onlyInDump.length}`);
    logger_config_1.default.info(`Only in Dummy (Extra in Dummy): ${onlyInSuite.length}`);
    if (onlyInDump.length > 0) {
        logger_config_1.default.info(`\n--- Bills ONLY IN DUMP (${onlyInDump.length}) ---`);
        // Grouping for better display if many
        for (let i = 0; i < onlyInDump.length; i += 50) {
            logger_config_1.default.info(onlyInDump.slice(i, i + 50).join(", "));
        }
    }
    if (onlyInSuite.length > 0) {
        logger_config_1.default.info(`\n--- Bills ONLY IN DUMMY (${onlyInSuite.length}) ---`);
        for (let i = 0; i < onlyInSuite.length; i += 50) {
            logger_config_1.default.info(onlyInSuite.slice(i, i + 50).join(", "));
        }
    }
    logger_config_1.default.info("\n=== DONE ===\n");
}
checkParity().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
