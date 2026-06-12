"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const normalizePO = (val) => {
    if (!val)
        return null;
    let result = String(val)
        .toUpperCase()
        .replace(/PO/i, "")
        .replace(/[^0-9]/g, "")
        .trim();
    return result || null;
};
async function checkParity() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const DUMP_COL = "po_dump_test";
    const SUITE_COL = "suite_purchase_order_dummy";
    logger_config_1.default.info("\n=== PO Parity Check: Dump vs Dummy ===\n");
    // 1. Fetch data
    const [dumpDocs, suiteDocs] = await Promise.all([
        db.collection(DUMP_COL).find({}).project({ "po.tranid": 1, "po.otherRefNum": 1 }).toArray(),
        db.collection(SUITE_COL).find({ ns_synced: true }).project({ po_number: 1 }).toArray()
    ]);
    logger_config_1.default.info(`Records in Dump: ${dumpDocs.length}`);
    logger_config_1.default.info(`Records in Dummy (ns_synced: true): ${suiteDocs.length}`);
    // 2. Build Maps
    const dumpMap = new Map();
    for (const d of dumpDocs) {
        const key = normalizePO(d.po?.tranid || d.po?.otherRefNum);
        if (key)
            dumpMap.set(key, d);
    }
    const suiteMap = new Map();
    for (const s of suiteDocs) {
        const key = normalizePO(s.po_number);
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
        logger_config_1.default.info(`\n--- POs ONLY IN DUMP (${onlyInDump.length}) ---`);
        logger_config_1.default.info(onlyInDump.join(", "));
    }
    if (onlyInSuite.length > 0) {
        logger_config_1.default.info(`\n--- POs ONLY IN DUMMY (${onlyInSuite.length}) ---`);
        logger_config_1.default.info(onlyInSuite.join(", "));
    }
    logger_config_1.default.info("\n=== DONE ===\n");
}
checkParity().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
