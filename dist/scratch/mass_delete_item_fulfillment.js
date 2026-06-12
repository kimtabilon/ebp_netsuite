"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const axios_1 = __importDefault(require("axios"));
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
const CONCURRENCY = 3; // Stay safe with NetSuite limits
// Get ID from command line argument for testing
const TEST_ID = process.argv[2];
async function runAllSuiteQL(query) {
    const baseUrl = `${BASE_URL}/services/rest/query/v1/suiteql`;
    let allItems = [];
    let offset = 0;
    const limit = 1000;
    logger_config_1.default.info("🔍 Searching for Item Fulfillments to delete...");
    while (true) {
        const paginatedUrl = `${baseUrl}?limit=${limit}&offset=${offset}`;
        try {
            const res = await axios_1.default.post(paginatedUrl, { q: query }, {
                headers: {
                    Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(paginatedUrl, "POST"),
                    "Content-Type": "application/json",
                    Prefer: "transient"
                },
                timeout: 60000
            });
            const items = res.data.items || [];
            allItems.push(...items);
            logger_config_1.default.info(`📥 Found ${allItems.length} records so far...`);
            if (items.length < limit)
                break;
            offset += limit;
        }
        catch (err) {
            logger_config_1.default.error("❌ SuiteQL Error:", err.response?.data || err.message);
            break;
        }
    }
    return allItems;
}
async function deleteIF(id, tranid, retries = 3) {
    const url = `${BASE_URL}/services/rest/record/v1/itemFulfillment/${id}`;
    try {
        await axios_1.default.delete(url, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "DELETE"),
                "Content-Type": "application/json"
            },
            timeout: 60000
        });
        logger_config_1.default.info(`✅ Deleted: ${tranid} (ID: ${id})`);
        return true;
    }
    catch (err) {
        if ((err.response?.status === 429 || err.code === 'ECONNABORTED') && retries > 0) {
            const waitTime = err.response?.status === 429 ? 5000 : 2000;
            logger_config_1.default.warn(`⚠️ NetSuite busy on ${tranid}. Waiting ${waitTime / 1000}s and retrying... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return deleteIF(id, tranid, retries - 1);
        }
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`❌ Failed ${tranid}: ${detail}`);
        return false;
    }
}
async function massDeleteFulfillments() {
    if (TEST_ID) {
        logger_config_1.default.info(`🧪 Running single-ID test: Deleting IF ID ${TEST_ID}`);
        await deleteIF(TEST_ID, "TEST_RECORD");
        return;
    }
    // QUERY CRITERIA: Adjust this WHERE clause to target specific records!
    const sql = `
        SELECT id, tranid 
        FROM transaction 
        WHERE type = 'ItemShip'
        ORDER BY id DESC
    `;
    const records = await runAllSuiteQL(sql);
    logger_config_1.default.info(`📋 TOTAL: Found ${records.length} Item Fulfillments to delete.`);
    if (records.length === 0)
        return;
    // Safety Prompt (Simulated)
    logger_config_1.default.warn("⚠️ WARNING: You are about to delete " + records.length + " records. Starting in 5 seconds...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    let successCount = 0;
    for (let i = 0; i < records.length; i += CONCURRENCY) {
        const chunk = records.slice(i, i + CONCURRENCY);
        logger_config_1.default.info(`🚀 Processing batch ${Math.floor(i / CONCURRENCY) + 1} of ${Math.ceil(records.length / CONCURRENCY)}...`);
        const results = await Promise.all(chunk.map(rec => deleteIF(rec.id, rec.tranid)));
        successCount += results.filter(r => r).length;
        // Short pause between batches
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    logger_config_1.default.info(`✅ Finished! Successfully deleted ${successCount} out of ${records.length} records.`);
}
massDeleteFulfillments().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
