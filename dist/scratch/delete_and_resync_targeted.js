"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
// =============================================================================
// TARGET LIST — Fill in your otherrefnum (website order numbers) and po_numbers
// =============================================================================
const TARGET_WEBSITE_ORDER_NUMBERS = [
// e.g. "111-7013803-5073813",
// e.g. "112-5192961-3001851",
];
const TARGET_PO_NUMBERS = [
// e.g. "232139",
// e.g. "232574",
];
// =============================================================================
const DRY_RUN = true; // ← Set to false to actually delete
const CONCURRENCY = 3;
const BATCH_PAUSE = 700;
const RETRY_PAUSE = 5000;
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
// ── REST type map ─────────────────────────────────────────────────────────────
const REST_TYPE = {
    vendorbill: "vendorBill",
    itemfulfillment: "itemFulfillment",
    purchaseorder: "purchaseOrder",
    salesorder: "salesOrder",
};
// ── SuiteQL paginated query ───────────────────────────────────────────────────
async function runSuiteQL(sql) {
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
            if (items.length < limit)
                break;
            offset += limit;
        }
        catch (err) {
            logger_config_1.default.error("SuiteQL Error:", err.response?.data || err.message);
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
            logger_config_1.default.warn(`   ⚠️ Rate limited on ${label} — waiting ${RETRY_PAUSE / 1000}s`);
            await new Promise(r => setTimeout(r, RETRY_PAUSE));
            return deleteOne(nsType, id, label, retries - 1);
        }
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`   ❌ Failed to delete ${label}: ${detail}`);
        return false;
    }
}
// ── Delete a batch of records in parallel chunks ──────────────────────────────
async function deleteBatch(nsType, records, labelFn) {
    if (records.length === 0)
        return { deleted: 0, failed: 0 };
    logger_config_1.default.info(`\n🗑️  Deleting ${records.length} ${nsType}...`);
    let deleted = 0, failed = 0;
    for (let i = 0; i < records.length; i += CONCURRENCY) {
        const chunk = records.slice(i, i + CONCURRENCY);
        const results = await Promise.all(chunk.map(r => deleteOne(nsType, r.id, labelFn(r))));
        deleted += results.filter(Boolean).length;
        failed += results.filter(r => !r).length;
        await new Promise(r => setTimeout(r, BATCH_PAUSE));
    }
    logger_config_1.default.info(`   ✅ ${nsType}: deleted=${deleted}, failed=${failed}`);
    return { deleted, failed };
}
// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
    logger_config_1.default.info("=".repeat(65));
    logger_config_1.default.info("🎯  TARGETED DELETE — Bills / IFs / POs / SOs → Resync Bills");
    logger_config_1.default.info("=".repeat(65));
    if (TARGET_WEBSITE_ORDER_NUMBERS.length === 0 && TARGET_PO_NUMBERS.length === 0) {
        logger_config_1.default.error("❌ No targets specified! Fill in TARGET_WEBSITE_ORDER_NUMBERS or TARGET_PO_NUMBERS.");
        return;
    }
    if (DRY_RUN) {
        logger_config_1.default.warn("⚠️  DRY RUN MODE — nothing will be deleted. Set DRY_RUN=false to go live.");
    }
    // ── Build IN clause values ────────────────────────────────────────────────
    const soInClause = TARGET_WEBSITE_ORDER_NUMBERS.map(v => `'${v}'`).join(", ");
    const poInClause = TARGET_PO_NUMBERS.map(v => `'${v}'`).join(", ");
    // ── STEP 1: Resolve SO internal IDs from otherrefnum ─────────────────────
    let soIds = [];
    if (soInClause) {
        logger_config_1.default.info("\n📊 Resolving Sales Orders by website_order_number...");
        const soRows = await runSuiteQL(`SELECT id, tranid, otherrefnum FROM transaction WHERE type = 'SalesOrd' AND otherrefnum IN (${soInClause})`);
        soIds = soRows.map(r => r.id);
        soRows.forEach(r => logger_config_1.default.info(`   → SO: ${r.tranid} | ID: ${r.id} | otherrefnum: ${r.otherrefnum}`));
        logger_config_1.default.info(`   Found ${soIds.length} Sales Orders`);
    }
    // ── STEP 2: Resolve PO internal IDs from tranid ──────────────────────────
    let poIds = [];
    let poRows = [];
    if (poInClause) {
        logger_config_1.default.info("\n📊 Resolving Purchase Orders by po_number...");
        poRows = await runSuiteQL(`SELECT id, tranid, otherrefnum FROM transaction WHERE type = 'PurchOrd' AND (tranid IN (${poInClause}) OR otherrefnum IN (${poInClause}))`);
        // Post-filter exact match to prevent fuzzy matches
        poRows = poRows.filter(r => TARGET_PO_NUMBERS.some(p => r.tranid === `PO${p}` || r.tranid === p || r.otherrefnum === p));
        poIds = poRows.map(r => r.id);
        poRows.forEach(r => logger_config_1.default.info(`   → PO: ${r.tranid} | ID: ${r.id}`));
        logger_config_1.default.info(`   Found ${poIds.length} Purchase Orders`);
    }
    const allSoIds = soIds;
    const allPoIds = poIds;
    if (allSoIds.length === 0 && allPoIds.length === 0) {
        logger_config_1.default.warn("⚠️  No matching NetSuite records found. Check your target lists.");
        return;
    }
    // ── STEP 3: Find all linked child records (Bills, IFs, IRs) ──────────────
    logger_config_1.default.info("\n📊 Querying linked child records...");
    const soIdList = allSoIds.join(", ") || "0";
    const poIdList = allPoIds.join(", ") || "0";
    const [bills, ifsFromSo] = await Promise.all([
        // Vendor Bills linked to the SOs (via createdfrom)
        allSoIds.length > 0
            ? runSuiteQL(`SELECT id, tranid FROM transaction WHERE type = 'VendBill' AND createdfrom IN (${soIdList})`)
            : Promise.resolve([]),
        // Item Fulfillments linked to the SOs
        allSoIds.length > 0
            ? runSuiteQL(`SELECT id, tranid FROM transaction WHERE type = 'ItemShip' AND createdfrom IN (${soIdList})`)
            : Promise.resolve([])
    ]);
    // ── STEP 4: Summary ───────────────────────────────────────────────────────
    logger_config_1.default.info("\n" + "=".repeat(65));
    logger_config_1.default.info("📋 DELETION PLAN");
    logger_config_1.default.info("=".repeat(65));
    logger_config_1.default.info(`   Vendor Bills        : ${bills.length}`);
    logger_config_1.default.info(`   Item Fulfillments   : ${ifsFromSo.length}`);
    logger_config_1.default.info(`   Purchase Orders     : ${allPoIds.length}`);
    logger_config_1.default.info(`   Sales Orders        : ${allSoIds.length}`);
    logger_config_1.default.info(`   ─────────────────────────────────────────────────`);
    logger_config_1.default.info(`   TOTAL               : ${bills.length + ifsFromSo.length + allPoIds.length + allSoIds.length} records`);
    logger_config_1.default.info("=".repeat(65));
    if (DRY_RUN) {
        logger_config_1.default.warn("\n⚠️  DRY RUN — Set DRY_RUN=false to execute deletion.");
        logger_config_1.default.info("\n📋 Bills to resync after deletion:");
        bills.forEach(b => logger_config_1.default.info(`   → VendBill ${b.tranid} (ID: ${b.id})`));
        return;
    }
    // ── STEP 5: 5-second safety countdown ────────────────────────────────────
    logger_config_1.default.warn("\n🔴 LIVE DELETE starts in 5 seconds... Press Ctrl+C to ABORT!");
    for (let i = 5; i >= 1; i--) {
        logger_config_1.default.warn(`   ${i}...`);
        await new Promise(r => setTimeout(r, 1000));
    }
    // ── STEP 6: Delete in order (children first) ──────────────────────────────
    await deleteBatch("vendorbill", bills, r => `VendBill ${r.tranid}`);
    await deleteBatch("itemfulfillment", ifsFromSo, r => `ItemFulfillment ${r.tranid}`);
    await deleteBatch("purchaseorder", poRows, r => `PO ${r.tranid}`);
    // Delete SOs last (after all child records are gone)
    const soRecordsForDelete = allSoIds.map(id => ({ id }));
    await deleteBatch("salesorder", soRecordsForDelete, r => `SalesOrder ID: ${r.id}`);
    // ── STEP 7: Reset MongoDB bill flags for resync ───────────────────────────
    logger_config_1.default.info("\n📦 Resetting MongoDB bill staging flags for re-sync...");
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const billCollection = ns_db.collection("suite_vendor_bill_dummy");
        // Extract PO numbers from our target list
        const poNumbersToReset = TARGET_PO_NUMBERS.map(n => Number(n)).filter(Boolean);
        if (poNumbersToReset.length > 0) {
            const resetResult = await billCollection.updateMany({ po_number: { $in: poNumbersToReset } }, {
                $set: {
                    ns_synced: false,
                    ns_result: null,
                    ns_error: null,
                    ns_error_at: null,
                    ns_failed: false,
                },
                $unset: {
                    ns_synced_at: "",
                    ns_result_id: ""
                }
            });
            logger_config_1.default.info(`   ✅ Reset ${resetResult.modifiedCount} bill staging documents for re-sync.`);
        }
        logger_config_1.default.info("   Bills will be re-synced on the next bill sync run.");
    }
    catch (err) {
        logger_config_1.default.error(`   ❌ MongoDB reset failed: ${err.message}`);
    }
    logger_config_1.default.info("\n" + "=".repeat(65));
    logger_config_1.default.info("🎉 TARGETED DELETE + BILL RESYNC RESET COMPLETE");
    logger_config_1.default.info("=".repeat(65));
}
run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
