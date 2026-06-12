"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const logger_config_1 = __importDefault(require("../config/logger.config"));
const netsuite_client_1 = require("../services/netsuite.client");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const ACCOUNT = process.env.NS_ACCOUNT_ID;
async function findSalesOrder(otherRefNum) {
    const baseUrl = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
    const url = `${baseUrl}/services/rest/query/v1/suiteql`;
    const sql = `SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' AND (otherrefnum = '${otherRefNum}' OR tranid = '${otherRefNum}')`;
    try {
        const res = await axios_1.default.post(url, { q: sql }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                "Content-Type": "application/json",
                Prefer: "transient"
            },
            timeout: 60000
        });
        return (res.data.items || []).map((x) => ({ id: parseInt(x.id, 10), tranid: String(x.tranid) }));
    }
    catch (err) {
        logger_config_1.default.error("SuiteQL Error searching for Sales Order:", err.response?.data || err.message);
        return [];
    }
}
async function run() {
    const otherRefNum = process.argv[2];
    const confirm = process.argv[3] === "--confirm";
    if (!otherRefNum) {
        console.log("\n❌ Error: Missing otherrefnum.");
        console.log("Usage: npx tsx netsuite/scratch/delete_so_by_refnum.ts <OTHERREFNUM_OR_TRANID> [--confirm]\n");
        process.exit(1);
    }
    logger_config_1.default.info(`🔍 Searching NetSuite for Sales Order with reference/number: "${otherRefNum}"...`);
    const soList = await findSalesOrder(otherRefNum);
    if (soList.length === 0) {
        logger_config_1.default.warn(`❌ No Sales Order found in NetSuite matching: "${otherRefNum}"`);
        process.exit(0);
    }
    logger_config_1.default.info(`\nFound matching Sales Order(s):`);
    console.table(soList);
    if (!confirm) {
        logger_config_1.default.warn(`⚠️ DRY RUN: Pass '--confirm' as the second parameter to actually perform the deep deletion.`);
        logger_config_1.default.warn(`Example: npx tsx netsuite/scratch/delete_so_by_refnum.ts ${otherRefNum} --confirm`);
        process.exit(0);
    }
    const ids = soList.map(so => so.id);
    logger_config_1.default.warn(`\n⚠️  WARNING: Performing deep deletion on NetSuite for Sales Order IDs: ${ids.join(", ")}`);
    logger_config_1.default.warn(`This will automatically find and purge all related Purchase Orders, Item Fulfillments, or Bills!`);
    logger_config_1.default.info("Starting deletion in 3 seconds... (Press Ctrl+C to abort)");
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
        logger_config_1.default.info(`🚀 Calling Cleanup RESTlet to delete Sales Orders: ${ids.join(", ")}...`);
        const cleanupResult = await (0, netsuite_client_1.callCleanup)({
            action: "delete_ids",
            recordType: "salesorder",
            ids: ids
        });
        logger_config_1.default.info("Cleanup RESTlet response:");
        console.log(JSON.stringify(cleanupResult, null, 2));
        if (cleanupResult && cleanupResult.success) {
            logger_config_1.default.info("🎉 Deep deletion completed successfully!");
        }
        else {
            logger_config_1.default.error("❌ Cleanup RESTlet reported failure:", cleanupResult?.error || "Unknown RESTlet error");
        }
    }
    catch (err) {
        logger_config_1.default.error("❌ Exception occurred during RESTlet call:", err.message);
    }
}
run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
