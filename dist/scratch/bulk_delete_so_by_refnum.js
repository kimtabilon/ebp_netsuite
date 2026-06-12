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
const REF_NUMBERS = [
    "112-7365280-6239462",
    "114-1240799-7929817",
    "114-7193284-4133010",
    "111-5426495-1376206",
    "111-4456246-4771408",
    "114-5070890-3969035",
    "114-0431643-0555448",
    "112-8360843-8509865",
    //   "113-3198031-8773037",
    //   "113-0156435-0692218",
    //   "111-4456246-4771408",
    //   "111-6213754-5071416",
    //   "111-5426495-1376206",
    //   "111-4558020-7919402",
    //   "113-5913528-6162633",
    //   "111-9362558-0480203",
    //   "114-7193284-4133010",
    //   "112-1275084-2389057",
    //   "114-2434378-7891430",
    //   "112-3961986-0813811",
    //   "112-6391992-0180235",
    //   "111-5763362-3448205",
    //   "113-8673602-4612228",
    //   "114-1240799-7929817",
    //   "114-2608903-7118667",
    //   "114-6820696-3008212",
    //   "113-7758514-6890615",
    //   "113-3586588-7621013",
    //   "112-7365280-6239462",
    //   "114-9418653-3797842",
    //   "113-8009927-5632236",
    //   "112-1372130-1192251",
    //   "114-8129998-3557048",
    //   "111-0515940-5071408",
    //   "114-1708391-6713867",
    //   "114-1112684-4445840",
    //   "111-2190202-0749069",
    //   "112-9174162-2639432",
    //   "112-7607615-2879436",
    //   "113-9899020-6775464",
    //   "112-0836976-0690653",
    //   "111-5010935-4655425",
    //   "111-1536747-0679411",
    //   "114-0739903-3804240",
    //   "113-9926866-5338658",
    //   "112-4012629-5581853",
    //   "114-6207290-5275434",
    //   "111-9222466-4793801",
    //   "111-7393845-4285845",
    //   "114-1762651-8346660",
    //   "113-8487820-9536229",
    //   "114-7189576-3798655",
    //   "112-8568025-7532248",
    //   "113-6213711-3827463",
    //   "111-7229187-7529050",
    //   "111-4960059-8719444",
    //   "114-2491168-4829054",
    //   "114-6085416-3274620",
    //   "113-1725811-6050623",
    //   "111-2938904-1963433",
    //   "111-5611034-9937043",
    //   "112-5058509-3313024",
    //   "113-3809247-4046611",
    //   "113-6038482-1558606",
    //   "112-5680574-8461810",
    //   "114-0848430-9663454",
    //   "114-6956000-9468208",
    //   "112-3734156-0263429",
    //   "111-2042060-8218640",
    //   "113-5604760-9613858",
    //   "113-5819551-1615461",
    //   "112-4322224-5081856",
    //   "113-8076241-6384231",
    //   "113-4879840-2725023",
    //   "112-8360843-8509865",
    //   "114-0431643-0555448",
    //   "114-5381376-3365010",
    //   "114-6080301-5914635",
    //   "111-0837049-4391406",
    //   "114-5070890-3969035",
    //   "111-4045120-7638636",
    //   "113-5146235-5053804",
    //   "111-4159286-5646660",
    //   "111-1324868-6103448",
    //   "111-4328418-5626654",
    //   "114-7207044-6666660",
    //   "112-9136496-6641025",
    //   "114-3945973-0530608",
    //   "111-4443401-3903465",
    //   "112-8699360-9413056",
    //   "114-7534521-7069825",
    //   "114-5652999-9810642",
    //   "112-2895705-4601856",
    //   "112-7072853-3236214",
    //   "112-4101974-5929864",
    //   "112-1759622-7415433",
    //   "112-8740429-0678627",
    //   "114-8250330-8921021",
    //   "114-3412312-0840202",
    //   "112-6303627-8747458",
    //   "113-0025330-6307438",
    //   "113-6599685-9206654",
    //   "114-2867116-4221011",
    //   "113-1146578-7921039",
    //   "1207857592"
];
async function findSalesOrders(refNums) {
    const baseUrl = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
    const url = `${baseUrl}/services/rest/query/v1/suiteql`;
    // Chunk lists into groups of 50 to avoid query size limits
    const CHUNK_SIZE = 50;
    const allResults = [];
    for (let i = 0; i < refNums.length; i += CHUNK_SIZE) {
        const chunk = refNums.slice(i, i + CHUNK_SIZE);
        const inClause = chunk.map(r => `'${r}'`).join(",");
        const sql = `SELECT id, tranid, otherrefnum FROM transaction WHERE type = 'SalesOrd' AND (otherrefnum IN (${inClause}) OR tranid IN (${inClause}))`;
        try {
            const res = await axios_1.default.post(url, { q: sql }, {
                headers: {
                    Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                    "Content-Type": "application/json",
                    Prefer: "transient"
                },
                timeout: 60000
            });
            allResults.push(...(res.data.items || []));
        }
        catch (err) {
            logger_config_1.default.error("SuiteQL Error searching for Sales Orders chunk:", err.response?.data || err.message);
        }
    }
    return allResults.map((x) => ({
        id: parseInt(x.id, 10),
        tranid: String(x.tranid),
        otherrefnum: String(x.otherrefnum || "")
    }));
}
async function run() {
    const confirm = process.argv[2] === "--confirm";
    logger_config_1.default.info(`🔍 Searching NetSuite for ${REF_NUMBERS.length} Sales Orders...`);
    const foundSOs = await findSalesOrders(REF_NUMBERS);
    if (foundSOs.length === 0) {
        logger_config_1.default.warn(`❌ None of the requested ${REF_NUMBERS.length} Sales Orders were found in NetSuite.`);
        process.exit(0);
    }
    logger_config_1.default.info(`\nMatched ${foundSOs.length} Sales Orders in NetSuite:`);
    console.table(foundSOs);
    const missing = REF_NUMBERS.filter(ref => !foundSOs.some(so => so.otherrefnum === ref || so.tranid === ref));
    if (missing.length > 0) {
        logger_config_1.default.warn(`⚠️ The following ${missing.length} reference numbers could not be found:`);
        console.log(missing.join(", "));
    }
    if (!confirm) {
        logger_config_1.default.warn(`\n⚠️ DRY RUN: Pass '--confirm' to actually perform the deep deletion of these ${foundSOs.length} orders.`);
        logger_config_1.default.warn(`Example: npx tsx netsuite/scratch/bulk_delete_so_by_refnum.ts --confirm`);
        process.exit(0);
    }
    const idsToDelete = foundSOs.map(so => so.id);
    logger_config_1.default.warn(`\n🚨 DANGER: Performing deep deletion on NetSuite for ${idsToDelete.length} Sales Orders!`);
    logger_config_1.default.warn(`This will recursively purge ALL linked child records (POs, Fulfillments, Bills) to ensure clean deletion.`);
    logger_config_1.default.info("Starting deletion in 5 seconds... (Press Ctrl+C to abort)");
    await new Promise(resolve => setTimeout(resolve, 5000));
    // We call the RESTlet in small batches of 5 to avoid script execution timeouts and stay well within governance limits
    const BATCH_SIZE = 5;
    let deletedCount = 0;
    let failedCount = 0;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
        const batchIds = idsToDelete.slice(i, i + BATCH_SIZE);
        logger_config_1.default.info(`🚀 Deleting batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(idsToDelete.length / BATCH_SIZE)} (IDs: ${batchIds.join(", ")})...`);
        try {
            const cleanupResult = await (0, netsuite_client_1.callCleanup)({
                action: "delete_ids",
                recordType: "salesorder",
                ids: batchIds
            });
            if (cleanupResult && cleanupResult.success && cleanupResult.data) {
                const summary = cleanupResult.data.summary;
                deletedCount += summary.deletedCount || 0;
                failedCount += summary.errorCount || 0;
                logger_config_1.default.info(`   Batch Results → Deleted: ${summary.deletedCount}, Failed: ${summary.errorCount}`);
                if (summary.errorCount > 0) {
                    console.log(JSON.stringify(cleanupResult.data.failedIds, null, 2));
                }
            }
            else {
                failedCount += batchIds.length;
                logger_config_1.default.error(`   ❌ Batch failed completely:`, cleanupResult?.error || "Unknown RESTlet response");
            }
        }
        catch (err) {
            failedCount += batchIds.length;
            logger_config_1.default.error(`   ❌ Exception occurred during batch deletion:`, err.message);
        }
        // Small pause between batches to prevent concurrency locks
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    logger_config_1.default.info(`\n🎉 Process Finished!`);
    logger_config_1.default.info(`   - Total Sales Orders requested: ${idsToDelete.length}`);
    logger_config_1.default.info(`   - Successfully deleted: ${deletedCount}`);
    logger_config_1.default.info(`   - Failed to delete: ${failedCount}`);
}
run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
