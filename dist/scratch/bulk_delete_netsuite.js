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
// BULK DELETE SCRIPT — Vendor Bills → Purchase Orders → Sales Orders
// Uses the NetSuite REST API directly with parallel workers (fast)
//
// STEP 1: Run mass_delete_item_fulfillment.ts first (you already did this!)
// STEP 2: Run this script
//
// Run: npx tsx netsuite/scratch/bulk_delete_netsuite.ts
// ─────────────────────────────────────────────────────────────────────────────
// ── CONFIGURATION ────────────────────────────────────────────────────────────
const DRY_RUN = false; // ← LIVE MODE — DELETING FOR REAL
const CONCURRENCY = 3; // ← Parallel workers (stay ≤5 to respect NS limits)
const BATCH_PAUSE = 500; // ← ms to pause between batches
const RETRY_PAUSE = 5000; // ← ms to wait on rate limit (429)
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
// ── NetSuite record type → REST API path ─────────────────────────────────────
const REST_TYPE = {
    vendorbill: "vendorBill",
    purchaseorder: "purchaseOrder",
    // salesorder:    "salesOrder"
};
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
// ── Delete one record via REST API ────────────────────────────────────────────
async function deleteOne(nsType, id, label, retries = 3) {
    if (DRY_RUN) {
        logger_config_1.default.info(`   [DRY RUN] Would delete ${label} (ID: ${id})`);
        return true;
    }
    const path = REST_TYPE[nsType];
    const url = `${BASE_URL}/services/rest/record/v1/${path}/${id}`;
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
            return deleteOne(nsType, id, label, retries - 1);
        }
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`   ❌ Failed to delete ${label}: ${detail}`);
        return false;
    }
}
// ── Delete all records of a given type in parallel batches ───────────────────
async function deleteAll(nsType, sql, labelFn) {
    logger_config_1.default.info(`\n🔍 Querying ${nsType}...`);
    const records = await runAllSuiteQL(sql);
    logger_config_1.default.info(`📋 Found ${records.length} ${nsType} records.`);
    if (records.length === 0)
        return;
    if (!DRY_RUN) {
        logger_config_1.default.warn(`⚠️  Deleting ${records.length} ${nsType} records in 5 seconds... Press Ctrl+C to abort!`);
        await new Promise(r => setTimeout(r, 5000));
    }
    let success = 0;
    let failed = 0;
    for (let i = 0; i < records.length; i += CONCURRENCY) {
        const chunk = records.slice(i, i + CONCURRENCY);
        const batchNum = Math.floor(i / CONCURRENCY) + 1;
        const totalBatches = Math.ceil(records.length / CONCURRENCY);
        logger_config_1.default.info(`🚀 Batch ${batchNum}/${totalBatches}...`);
        const results = await Promise.all(chunk.map(rec => deleteOne(nsType, rec.id, labelFn(rec))));
        success += results.filter(Boolean).length;
        failed += results.filter(r => !r).length;
        await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
    logger_config_1.default.info(`✅ ${nsType} done — deleted: ${success}, failed: ${failed}`);
}
// ── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
    logger_config_1.default.info("=".repeat(60));
    logger_config_1.default.info("🗑️  NETSUITE BULK DELETE — VendBills → POs → SOs");
    logger_config_1.default.info("=".repeat(60));
    if (DRY_RUN) {
        logger_config_1.default.warn("⚠️  DRY RUN — Nothing will be deleted. Set DRY_RUN=false to go live.");
    }
    // ── STEP 1: Query ALL record counts first ────────────────────────────────
    logger_config_1.default.info("\n📊 Querying record counts from NetSuite...");
    const [bills, pos] = await Promise.all([
        runAllSuiteQL(`SELECT id, tranid, otherrefnum, trandate FROM Transaction WHERE type = 'VendBill' ORDER BY id DESC`),
        runAllSuiteQL(`SELECT id, tranid, otherrefnum, trandate FROM Transaction WHERE type = 'PurchOrd' ORDER BY id DESC`)
    ]);
    const total = bills.length + pos.length;
    // ── STEP 2: Show full summary ────────────────────────────────────────────
    logger_config_1.default.info("\n" + "=".repeat(60));
    logger_config_1.default.info("📋 DELETION SUMMARY");
    logger_config_1.default.info("=".repeat(60));
    logger_config_1.default.info(`   Vendor Bills    : ${bills.length}`);
    logger_config_1.default.info(`   Purchase Orders : ${pos.length}`);
    logger_config_1.default.info(`   ─────────────────────────`);
    logger_config_1.default.info(`   TOTAL           : ${total} records`);
    logger_config_1.default.info("=".repeat(60));
    if (total === 0) {
        logger_config_1.default.info("✅ No records found. Nothing to delete.");
        return;
    }
    if (DRY_RUN) {
        logger_config_1.default.warn("⚠️  DRY RUN complete. Set DRY_RUN=false to actually delete these records.");
        return;
    }
    // ── STEP 3: 5-second countdown before deletion ───────────────────────────
    logger_config_1.default.warn(`\n🔴 LIVE DELETE starting in 5 seconds... Press Ctrl+C to ABORT!`);
    for (let i = 5; i >= 1; i--) {
        logger_config_1.default.warn(`   ${i}...`);
        await new Promise(r => setTimeout(r, 1000));
    }
    logger_config_1.default.info("🚀 Starting deletion!\n");
    // ── STEP 4: Delete in order: Bills → POs ──────────────────────────────
    await deleteBatch("vendorbill", bills, r => `VendorBill ${r.tranid || r.otherrefnum} (${r.trandate})`);
    await deleteBatch("purchaseorder", pos, r => `PurchaseOrder ${r.tranid || r.otherrefnum} (${r.trandate})`);
    logger_config_1.default.info("\n" + "=".repeat(60));
    logger_config_1.default.info("🎉 BULK DELETE complete.");
    logger_config_1.default.info("=".repeat(60));
}
// ── Delete a pre-fetched list of records in parallel batches ─────────────────
async function deleteBatch(nsType, records, labelFn) {
    if (records.length === 0)
        return;
    logger_config_1.default.info(`\n🗑️  Deleting ${records.length} ${nsType} records...`);
    let success = 0;
    let failed = 0;
    for (let i = 0; i < records.length; i += CONCURRENCY) {
        const chunk = records.slice(i, i + CONCURRENCY);
        const batchNum = Math.floor(i / CONCURRENCY) + 1;
        const totalBatches = Math.ceil(records.length / CONCURRENCY);
        logger_config_1.default.info(`   Batch ${batchNum}/${totalBatches}...`);
        const results = await Promise.all(chunk.map(rec => deleteOne(nsType, rec.id, labelFn(rec))));
        success += results.filter(Boolean).length;
        failed += results.filter(r => !r).length;
        await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
    logger_config_1.default.info(`   ✅ ${nsType} done — deleted: ${success}, failed: ${failed}`);
}
run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
