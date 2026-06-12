"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const logger_config_1 = __importDefault(require("../config/logger.config"));
// ─────────────────────────────────────────────────────────────────────────────
// BULK DELETE CUSTOMER INVOICES SCRIPT
// Uses the NetSuite REST API directly with parallel workers
//
// Run: npx tsx netsuite/scratch/bulk_delete_invoices.ts
// ─────────────────────────────────────────────────────────────────────────────
// ── CONFIGURATION ────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← Set to false to perform the live deletion
const CONCURRENCY = 3; // ← Parallel workers (stay ≤5 to respect NS limits)
const BATCH_PAUSE = 500; // ← ms to pause between batches
const RETRY_PAUSE = 5000; // ← ms to wait on rate limit (429)
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
// ── Paginated SuiteQL query ───────────────────────────────────────────────────
async function runAllSuiteQL(sql) {
    const baseUrl = `${BASE_URL}/services/rest/query/v1/suiteql`;
    let allItems = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
        const url = `${baseUrl}?limit=${limit}&offset=${offset}`;
        try {
            const res = await axios_1.default.post(url, { q: sql }, {
                headers: {
                    Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                    "Content-Type": "application/json",
                    Prefer: "transient"
                },
                timeout: 60000
            });
            const items = res.data.items || [];
            allItems.push(...items);
            logger_config_1.default.info(`   📥 Fetched ${allItems.length} records so far...`);
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
// ── Delete one invoice via REST API ────────────────────────────────────────────
async function deleteOne(id, label, retries = 3) {
    if (DRY_RUN) {
        logger_config_1.default.info(`   [DRY RUN] Would delete ${label} (ID: ${id})`);
        return true;
    }
    const url = `${BASE_URL}/services/rest/record/v1/invoice/${id}`;
    try {
        await axios_1.default.delete(url, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "DELETE"),
                "Content-Type": "application/json"
            },
            timeout: 60000
        });
        logger_config_1.default.info(`   ✅ Deleted ${label} (ID: ${id})`);
        return true;
    }
    catch (err) {
        const status = err.response?.status;
        if ((status === 429 || err.code === "ECONNABORTED") && retries > 0) {
            logger_config_1.default.warn(`   ⚠️ Rate limited on ${label} — waiting ${RETRY_PAUSE / 1000}s (${retries} retries left)`);
            await new Promise(r => setTimeout(r, RETRY_PAUSE));
            return deleteOne(id, label, retries - 1);
        }
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`   ❌ Failed to delete ${label}: ${detail}`);
        return false;
    }
}
// ── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
    logger_config_1.default.info("=".repeat(60));
    logger_config_1.default.info("🗑️  NETSUITE BULK DELETE — Customer Invoices");
    logger_config_1.default.info("=".repeat(60));
    if (DRY_RUN) {
        logger_config_1.default.warn("⚠️  DRY RUN — Nothing will be deleted. Set DRY_RUN=false to go live.");
    }
    // Query all Invoices
    logger_config_1.default.info("\n📊 Querying invoice counts from NetSuite...");
    const invoices = await runAllSuiteQL(`SELECT id, tranid, otherrefnum, trandate FROM Transaction WHERE type = 'CustInvc' ORDER BY id DESC`);
    logger_config_1.default.info("\n" + "=".repeat(60));
    logger_config_1.default.info("📋 DELETION SUMMARY");
    logger_config_1.default.info("=".repeat(60));
    logger_config_1.default.info(`   Customer Invoices: ${invoices.length}`);
    logger_config_1.default.info("=".repeat(60));
    if (invoices.length === 0) {
        logger_config_1.default.info("✅ No invoices found. Nothing to delete.");
        return;
    }
    if (DRY_RUN) {
        logger_config_1.default.warn("⚠️  DRY RUN complete. To perform deletion, set DRY_RUN=false in the script.");
        // Print the first few that would be deleted as a sample
        logger_config_1.default.info("\nSample of invoices to be deleted:");
        invoices.slice(0, 10).forEach(rec => {
            logger_config_1.default.info(`   - Invoice ${rec.tranid || rec.otherrefnum} (${rec.trandate}) (ID: ${rec.id})`);
        });
        if (invoices.length > 10) {
            logger_config_1.default.info(`   ...and ${invoices.length - 10} more.`);
        }
        return;
    }
    // 5-second countdown before live deletion
    logger_config_1.default.warn(`\n🔴 LIVE DELETE starting in 5 seconds... Press Ctrl+C to ABORT!`);
    for (let i = 5; i >= 1; i--) {
        logger_config_1.default.warn(`   ${i}...`);
        await new Promise(r => setTimeout(r, 1000));
    }
    logger_config_1.default.info("🚀 Starting deletion!\n");
    let success = 0;
    let failed = 0;
    for (let i = 0; i < invoices.length; i += CONCURRENCY) {
        const chunk = invoices.slice(i, i + CONCURRENCY);
        const batchNum = Math.floor(i / CONCURRENCY) + 1;
        const totalBatches = Math.ceil(invoices.length / CONCURRENCY);
        logger_config_1.default.info(`   Batch ${batchNum}/${totalBatches}...`);
        const results = await Promise.all(chunk.map(rec => deleteOne(rec.id, `Invoice ${rec.tranid || rec.otherrefnum} (${rec.trandate})`)));
        success += results.filter(Boolean).length;
        failed += results.filter(r => !r).length;
        await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
    logger_config_1.default.info("\n" + "=".repeat(60));
    logger_config_1.default.info(`🎉 BULK DELETE complete. Deleted: ${success}, Failed: ${failed}`);
    logger_config_1.default.info("=".repeat(60));
}
run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
