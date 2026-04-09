"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncNetsuiteItemsFull = void 0;
exports.runItemFullSync = runItemFullSync;
exports.runItemSublistsSync = runItemSublistsSync;
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_client_1 = require("../services/netsuite.client");
const logger_config_1 = __importDefault(require("../config/logger.config"));
/**
 * GET /netsuite-items-full?pageSize=2000
 * GET /netsuite-items-full?pageSize=2000&mode=fast   → SuiteQL (default)
 * GET /netsuite-items-full?pageSize=500&mode=search  → N/search fallback
 *
 * Phase 1: Fetches ALL items from NetSuite → netsuite.netsuite_items_full.
 *          Builds _class object { id, text, l1, l2, l3 } from class hierarchy.
 *
 * Default mode=fast uses SuiteQL (up to 5000/page, faster pagination).
 * Falls back to N/search mode if SuiteQL fails on first page.
 */
const syncNetsuiteItemsFull = async (req, res) => {
    const mode = req.query.mode || "fast";
    const maxPageSize = mode === "fast" ? 5000 : 1000;
    const defaultPageSize = mode === "fast" ? 4000 : 500;
    const pageSize = Math.min(Number(req.query.pageSize) || defaultPageSize, maxPageSize);
    try {
        const result = await runItemFullSync(pageSize, mode);
        return res.json(result);
    }
    catch (err) {
        logger_config_1.default.error("[ITEM-FULL] Error:", err);
        return res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
};
exports.syncNetsuiteItemsFull = syncNetsuiteItemsFull;
// ── Shared concurrency helper ─────────────────────────────────────────────
async function runWithConcurrency(tasks, limit) {
    const results = [];
    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const i = index++;
            results[i] = await tasks[i]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
}
/**
 * Phase 1 core — callable from both endpoint and cron.
 * mode = "fast"   → SuiteQL via fetch_items_fast (up to 5000/page, OFFSET pagination)
 * mode = "search" → N/search via fetch_all_items_full (up to 1000/page, runPaged)
 *
 * If "fast" fails on page 0, automatically retries with "search" mode.
 *
 * Performance (96k items):
 *   pageSize=4000 + 5 parallel workers → ~24 pages / 5 = ~5 rounds ≈ 15-20s
 *   vs old serial 2000/page → 48 pages × 4s ≈ 3-4 min
 *
 * Governance: 20 units/call (0.4% of 5,000 limit). 5 parallel = 100 units/round — safe.
 * pageSize capped at 4000 — 5000 can exceed NetSuite response payload limits.
 */
async function runItemFullSync(pageSize = 4000, mode = "fast") {
    const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
    const col = nsDb.collection("netsuite_items_full");
    // Drop stale indexes if they conflict (e.g., non-unique → unique upgrade)
    try {
        await col.dropIndex("internalid_1");
    }
    catch (_) { }
    try {
        await col.dropIndex("itemid_1");
    }
    catch (_) { }
    await col.createIndex({ internalid: 1 }, { unique: true });
    await col.createIndex({ itemid: 1 });
    const section = mode === "fast" ? "fetch_items_fast" : "fetch_all_items_full";
    const label = mode === "fast" ? "ITEM-FAST" : "ITEM-FULL";
    const PAGE_MAX_RETRIES = 3;
    // ── Incremental: check last sync metadata ──
    const metaCol = nsDb.collection("sync_metadata");
    const lastRun = await metaCol.findOne({ _id: "item_full_sync" });
    // Incremental: only fetch items modified since last completed sync
    // First run (no completedAt) = full sync. Subsequent runs = incremental.
    // Safety: verify DB count is at least 80% of last known total before going incremental.
    let modifiedSince;
    if (lastRun?.completedAt && mode === "fast") {
        const dbCount = await col.countDocuments();
        const lastTotal = lastRun?.total || 0;
        if (lastTotal > 0 && dbCount < lastTotal * 0.8) {
            logger_config_1.default.warn(`[${label}] DB has ${dbCount} items but last sync reported ${lastTotal} — forcing full sync`);
            await metaCol.updateOne({ _id: "item_full_sync" }, { $set: { lastCompletedPage: null, completedAt: null } }, { upsert: true });
        }
        else {
            const d = new Date(lastRun.completedAt);
            modifiedSince = d.toISOString().replace("T", " ").substring(0, 19);
            logger_config_1.default.info(`[${label}] Incremental sync — only items modified since ${modifiedSince} (DB: ${dbCount}, last total: ${lastTotal})`);
        }
    }
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalPulled = 0;
    let lastId = 0;
    let totalItems = 0;
    let pageNum = 0;
    let consecutiveFailures = 0;
    const MAX_FAILURES = PAGE_MAX_RETRIES;
    logger_config_1.default.info(`[${label}] Starting keyset sync (pageSize: ${pageSize})...`);
    while (true) {
        pageNum++;
        try {
            const payload = { sections: [section], lastId, pageSize };
            if (modifiedSince && mode === "fast") {
                payload.modifiedSince = modifiedSince;
            }
            // search mode still uses page-based pagination
            if (mode !== "fast") {
                payload.page = pageNum - 1;
            }
            const response = await (0, netsuite_client_1.callDiagnostic)(payload);
            const batch = response?.[section];
            if (!batch || batch.error) {
                const errMsg = batch?.error || "RESTlet returned no data";
                consecutiveFailures++;
                logger_config_1.default.warn(`[${label}] Page ${pageNum} (lastId=${lastId}) failed: ${errMsg} (${consecutiveFailures}/${MAX_FAILURES})`);
                // SuiteQL failed on first page → fallback to N/search
                if (mode === "fast" && pageNum === 1 && consecutiveFailures >= MAX_FAILURES) {
                    logger_config_1.default.warn(`[${label}] SuiteQL failed — falling back to N/search`);
                    return runItemFullSync(Math.min(pageSize, 1000), "search");
                }
                if (consecutiveFailures >= MAX_FAILURES)
                    break;
                continue; // retry same lastId
            }
            consecutiveFailures = 0;
            const items = batch.items || [];
            // Capture total from first page (only returned when lastId=0)
            if (pageNum === 1 && batch.total) {
                totalItems = batch.total;
            }
            totalPulled += items.length;
            if (items.length > 0) {
                const r = await upsertItems(col, items);
                totalInserted += r.inserted;
                totalUpdated += r.updated;
                lastId = batch.lastId ?? items[items.length - 1].internalid;
            }
            if (batch.skippedFields?.length > 0 && pageNum === 1) {
                logger_config_1.default.warn(`[${label}] Skipped fields: ${batch.skippedFields.join(", ")}`);
            }
            logger_config_1.default.info(`[${label}] Page ${pageNum}: ${items.length} items, lastId=${lastId} (total: ${totalPulled}${totalItems ? "/" + totalItems : ""})`);
            if (batch.done || items.length === 0)
                break;
        }
        catch (err) {
            consecutiveFailures++;
            logger_config_1.default.warn(`[${label}] Page ${pageNum} (lastId=${lastId}) error: ${err.message} (${consecutiveFailures}/${MAX_FAILURES})`);
            if (mode === "fast" && pageNum === 1 && consecutiveFailures >= MAX_FAILURES) {
                logger_config_1.default.warn(`[${label}] SuiteQL failed — falling back to N/search`);
                return runItemFullSync(Math.min(pageSize, 1000), "search");
            }
            if (consecutiveFailures >= MAX_FAILURES)
                break;
        }
    }
    // ── Save completion metadata ──
    const fullSuccess = consecutiveFailures === 0;
    await metaCol.updateOne({ _id: "item_full_sync" }, {
        $set: {
            completedAt: fullSuccess ? new Date() : null,
            total: totalItems || totalPulled,
            totalPulled,
            pageSize,
        },
    }, { upsert: true });
    if (!fullSuccess) {
        logger_config_1.default.warn(`[${label}] Incomplete sync — aborted after ${MAX_FAILURES} consecutive failures at lastId=${lastId}. Next run will do full sync.`);
    }
    logger_config_1.default.info(`[${label}] Done. Pulled: ${totalPulled}, inserted: ${totalInserted}, updated: ${totalUpdated}, pages: ${pageNum}`);
    return {
        success: fullSuccess,
        mode,
        incremental: !!modifiedSince,
        modifiedSince: modifiedSince || null,
        totalPulled,
        inserted: totalInserted,
        updated: totalUpdated,
        pages: pageNum,
    };
}
// ── Nest flat class fields into a class array from fullname hierarchy ──────
function nestClassFields(item) {
    const out = { ...item };
    if (Array.isArray(item.class_levels)) {
        // RESTlet resolved all level IDs — use directly
        out.class = item.class_levels;
        delete out.class_levels;
    }
    else {
        // Fallback: build from fullname (IDs only for last 2 levels)
        const fullname = item.class_fullname ? String(item.class_fullname) : "";
        const levels = fullname ? fullname.split(" : ") : (item.class_text ? [String(item.class_text)] : []);
        out.class = levels.map((name, i) => {
            const entry = { level: i + 1, name };
            if (i === levels.length - 1 && item.class != null)
                entry.id = item.class;
            if (i === levels.length - 2 && item.class_parent != null)
                entry.id = item.class_parent;
            return entry;
        });
    }
    delete out.class_text;
    delete out.class_fullname;
    delete out.class_parent;
    delete out.class_parent_text;
    return out;
}
// ── Helper: upsert items into MongoDB via bulkWrite ───────────────────────
async function upsertItems(col, items) {
    const ops = items
        .filter((item) => item.internalid)
        .map((item) => nestClassFields(item))
        .map((item) => ({
        updateOne: {
            filter: { internalid: item.internalid },
            update: {
                $set: { ...item, _synced_at: new Date() },
                $setOnInsert: { _created_at: new Date() },
            },
            upsert: true,
        },
    }));
    if (ops.length === 0)
        return { inserted: 0, updated: 0 };
    const result = await col.bulkWrite(ops, { ordered: false });
    return {
        inserted: result.upsertedCount ?? 0,
        updated: result.modifiedCount ?? 0,
    };
}
/**
 * Phase 2: Fetch Location + Vendor sublists for all inventory items
 * in netsuite_items_full that don't yet have _sublists_at (or are stale).
 *
 * Called by hourly cron. Uses record.load (5 governance units each when
 * item type is passed — avoids try/catch fallback waste).
 *
 * Batch size 500 = ~2,500 governance units/call (50% of 5,000 limit).
 * 3 parallel workers = ~3x throughput.
 */
const SUBLISTS_BATCH_SIZE = 500;
const PARALLEL_RESTLET_CALLS = 3;
async function runItemSublistsSync(batchSize = SUBLISTS_BATCH_SIZE) {
    const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
    const col = nsDb.collection("netsuite_items_full");
    // If collection is empty, run Phase 1 first to populate items
    const docCount = await col.countDocuments();
    if (docCount === 0) {
        logger_config_1.default.info("[ITEM-SUBLISTS] Collection empty — running Phase 1 (item full sync) first...");
        await runItemFullSync();
    }
    // Find inventory items that need sublists updated
    // Items without _sublists_at, or where _sublists_at is older than 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const itemsDocs = await col.find({
        type: { $in: ["InvtPart", "SerializedInventoryItem"] },
        internalid: { $ne: null },
        $or: [
            { _sublists_at: { $exists: false } },
            { _sublists_at: { $lt: oneHourAgo } },
        ],
    }, { projection: { internalid: 1, type: 1 } }).toArray();
    // Build ID list + type map for direct record.load (no try/catch waste)
    const allItems = itemsDocs
        .map((d) => ({ id: Number(d.internalid), type: d.type }))
        .filter((item) => item.id > 0);
    if (allItems.length === 0) {
        logger_config_1.default.info("[ITEM-SUBLISTS] No items need sublist update.");
        return { success: true, updated: 0, total: 0 };
    }
    logger_config_1.default.info(`[ITEM-SUBLISTS] Fetching sublists for ${allItems.length} inventory items (batch: ${batchSize}, parallel: ${PARALLEL_RESTLET_CALLS})...`);
    let sublistsUpdated = 0;
    let batchErrors = 0;
    // Build batch tasks
    const tasks = [];
    for (let i = 0; i < allItems.length; i += batchSize) {
        const batchItems = allItems.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const batchIds = batchItems.map((item) => item.id);
        const itemTypes = {};
        for (const item of batchItems) {
            itemTypes[String(item.id)] = item.type;
        }
        tasks.push(async () => {
            logger_config_1.default.info(`[ITEM-SUBLISTS] Batch ${batchNum}: ${batchIds.length} items...`);
            try {
                const slResponse = await (0, netsuite_client_1.callDiagnostic)({
                    sections: ["fetch_item_sublists"],
                    itemIds: batchIds,
                    itemTypes,
                });
                const slBatch = slResponse?.fetch_item_sublists;
                if (slBatch && slBatch.items) {
                    const ops = slBatch.items
                        .filter((slItem) => !slItem.error)
                        .map((slItem) => ({
                        updateOne: {
                            filter: { internalid: slItem.internalid },
                            update: {
                                $set: {
                                    _locations: slItem.locations,
                                    _vendors: slItem.vendors,
                                    _sublists_at: new Date(),
                                },
                            },
                        },
                    }));
                    if (ops.length > 0) {
                        const bulkResult = await col.bulkWrite(ops, { ordered: false });
                        sublistsUpdated += bulkResult.modifiedCount + bulkResult.upsertedCount;
                    }
                }
            }
            catch (slErr) {
                logger_config_1.default.error(`[ITEM-SUBLISTS] Batch ${batchNum} error:`, slErr.message);
                batchErrors++;
            }
        });
    }
    // Run batches with concurrency limit
    await runWithConcurrency(tasks, PARALLEL_RESTLET_CALLS);
    logger_config_1.default.info(`[ITEM-SUBLISTS] Done. Updated: ${sublistsUpdated}/${allItems.length}, batch errors: ${batchErrors}`);
    return {
        success: true,
        updated: sublistsUpdated,
        total: allItems.length,
        batchErrors,
    };
}
