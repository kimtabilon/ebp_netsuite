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
// Optional: pass a single ID on the command line for testing
// Usage: npx tsx netsuite/scratch/mass_delete_vendor_credits.ts <ID>
const TEST_ID = process.argv[2];
// Optional: filter by transaction date (YYYY-MM-DD) — set to null to delete all
const CREATED_AFTER = "2026-05-01"; // Only delete credits with trandate on/after this date
const CREATED_BEFORE = null; // Set to e.g. "2026-05-12" to add an upper bound
async function runAllSuiteQL(query) {
    const baseUrl = `${BASE_URL}/services/rest/query/v1/suiteql`;
    let allItems = [];
    let offset = 0;
    const limit = 1000;
    logger_config_1.default.info("🔍 Searching for Vendor Credits to delete...");
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
async function deleteVendorCredit(id, tranid, retries = 3) {
    const url = `${BASE_URL}/services/rest/record/v1/vendorCredit/${id}`;
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
        if ((err.response?.status === 429 || err.code === "ECONNABORTED") && retries > 0) {
            const waitTime = err.response?.status === 429 ? 5000 : 2000;
            logger_config_1.default.warn(`⚠️ NetSuite busy on ${tranid}. Waiting ${waitTime / 1000}s and retrying... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return deleteVendorCredit(id, tranid, retries - 1);
        }
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`❌ Failed ${tranid} (ID: ${id}): ${detail}`);
        return false;
    }
}
async function massDeleteVendorCredits() {
    if (TEST_ID) {
        logger_config_1.default.info(`🧪 Running single-ID test: Deleting Vendor Credit ID ${TEST_ID}`);
        await deleteVendorCredit(TEST_ID, "TEST_RECORD");
        return;
    }
    // Build the WHERE clause dynamically based on date filters
    let dateFilter = "";
    if (CREATED_AFTER)
        dateFilter += ` AND trandate >= '${CREATED_AFTER}'`;
    if (CREATED_BEFORE)
        dateFilter += ` AND trandate <= '${CREATED_BEFORE}'`;
    // QUERY CRITERIA: All Vendor Credits. We'll filter by tranid prefix after fetching.
    const sql = `SELECT id, tranid FROM transaction WHERE type = 'VendCred' ORDER BY id DESC`;
    logger_config_1.default.info("📝 Running SQL: " + sql);
    const allRecords = await runAllSuiteQL(sql);
    // Filter in-memory: only delete credits created by our restlet (tranid starts with "PO")
    const records = allRecords.filter(r => r.tranid && String(r.tranid).startsWith("PO"));
    logger_config_1.default.info(`📋 TOTAL: Found ${allRecords.length} VendCred total → ${records.length} match "PO*" tranid pattern.`);
    if (records.length === 0) {
        logger_config_1.default.info("Nothing to delete. Exiting.");
        return;
    }
    // Safety pause before mass delete
    logger_config_1.default.warn(`⚠️  WARNING: You are about to permanently delete ${records.length} Vendor Credits. Starting in 5 seconds... (Ctrl+C to abort)`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    let successCount = 0;
    for (let i = 0; i < records.length; i += CONCURRENCY) {
        const chunk = records.slice(i, i + CONCURRENCY);
        logger_config_1.default.info(`🚀 Processing batch ${Math.floor(i / CONCURRENCY) + 1} of ${Math.ceil(records.length / CONCURRENCY)}...`);
        const results = await Promise.all(chunk.map(rec => deleteVendorCredit(rec.id, rec.tranid)));
        successCount += results.filter(r => r).length;
        // Short pause between batches to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    logger_config_1.default.info(`✅ Finished! Successfully deleted ${successCount} out of ${records.length} Vendor Credits.`);
}
massDeleteVendorCredits().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
