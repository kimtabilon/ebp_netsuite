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
const CONCURRENCY = 3;
// Get ID from command line argument
const TEST_ID = process.argv[2];
async function runAllSuiteQL(query) {
    const baseUrl = `${BASE_URL}/services/rest/query/v1/suiteql`;
    let allItems = [];
    let offset = 0;
    const limit = 1000;
    logger_config_1.default.info("🔍 Fetching all matching Sales Orders (this might take a moment)...");
    while (true) {
        // Correctly include limit and offset in the URL for the OAuth signature
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
            logger_config_1.default.info(`📥 Retrieved ${allItems.length} orders so far...`);
            if (items.length < limit)
                break;
            offset += limit;
        }
        catch (err) {
            logger_config_1.default.error("❌ SuiteQL Error during fetch:", err.response?.data || err.message);
            break;
        }
    }
    return allItems;
}
async function clearLocation(soInternalId, tranid, retries = 3) {
    const url = `${BASE_URL}/services/rest/record/v1/salesOrder/${soInternalId}`;
    try {
        await axios_1.default.patch(url, { location: null }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "PATCH"),
                "Content-Type": "application/json"
            },
            timeout: 60000
        });
        logger_config_1.default.info(`✅ Cleared: ${tranid}`);
        return true;
    }
    catch (err) {
        if ((err.response?.status === 429 || err.code === 'ECONNABORTED') && retries > 0) {
            const waitTime = err.response?.status === 429 ? 5000 : 2000;
            logger_config_1.default.warn(`⚠️ NetSuite busy on ${tranid}. Waiting ${waitTime / 1000}s and retrying... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return clearLocation(soInternalId, tranid, retries - 1);
        }
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`❌ Failed ${tranid}: ${detail}`);
        return false;
    }
}
async function massClearLocations() {
    if (TEST_ID) {
        logger_config_1.default.info(`🧪 Running test for a single ID: ${TEST_ID}`);
        await clearLocation(TEST_ID, "TEST_ORDER");
        return;
    }
    const sql = `
        SELECT tl.transaction as id, t.tranid
        FROM transactionLine tl
        JOIN transaction t ON t.id = tl.transaction
        WHERE tl.mainline = 'T' 
        AND t.type = 'SalesOrd' 
        AND tl.location IS NOT NULL
        AND t.status IN ('A', 'B')
        ORDER BY tl.transaction DESC
    `;
    const orders = await runAllSuiteQL(sql);
    logger_config_1.default.info(`📋 TOTAL: Found ${orders.length} orders that need clearing.`);
    let successCount = 0;
    for (let i = 0; i < orders.length; i += CONCURRENCY) {
        const chunk = orders.slice(i, i + CONCURRENCY);
        logger_config_1.default.info(`🚀 Processing batch ${Math.floor(i / CONCURRENCY) + 1} of ${Math.ceil(orders.length / CONCURRENCY)}...`);
        const results = await Promise.all(chunk.map(order => clearLocation(order.id, order.tranid)));
        successCount += results.filter(r => r).length;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    logger_config_1.default.info(`✅ Finished! Successfully cleared ${successCount} out of ${orders.length} orders.`);
}
massClearLocations().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
