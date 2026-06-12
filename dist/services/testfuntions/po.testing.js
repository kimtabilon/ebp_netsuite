"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAllDuplicatesInDummy = exports.countDuplicatesToDeleteInDummy = exports.getDuplicatePoNumbersInDummy = exports.fetchremainingRecordFromsuite = exports.stagePurchaseOrders = void 0;
exports.resolveVendor = resolveVendor;
exports.validateWarehouse = validateWarehouse;
exports.checkPo = checkPo;
exports.runFunction = runFunction;
exports.checkDuplicateByPo = checkDuplicateByPo;
exports.checkPOInDump = checkPOInDump;
exports.comparePOs = comparePOs;
exports.runFunction2 = runFunction2;
const mongdodb_config_1 = require("../../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../../config/logger.config"));
// Fetch po_numbers with duplicates in suite_purchase_order_dummy
// ── Warehouse map: stocking_warehouse code → NetSuite location name ──
// These must match the WAREHOUSE_MAP in purchase_order_restlet.js
// All 5 warehouses: MW (California), W2G-PA (PA), W2G-IL (IL), W2G-KY (KY), W2G-TX (TX)
// netsuiteName must match the NetSuite location record name exactly
// (these are the names used by the RESTlet's WAREHOUSE_MAP → findLocationByName)
const WAREHOUSE_MAP = {
    "MW": { netsuiteName: "California - Chatsworth", address: "21540 Prairie Street, Suite F, Chatsworth CA 91311" },
    "W2G-PA": { netsuiteName: "Ware2Go - PA (Fairless Hills)", address: "1 Kresge Road, Fairless Hills, PA 19030" },
    "W2G-IL": { netsuiteName: "Ware2Go - IL (Aurora)", address: "1206 NAGEL BLVD, Batavia, IL 60510" },
    "W2G-KY": { netsuiteName: "Ware2Go - KY (Hebron)", address: "2525 Litton Lane, Hebron, KY 41048" },
    "W2G-TX": { netsuiteName: "Ware2Go - TX (Dallas)", address: "2450 Esters Blvd #100, Grapevine, TX 76051" }
};
// Valid warehouse codes for quick lookup
const VALID_WAREHOUSE_CODES = Object.keys(WAREHOUSE_MAP);
// Distributor (DB value) + payment_type → { vendor name, NetSuite vendor ID }
// Default = non-DLL variant (NET/TERM)
const VENDOR_MAP = {
    "dandh": {
        default: { name: "D&H", id: 119 },
        dll: { name: "D&H - DLL", id: 118 }
    },
    "ingram": {
        default: { name: "Ingram Micro - NET", id: 133 },
        dll: { name: "Ingram Micro - DLL", id: 269 }
    },
    "suppliesnetwork": {
        default: { name: "Distribution Management", id: 268 },
        dll: { name: "Distribution Management - DLL", id: 131 }
    },
    "synnex": {
        default: { name: "TD Synnex - Term", id: 116 },
        dll: { name: "TD Synnex - DLL", id: 117 }
    },
    "techdata": {
        default: { name: "TD Synnex - Term", id: 116 },
        dll: { name: "TD Synnex - DLL", id: 117 }
    }
};
function resolveVendor(distributor, payment_type) {
    const key = (distributor || "").trim().toLowerCase();
    const isDLL = (payment_type || "").trim().toUpperCase() === "DLL";
    const entry = VENDOR_MAP[key];
    if (!entry) {
        logger_config_1.default.warn(`[PO Stage] Unknown distributor: "${distributor}" — vendor_id will be null`);
        return { name: distributor || "", id: null };
    }
    return isDLL ? entry.dll : entry.default;
}
// ── Warehouse validation ────────────────────────────────────────────────────
// Returns null if warehouse is invalid or missing (for dropship)
// Returns the original code if valid
// Logs a warning for invalid warehouse codes
function validateWarehouse(stockingWarehouse, poType, poNumber) {
    const warehouse = (stockingWarehouse || "").trim();
    // Dropship POs don't need a warehouse (ship to customer)
    if (poType === "Dropship") {
        return "";
    }
    // For stocking POs, warehouse is required
    if (poType === "Stocking") {
        if (!warehouse) {
            logger_config_1.default.warn(`[PO Stage] PO ${poNumber} is Stocking but has no stocking_warehouse — will fail in NetSuite`);
            return "";
        }
        if (!VALID_WAREHOUSE_CODES.includes(warehouse)) {
            logger_config_1.default.warn(`[PO Stage] PO ${poNumber} has invalid warehouse code: "${warehouse}" — must be one of: ${VALID_WAREHOUSE_CODES.join(", ")}`);
            return warehouse; // Still pass through, will fail in NetSuite with clear error
        }
        const whInfo = WAREHOUSE_MAP[warehouse];
        logger_config_1.default.debug(`[PO Stage] PO ${poNumber} validated: ${warehouse} → ${whInfo.netsuiteName} (${whInfo.address})`);
        return warehouse;
    }
    // Unknown po_type — return as-is
    return warehouse;
}
// Fields that are part of the "business content" — used for change detection.
// Sync/error fields are excluded so they don't trigger a false "changed" result.
const PO_CONTENT_FIELDS = [
    "po_number",
    "website_order_number",
    "distributor",
    "distributor_order_number",
    "status",
    "invoice",
    "vendor_id",
    "tracking",
    "order_items",
    "po_type",
    "stocking_warehouse",
    "created_at",
    "updated_at",
];
// >>>>>>>>>   NOT IN Use <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
const stagePurchaseOrders = async () => {
    logger_config_1.default.info("[PO Stage] Starting...");
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    logger_config_1.default.info("[PO Stage] Connected to ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    logger_config_1.default.info("[PO Stage] Connected to netsuite");
    // ── Filter: only POs after 2026-01-01 with status Shipped or Invoiced ──
    logger_config_1.default.info("[PO Stage] Querying po_management (Shipped/Invoiced, created >= 2026-01-01)...");
    const po_cursor = po_db.collection("po_management").find({
        status2: { $in: ["shipped", "invoiced"] },
        created_at: { $gte: "2026-01-01" }
    });
    const staged = [];
    for await (const po of po_cursor) {
        if (!po.po_number)
            continue;
        // Resolve vendor from distributor + payment_type (e.g. "dandh" + "DLL" → D&H - DLL, 118)
        const vendor = resolveVendor(po.distributor, po.payment_type);
        // Validate warehouse for stocking POs
        const validatedWarehouse = validateWarehouse(po.stocking_warehouse, po.po_type, po.po_number);
        if (!po.po_type) {
            logger_config_1.default.warn(`[PO Stage] PO ${po.po_number} has no po_type — will not trigger Dropship flow`);
        }
        // Transform order_items: database uses 'quantity'/'amount', RESTlet expects 'qty'/'cost'
        const transformedItems = (po.order_items || []).map((item) => ({
            sku: item.sku,
            qty: item.quantity || item.qty || 0,
            cost: item.amount || item.cost || 0
        }));
        staged.push({
            po_number: po.po_number,
            website_order_number: po.website_order_number || "",
            distributor: vendor.name,
            distributor_order_number: po.distributor_order_number ?? null,
            status: po.status2 || "",
            invoice: Array.isArray(po.invoice) ? po.invoice : [],
            vendor_id: vendor.id,
            tracking: po.tracking ?? null,
            order_items: transformedItems,
            po_type: po.po_type || "",
            stocking_warehouse: validatedWarehouse,
            created_at: po.created_at || "",
            updated_at: po.updated_at || ""
        });
    }
    logger_config_1.default.info(`[PO Stage] Found ${staged.length} POs matching filter`);
    const staged_with_items = staged.filter(po => po.order_items && po.order_items.length > 0);
    if (staged_with_items.length > 0) {
        logger_config_1.default.info(`[PO Stage] Upserting ${staged_with_items.length} POs with items to netsuite.suite_purchase_order...`);
        await ns_db.collection("suite_purchase_order").bulkWrite(staged_with_items.map(po => ({
            updateOne: {
                filter: { po_number: po.po_number },
                update: { $set: po },
                upsert: true
            }
        })));
    }
    logger_config_1.default.info(`[PO Stage] Staged ${staged_with_items.length} purchase orders to netsuite.suite_purchase_order`);
    return { processed: staged_with_items.length };
};
exports.stagePurchaseOrders = stagePurchaseOrders;
// export const stageAllPurchaseOrdersToDummy = async (): Promise<{ processed: number, updated: number, skipped: number, total: number }> => {
//     log.info("[PO Stage Dummy] Starting smart upsert (skip unchanged, reset sync on change)...");
//     const po_db = await getDb("ebp_pomanager");
//     const ns_db = await getDb("netsuite");
//     const col   = ns_db.collection("suite_purchase_order_dummy");
//     const po_cursor = po_db.collection("po_management").find({
//         $and: [
//             { created_at: { $gte: "2026-01-01" } },
//             { po_number: { $exists: true, $ne: null } },
//             {
//                 $or: [
//                     { status2: RegExp("^shipped$", "i") },
//                     { status2: RegExp("^invoiced$", "i") }
//                 ]
//             }
//         ]
//     });  
//     let total     = 0;
//     let processed = 0;  // Successfully built
//     let updated   = 0;  // Written (new or changed)
//     let skipped   = 0;  // Content identical
//     const bulkOps: any[] = [];
//     for await (const po of po_cursor) {
//         total++;
//         let skipReason: string | null = null;
//         let stagedPO: any = null;
//         try {
//             if (!po.po_number) {
//                 skipReason = "Missing po_number";
//             }
//             const status = (po.status2 || "").toLowerCase();
//             if (!skipReason && status !== "shipped" && status !== "invoiced") {
//                 skipReason = `Invalid status2: ${po.status2}`;
//             }
//             if (!skipReason) {
//                 const vendor = resolveVendor(po.distributor, po.payment_type);
//                 const validatedWarehouse = validateWarehouse(po.stocking_warehouse, po.po_type, po.po_number);
//                 const transformedItems = (po.order_items || []).map((item: any) => ({
//                     sku: item.sku,
//                     qty: item.quantity || item.qty || 0,
//                     cost: item.amount || item.cost || 0
//                 }));
//                 stagedPO = {
//                     po_number: po.po_number,
//                     website_order_number: po.website_order_number || "",
//                     distributor: vendor.name,
//                     distributor_order_number: po.distributor_order_number ?? null,
//                     status: po.status2 || "",
//                     invoice: Array.isArray(po.invoice) ? po.invoice : [],
//                     vendor_id: vendor.id,
//                     tracking: po.tracking ?? null,
//                     order_items: transformedItems,
//                     po_type: po.po_type || "",
//                     stocking_warehouse: validatedWarehouse,
//                     created_at: po.created_at || "",
//                     updated_at: po.updated_at || "",
//                     skipReason: null,
//                     error: null
//                 };
//                 processed++;
//             }
//         } catch (err: any) {
//             skipReason = `Exception: ${err.message || String(err)}`;
//         }
//         if (!po.po_number) continue;
//         if (!stagedPO) {
//             // Skipped or errored record
//             bulkOps.push({
//                 updateOne: {
//                     filter: { po_number: po.po_number },
//                     update: {
//                         $setOnInsert: {
//                             po_number: po.po_number,
//                             skipReason,
//                             error: null,
//                             staged_at: new Date().toISOString()
//                         }
//                     },
//                     upsert: true
//                 }
//             });
//             continue;
//         }
//         // Fetch existing document to check for changes
//         const existing = await col.findOne(
//             { po_number: po.po_number },
//             { projection: { ...Object.fromEntries(PO_CONTENT_FIELDS.map(f => [f, 1])), _id: 0 } }
//         );
//         if (existing && isStagedPOContentEqual(stagedPO, existing)) {
//             skipped++;
//             continue;
//         }
//         // New or changed content
//         updated++;
//         bulkOps.push({
//             updateOne: {
//                 filter: { po_number: po.po_number },
//                 update: {
//                     $set: {
//                         ...stagedPO,
//                         staged_at: new Date().toISOString(),
//                         // Reset sync flags so this is re-processed
//                         ns_synced:    null,
//                         ns_sync:      null,
//                         ns_result:    null,
//                         ns_error:     null,
//                         sync_result:  null,
//                         sync_error:   null,
//                     }
//                 },
//                 upsert: true
//             }
//         });
//         // Execute in chunks to manage memory
//         if (bulkOps.length >= 500) {
//             await col.bulkWrite(bulkOps, { ordered: false });
//             bulkOps.length = 0;
//         }
//     }
//     if (bulkOps.length > 0) {
//         await col.bulkWrite(bulkOps, { ordered: false });
//     }
//     log.info(`[PO Stage Dummy] Done — total=${total}, processed=${processed}, updated=${updated}, skipped=${skipped}`);
//     return { processed, updated, skipped, total };
// };
async function checkPo() {
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    // Step 1: Get all relevant POs
    const sourcePos = await po_db.collection("po_management").find({
        created_at: { $gte: "2026-01-01" },
        po_number: { $exists: true, $ne: null },
        status2: { $in: [/^shipped$/i, /^invoiced$/i] }
    }).toArray();
    // Step 2: Extract po_numbers
    const poNumbers = sourcePos.map(po => po.po_number);
    // Step 3: Find which ones exist in staging
    const stagedPos = await ns_db.collection("suite_purchase_order_dummy")
        .find({ po_number: { $in: poNumbers } })
        .project({ po_number: 1, _id: 0 })
        .toArray();
    const stagedPoNumbers = stagedPos.map(po => po.po_number);
    // Step 4: Filter missing ones
    const notStaged = poNumbers.filter(po => !stagedPoNumbers.includes(po));
    console.log("Not staged PO numbers:", notStaged);
}
// export async function deleteSpecificPOs() {
//     const db = await getDb("netsuite");
//     const collection = db.collection("suite_purchase_order_dummy");
//     const poNumbersToDelete = [
//         224792, 225094, 226076, 226367, 226567, 226569, 227612, 227788, 228052, 228379,
//         228503, 228505, 228758, 228881, 229014, 229037, 229078, 229100, 229176, 229218,
//         229261, 229307, 229309, 229310, 229478, 229619, 229640, 229650, 229663, 229721,
//         229740, 229758, 229824, 229835, 229841, 229861, 229865, 229885, 229972, 229974,
//         230014, 230021, 230026, 230027, 230036, 230107, 230172, 230184, 230189, 230197,
//         230233, 230330, 230336, 230358, 230359, 230369, 230373, 230470, 230553, 230556,
//         230620, 230647, 230774, 230803, 230843, 230848, 230878, 230893, 230904, 230907,
//         230922, 230923, 231323, 231476, 231608, 231635, 231685, 231703, 231709, 231719,
//         231747, 231748, 231752, 231763, 231802, 231805, 231857, 231903, 231916, 231959,
//         232016, 232053, 232057, 232062, 232078, 232079, 232084, 232088, 232138, 232161,
//         232170, 232183, 232209, 232221, 232277, 232299, 232300, 232303, 232318, 232321,
//         232340, 232399, 232411, 232429, 232482, 232493, 232503, 232571, 232575, 232600,
//         232609, 232619, 232626, 232659
//     ];
//     const result = await collection.deleteMany({
//         po_number: { $in: poNumbersToDelete }
//     });
//     console.log(`Successfully deleted ${result.deletedCount} POs from suite_purchase_order_dummy.`);
//     process.exit(0);
// }
//         const poList = [
//     "232462","232485","232518",
//     "999901","999902","999903","999904","999905",
//     "999906","999907","999908","999909",
//     "999910","999911","999912","999913",
//     "999914","999915","999916","999917"
// ];
// for (const po of poList) {
//     await checkDuplicateByPo(po);
// }
//         return  
// export async function runFunction() {
//     try {
//         const ns_db = await getDb("netsuite");
//         const DUMP_COL = "dump_po";
//         const SUITE_COL = "suite_purchase_order_dummy";
//         console.log(`\n=== PO Reconciliation Report ===\n`);
//         const [dumpDocs, suiteDocs] = await Promise.all([
//             ns_db.collection(DUMP_COL)
//                 .find({})
//                 .project({ "po.tranid": 1 })
//                 .toArray(),
//             ns_db.collection(SUITE_COL)
//                 .find({})
//                 .project({ po_number: 1, ns_synced: 1 })
//                 .toArray()
//         ]);
//         console.log(`Records in Dump: ${dumpDocs.length}`);
//         console.log(`Records in Suite: ${suiteDocs.length}`);
//         // 2. Build Dump Map (using tranId → numeric PO)
//         const dumpMap: Record<string, any[]> = {};
//         for (const doc of dumpDocs) {
//             let tranId = doc.po?.tranid;
//             if (!tranId) continue;
//             const key = String(tranId)
//                 .toUpperCase()
//                 .replace(/^PO/, "")        // remove PO prefix
//                 .replace(/[^0-9]/g, "")    // keep only numbers
//                 .trim();
//             if (!key) continue;
//             if (!dumpMap[key]) dumpMap[key] = [];
//             dumpMap[key].push(doc);
//         }
//         // 3. Build Suite Map
//         const suiteMap: Record<string, any[]> = {};
//         for (const doc of suiteDocs) {
//             const poNum = doc.po_number;
//             if (!poNum) continue;
//             if(!doc.ns_synced) continue
//             const key = String(poNum).trim();
//             if (!suiteMap[key]) suiteMap[key] = [];
//             suiteMap[key].push(doc);
//         }
//         // 4. Sets
//         const dumpSet = new Set(Object.keys(dumpMap));
//         const suiteSet = new Set(Object.keys(suiteMap));
//         // 5. Comparisons
//         const matches = [...dumpSet].filter(k => suiteSet.has(k));
//         const onlyInDump = [...dumpSet].filter(k => !suiteSet.has(k));
//         const onlyInSuite = [...suiteSet].filter(k => !dumpSet.has(k));
//         // 6. Duplicates
//         const dumpDuplicates = Object.entries(dumpMap)
//             .filter(([_, docs]) => docs.length > 1);
//         const suiteDuplicates = Object.entries(suiteMap)
//             .filter(([_, docs]) => docs.length > 1);
//         // 7. Summary
//         console.log(`\n--- Summary ---`);
//         console.log(`Matches: ${matches.length}`);
//         console.log(`Missing in Suite: ${onlyInDump.length}`);
//         console.log(`Missing in Dump: ${onlyInSuite.length}`);
//         console.log(`Duplicate POs in Dump: ${dumpDuplicates.length}`);
//         console.log(`Duplicate POs in Suite: ${suiteDuplicates.length}`);
//         // 8. Chunk printer (for large lists)
//         const printChunks = (title: string, data: string[], chunkSize = 50) => {
//             console.log(`\n--- ${title} (Total: ${data.length}) ---`);
//             if (!data.length) {
//                 console.log("None");
//                 return;
//             }
//             console.log("[\n  " + data.map(po => `"${po}"`).join(", ") + "\n]");
//         };
//         // 9. Print mismatches
//         console.log(`\n======================================================`);
//         console.log(`📊 MATHEMATICAL BREAKDOWN OF THE "46" DISCREPANCY`);
//         console.log(`======================================================`);
//         console.log(`NetSuite Dump Total       : ${dumpDocs.length}`);
//         console.log(`MongoDB Synced Total      : ${suiteSet.size}`);
//         console.log(`Apparent Difference       : ${Math.abs(dumpDocs.length - suiteSet.size)}`);
//         console.log(``);
//         console.log(`Why is the difference ${Math.abs(dumpDocs.length - suiteSet.size)}?`);
//         console.log(`Because there are discrepancies in BOTH directions:`);
//         console.log(`  + ${onlyInSuite.length} "Ghost" POs (Marked synced in Mongo, missing in NetSuite)`);
//         console.log(`  - ${onlyInDump.length} "Unsynced" POs (Exist in NetSuite, not marked synced in Mongo)`);
//         console.log(`  -----------------------`);
//         console.log(`  = ${onlyInSuite.length - onlyInDump.length} Net Difference`);
//         console.log(`\nTo perfectly fix your database, you must resync ALL ${onlyInSuite.length} Ghost POs.`);
//         printChunks(
//             "1. THE GHOST POs (Resync these exact " + onlyInSuite.length + " POs)",
//             onlyInSuite
//         );
//         printChunks(
//             "2. THE UNSYNCED POs (These " + onlyInDump.length + " are in NetSuite, but missing from Mongo's synced list)",
//             onlyInDump
//         );
//         // 10. Print ALL duplicates (no slice limit)
//         if (dumpDuplicates.length) {
//             console.log(`\n--- Duplicates in Dump (based on tranId) ---`);
//             dumpDuplicates.forEach(([po, docs]) => {
//                 console.log(`PO: ${po.padEnd(15)} | tranId: PO${po.padEnd(15)} | Count: ${docs.length} | `);
//             });
//         }
//         if (suiteDuplicates.length) {
//             console.log(`\n--- Duplicates in Suite ---`);
//             suiteDuplicates.forEach(([po, docs]) => {
//                 console.log(`PO: ${po.padEnd(15)} | Count: ${docs.length} | tranId: PO${po.padEnd(15)}`);
//             });
//         }
//         console.log(`\n=== Done ===\n`);
//     } catch (err) {
//         console.error("Error >>>", err);
//     }
// }
async function runFunction() {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const DUMP_COL = "dump_po";
        const SUITE_COL = "suite_purchase_order_dummy";
        // 1. Get all dump POs
        const dumpDocs = await ns_db.collection(DUMP_COL)
            .find({})
            .project({ "po.tranid": 1 })
            .toArray();
        // 2. Build Set of dump PO numbers
        const dumpSet = new Set();
        for (const doc of dumpDocs) {
            let tranId = doc.po?.tranid;
            if (!tranId)
                continue;
            const poNumber = String(tranId)
                .replace(/^PO/i, "")
                .replace(/[^0-9]/g, "")
                .trim();
            if (poNumber) {
                dumpSet.add(poNumber);
            }
        }
        // 3. Get all dummy POs
        const suiteDocs = await ns_db.collection(SUITE_COL)
            .find({})
            .project({ po_number: 1, ns_synced: 1 })
            .toArray();
        const dummySet = new Set();
        const unsyncedDummySet = new Set();
        const ghostPOs = [];
        for (const doc of suiteDocs) {
            const poNumber = String(doc.po_number || "").trim();
            if (!poNumber)
                continue;
            dummySet.add(poNumber);
            if (doc.ns_synced !== true) {
                unsyncedDummySet.add(poNumber);
            }
            // Check 2: Exist in dummy and ns_synced: true but not in dump_po
            if (doc.ns_synced === true && !dumpSet.has(poNumber)) {
                ghostPOs.push(Number(poNumber));
            }
        }
        // Check 1: Exist in dump_po and not in dummy at all
        const onlyInDump = [];
        for (const poNumber of dumpSet) {
            if (!dummySet.has(poNumber)) {
                onlyInDump.push(Number(poNumber));
            }
        }
        // Check 3: Exist in dump_po but in dummy their ns_synced is false
        const existInDumpButUnsyncedInDummy = [];
        for (const poNumber of dumpSet) {
            if (unsyncedDummySet.has(poNumber)) {
                existInDumpButUnsyncedInDummy.push(Number(poNumber));
            }
        }
        // 5. Print results
        console.log(`\n======================================================`);
        console.log(`📊 PO DUMP VS DUMMY RECONCILIATION REPORT`);
        console.log(`======================================================`);
        console.log(`POs only in Dump (Exist in dump_po, not in dummy at all): ${onlyInDump.length}`);
        console.log(onlyInDump);
        console.log(`\nPOs in Dump but in Dummy their ns_synced is false: ${existInDumpButUnsyncedInDummy.length}`);
        console.log(existInDumpButUnsyncedInDummy);
        console.log(`\nGhost POs (Exist in dummy with ns_synced: true, not in dump_po): ${ghostPOs.length}`);
        console.log(ghostPOs);
        console.log(`======================================================\n`);
    }
    catch (err) {
        console.error("Error >>>", err);
    }
}
async function analyzePOs(poNumbers) {
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const po_collection = po_db.collection("po_management");
    const suite_collection = ns_db.collection("suite_purchase_order_dummy");
    // Fetch all relevant records in one go (efficient)
    const poData = await po_collection
        .find({ po_number: { $in: poNumbers } })
        .toArray();
    const suiteData = await suite_collection
        .find({ po_number: { $in: poNumbers } })
        .toArray();
    // Group data
    const poMap = {};
    const suiteMap = {};
    // Group po_management
    for (const doc of poData) {
        const po = doc.po_number;
        if (!poMap[po])
            poMap[po] = [];
        poMap[po].push(doc);
    }
    // Group suite
    for (const doc of suiteData) {
        const po = Number(doc.po_number);
        if (!suiteMap[po])
            suiteMap[po] = [];
        suiteMap[po].push(doc);
    }
    // Results
    const result = {
        inBoth: [],
        onlyInPO: [],
        onlyInSuite: [],
        inNone: [],
        duplicates: {
            po_management: [],
            suite: []
        },
        suiteDetails: []
    };
    // Check each PO
    for (const po of poNumbers) {
        const inPO = !!poMap[po];
        const inSuite = !!suiteMap[po];
        if (inPO && inSuite)
            result.inBoth.push(po);
        else if (inPO)
            result.onlyInPO.push(po);
        else if (inSuite)
            result.onlyInSuite.push(po);
        else
            result.inNone.push(po);
        // Duplicate detection
        if (poMap[po] && poMap[po].length > 1) {
            result.duplicates.po_management.push({
                po,
                count: poMap[po].length
            });
        }
        if (suiteMap[po] && suiteMap[po].length > 1) {
            result.duplicates.suite.push({
                po,
                count: suiteMap[po].length
            });
        }
        // Suite details (ns_synced, ns_result)
        if (suiteMap[po]) {
            for (const doc of suiteMap[po]) {
                result.suiteDetails.push({
                    po,
                    ns_synced: doc.ns_synced,
                    ns_result: doc.ns_result
                });
            }
        }
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
}
const poNumbers = [
    232462, 232485, 232518, 999901, 999902, 999903, 999904, 999905, 999906, 999907,
    999908, 999909, 999910, 999911, 999912, 999913, 999914, 999915, 999916, 999917,
    999918, 999919, 999920, 999925, 999926, 999927, 999928, 999929, 999930, 999931,
    999932, 999933, 999934, 999935, 999936, 999937, 999938, 999939, 999940, 999941,
    999942, 999943, 999944, 999947, 999948, 999949, 999950, 999951, 999952, 999953,
    999954, 999955, 999956, 999957, 999958, 999959, 999960, 999961, 999962, 999963,
    999964, 999965, 999966, 999967, 999968, 999969, 999971, 999974, 999976, 999983,
    999984, 999985, 999986, 999987, 999988, 999989, 999990, 999991, 999992, 999993,
    999997, 1000000, 1000005, 1000006, 1000007, 1000008, 1000009, 1000010, 1000011,
    1000012,
    1000013, 1000014, 1000015, 1000016, 1000017, 1000026, 1000027, 1000028,
    1000029, 1000030, 1000031, 1000032, 1000033, 1000034, 1000035, 1000036, 1000037,
    1000043, 1000045, 1000046, 1000047, 1000048, 1000049, 1000050, 1000051, 1000052,
    1000053, 1000054, 1000055, 1000056, 1000057, 1000067, 1000070, 1000071, 1000072,
    1000073, 1000074, 1000075, 1000076, 1000077, 1000078, 1000079, 1000080, 1000081,
    1000094, 1000095, 1000096, 1000097, 1000098, 1000099, 1000102, 1000104, 1000111,
    1000118, 1000119, 1000120, 1000121, 1000122, 1000123, 1000124, 1000125, 1000126,
    1000128, 1000129, 1000130, 1000132, 1000144, 1000145, 1000146, 1000147, 1000148,
    1000149, 1000150, 1000151, 1000152, 1000153, 1000156, 1000158, 1000160, 1000163,
    1000165, 1000166, 1000167, 1000168, 1000169, 1000170, 1000171, 1000172, 1000174,
    1000175, 1000181, 1000184, 1000186, 1000187, 1000188, 1000191, 1000192, 1000193,
    1000194, 1000195, 1000196, 1000202, 1000204, 1000205, 1000207, 1000208, 1000209,
    1000212, 1000213, 1000214, 1000215, 1000216, 1000217, 1000218, 1000219, 1000220,
    1000221, 1000222, 1000228, 1000229, 1000230, 1000232, 1000234, 1000235, 1000237,
    1000238, 1000239, 1000240, 1000241, 1000242, 1000243, 1000244, 1000245, 1000246,
    1000248, 1000251, 1000253, 1000254,
    1000255, 1000257, 1000259, 1000261, 1000262,
    1000263, 1000264, 1000265, 1000266, 1000267, 1000268, 1000269, 1000270, 1000271,
    1000275, 1000276, 1000278, 1000279, 1000280, 1000281, 1000284, 1000285, 1000286,
    1000287, 1000288, 1000289, 1000290, 1000291, 1000292, 1000293, 1000294, 1000295,
    1000299, 1000304, 1000305, 1000306, 1000307, 1000310, 1000312, 1000313, 1000314,
    1000316, 1000317, 1000318, 1000319, 1000320, 1000322, 1000323, 1000324, 1000325,
    1000332, 1000333, 1000334, 1000336, 1000337, 1000338, 1000339, 1000340, 1000341,
    1000342, 1000343, 1000344, 1000345, 1000346, 1000347, 1000348, 1000349, 1000351,
    1000352, 1000355, 1000356, 1000357, 1000359, 1000361, 1000362, 1000363, 1000364,
    1000365, 1000368, 1000369, 1000370, 1000372, 1000373, 1000374, 1000375, 1000384,
    1000385, 1000386, 1000387, 1000388, 1000389, 1000391, 1000395
];
const po2 = [];
// Ensure dumpMap is defined or imported. If it's defined elsewhere, import or pass as parameter.
// Here, assuming dumpMap is a global variable defined elsewhere in the file.
async function checkDuplicateByPo(poNumber) {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const DUMP_COL = "dump_po";
        console.log(`\n=== Duplicate Analysis for PO: ${poNumber} ===`);
        // 1. Fetch using tranId (PO + number)
        const docs = await ns_db.collection(DUMP_COL)
            .find({
            "payload.tranId": { $regex: `^PO${poNumber}$`, $options: "i" }
        })
            .toArray();
        if (!docs.length) {
            console.log("No records found");
            return;
        }
        if (docs.length === 1) {
            console.log("Only one record found (no duplicates)");
            return;
        }
        console.log(`Total Records: ${docs.length}`);
        // 2. Compare payloads
        const basePayload = docs[0].payload;
        let allSame = true;
        const differences = {};
        docs.forEach((doc, index) => {
            if (index === 0)
                return;
            const currentPayload = doc.payload;
            const keys = new Set([
                ...Object.keys(basePayload || {}),
                ...Object.keys(currentPayload || {})
            ]);
            for (const key of keys) {
                const val1 = basePayload?.[key];
                const val2 = currentPayload?.[key];
                if (JSON.stringify(val1) !== JSON.stringify(val2)) {
                    allSame = false;
                    if (!differences[key])
                        differences[key] = new Set();
                    differences[key].add(`base: ${JSON.stringify(val1)}`);
                    differences[key].add(`doc${index}: ${JSON.stringify(val2)}`);
                }
            }
        });
        // 3. Output
        if (allSame) {
            console.log("✅ All duplicate payloads are IDENTICAL");
        }
        else {
            console.log("❌ Differences found:\n");
            Object.entries(differences).forEach(([field, values]) => {
                console.log(`Field: ${field}`);
                values.forEach(v => console.log(`  ${v}`));
                console.log("");
            });
        }
        console.log(`\n=== Done ===\n`);
    }
    catch (err) {
        console.error("Error >>>", err);
    }
}
async function checkPOInDump(poNumbers) {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const DUMP_COL = "dump_po";
        const dumpCollection = ns_db.collection(DUMP_COL);
        // Fetch only needed fields
        const dumpDocs = await dumpCollection
            .find({})
            .project({ "payload.tranId": 1, "payload.id": 1 })
            .toArray();
        // Build map: tranId → array of ids
        const tranMap = {};
        for (const doc of dumpDocs) {
            const tranId = doc.payload?.tranId;
            if (!tranId)
                continue;
            const key = String(tranId).toUpperCase().trim();
            if (!tranMap[key])
                tranMap[key] = [];
            tranMap[key].push(doc.payload?.id);
        }
        // console.log(`\n=== PO Check Results ===\n`);
        for (const po of poNumbers) {
            const tranId = `PO${po}`;
            const matches = tranMap[tranId] || [];
            // console.log(`PO: ${po}`);
            // console.log(`tranId: ${tranId}`);
            // console.log(`Count: ${matches.length}`);
            if (matches.length > 0) {
                console.log(JSON.stringify(matches, null, 2));
            }
            else {
                // console.log(`IDs: None`);
            }
            // console.log("----------------------------");
        }
        // console.log(`\n=== Done ===\n`);
    }
    catch (err) {
        console.error("Error >>>", err);
    }
}
const fetchremainingRecordFromsuite = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const dumpCol = ns_db.collection("ns_rest_purchase_order_detail_dump_dummy");
    console.log("--- Incremental PO Fetch Started ---");
    // 1. Get existing IDs from the dump
    console.log("Step 1: Fetching existing IDs from local dump...");
    const existingIds = await dumpCol.distinct("ns_internal_id");
    const existingSet = new Set(existingIds.map(id => String(id)));
    console.log(`Found ${existingSet.size} records already in dump.`);
    // 2. Fetch all IDs from NetSuite (List only, no details)
    console.log("Step 2: Listing all PO IDs from NetSuite (this may take a minute)...");
    const allNsIds = [];
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    // while (hasMore) {
    //     try {
    //         const data = await listPurchaseOrders({ limit, offset });
    //         const items = normalizePurchaseOrderListItems(data);
    //         for (const item of items) {
    //             const id = extractPurchaseOrderIdFromListItem(item);
    //             if (id) allNsIds.push(id);
    //         }
    //         console.log(`  Fetched ${allNsIds.length} IDs so far...`);
    //         hasMore = data.hasMore;
    //         offset += items.length;
    //         if (allNsIds.length > 50000) break; // Safety break
    //     } catch (err: any) {
    //         console.error("Error listing IDs:", err.message);
    //         break;
    //     }
    // }
    // console.log(`Total IDs found in NetSuite: ${allNsIds.length}`);
    // 3. Identify missing IDs
    // const missingIds = allNsIds.filter(id => !existingSet.has(id));
    // console.log(`Targeting ${missingIds.length} missing records for fetch.`);
    // if (missingIds.length === 0) {
    //     console.log("Everything is already up to date!");
    //     await client.close();
    //     return;
    // }
    // 4. Fetch details for missing IDs and persist
    // console.log(`Step 4: Fetching full details for ${missingIds.length} records...`);
    // let count = 0;
    // const batchSize = 10; // Process in small batches for stability
    // for (let i = 0; i < missingIds.length; i += batchSize) {
    //     const batch = missingIds.slice(i, i + batchSize);
    //     const detailPromises = batch.map(async (id) => {
    //         try {
    //             const details = await getPurchaseOrder(id);
    //             if (details && !details._hydrateError) {
    //                 await persistRestPurchaseOrderItems([details], { save: true });
    //                 return true;
    //             }
    //         } catch (err: any) {
    //             console.error(`  Failed to fetch PO ${id}:`, err.message);
    //         }
    //         return false;
    //     });
    //     const results = await Promise.all(detailPromises);
    //     count += results.filter(Boolean).length;
    //     console.log(`  Progress: ${count}/${missingIds.length} fetched and saved.`);
    // }
    console.log(`--- Incremental Fetch Complete ---`);
    // console.log(`Successfully added ${count} missing records to the dump.`);
};
exports.fetchremainingRecordFromsuite = fetchremainingRecordFromsuite;
async function comparePOs() {
    try {
        const db = await (0, mongdodb_config_1.getDb)("netsuite");
        const DUMP_COL = "po_dump_test";
        const SUITE_COL = "suite_purchase_order_dummy";
        console.log("\n=== Dump vs Suite Sync Check (FIXED) ===\n");
        // Normalize PO - with options to handle nulls
        const normalizePO = (val, options) => {
            if (!val)
                return null;
            let result = String(val)
                .toUpperCase()
                .replace(/PO/i, "")
                .replace(/[^0-9]/g, "")
                .trim();
            return result || null;
        };
        // Fetch all dump documents
        const dumpDocs = await db.collection(DUMP_COL).find({}).toArray();
        const suiteDocs = await db.collection(SUITE_COL).find({}).project({
            po_number: 1,
            ns_synced: 1,
            ns_result: 1
        }).toArray();
        // Categorize dump documents
        const validPOs = []; // Has valid tranid
        const nullTranidPOs = []; // Has null tranid but might have id or otherRefNum
        for (const d of dumpDocs) {
            const tranid = d.po?.tranid;
            const poId = d.po?.id;
            const otherRefNum = d.po?.otherRefNum;
            if (tranid && normalizePO(tranid)) {
                validPOs.push({
                    key: normalizePO(tranid),
                    doc: d,
                    type: 'tranid'
                });
            }
            else {
                // Try to find an alternative identifier
                let alternativeKey = null;
                let alternativeType = null;
                if (otherRefNum && normalizePO(otherRefNum)) {
                    alternativeKey = normalizePO(otherRefNum);
                    alternativeType = 'otherRefNum';
                }
                else if (poId && normalizePO(poId)) {
                    alternativeKey = normalizePO(poId);
                    alternativeType = 'id';
                }
                nullTranidPOs.push({
                    _id: d._id,
                    tranid: tranid,
                    poId: poId,
                    otherRefNum: otherRefNum,
                    alternativeKey: alternativeKey,
                    alternativeType: alternativeType,
                    doc: d
                });
            }
        }
        // Build suite map
        const suiteMap = new Map();
        const syncedSuiteSet = new Set();
        for (const s of suiteDocs) {
            const key = normalizePO(s.po_number);
            if (key) {
                suiteMap.set(key, {
                    ns_synced: s.ns_synced,
                    ns_result: s.ns_result,
                    po_number: s.po_number
                });
                if (s.ns_synced === true) {
                    syncedSuiteSet.add(key);
                }
            }
        }
        // Check which null tranid POs have alternatives that exist in suite
        const nullTranidWithSyncMatch = [];
        const nullTranidNoMatch = [];
        for (const item of nullTranidPOs) {
            if (item.alternativeKey && syncedSuiteSet.has(item.alternativeKey)) {
                nullTranidWithSyncMatch.push({
                    ...item,
                    matchedKey: item.alternativeKey,
                    matchType: item.alternativeType
                });
            }
            else {
                nullTranidNoMatch.push(item);
            }
        }
        // Build valid PO map
        const validPOMap = new Map();
        for (const item of validPOs) {
            validPOMap.set(item.key, item.doc);
        }
        // Find valid POs not synced
        const validNotSynced = [];
        for (const [po, doc] of validPOMap.entries()) {
            if (!syncedSuiteSet.has(po)) {
                validNotSynced.push({
                    po: po,
                    exists_in_suite: suiteMap.has(po),
                    suite_synced: suiteMap.get(po)?.ns_synced || false
                });
            }
        }
        console.log("\n--- COUNT ---");
        console.log("Dump total documents:", dumpDocs.length);
        console.log("Valid PO numbers (tranid not null):", validPOs.length);
        console.log("Null tranid POs:", nullTranidPOs.length);
        console.log("Suite POs with ns_synced: true:", syncedSuiteSet.size);
        console.log("\n--- NULL TRANID ANALYSIS ---");
        console.log(`Found ${nullTranidPOs.length} documents with null tranid`);
        const withAlternative = nullTranidPOs.filter(p => p.alternativeKey).length;
        const withoutAlternative = nullTranidPOs.filter(p => !p.alternativeKey).length;
        console.log(`- Have alternative identifier (otherRefNum or id): ${withAlternative}`);
        console.log(`- No alternative identifier: ${withoutAlternative}`);
        console.log(`- Alternatives that match synced suite POs: ${nullTranidWithSyncMatch.length}`);
        console.log(`- Alternatives with NO match in suite: ${nullTranidNoMatch.length}`);
        if (nullTranidWithSyncMatch.length > 0) {
            console.log("\n--- NULL TRANID POs THAT CAN BE MATCHED VIA ALTERNATIVES ---");
            nullTranidWithSyncMatch.forEach((item, idx) => {
                console.log(`${idx + 1}. _id: ${item._id}, matched via ${item.matchType}: ${item.alternativeKey} (matches suite PO ${item.matchedKey})`);
            });
        }
        if (nullTranidNoMatch.length > 0 && nullTranidNoMatch.length <= 30) {
            console.log("\n--- NULL TRANID POs WITH NO MATCH IN SUITE ---");
            nullTranidNoMatch.forEach((item, idx) => {
                console.log(`${idx + 1}. _id: ${item._id}, poId: ${item.poId}, otherRefNum: ${item.otherRefNum}`);
            });
        }
        console.log("\n--- VALID POs NOT SYNCED ---");
        console.log(`Found ${validNotSynced.length} valid POs not synced`);
        console.log("\n--- SUMMARY ---");
        console.log(`Total dump docs: ${dumpDocs.length}`);
        console.log(`- Valid PO numbers: ${validPOs.length} (should be synced via tranid)`);
        console.log(`- Null tranid: ${nullTranidPOs.length}`);
        console.log(`  * Can be matched via alternatives: ${nullTranidWithSyncMatch.length}`);
        console.log(`  * Cannot be matched: ${nullTranidNoMatch.length}`);
        if (nullTranidNoMatch.length === 26) {
            console.log("\n✅ The 26 discrepancy documents are the null tranid POs with no matching alternatives in suite!");
        }
        console.log("\n=== DONE ===\n");
        return {
            validPOs: validPOs.length,
            nullTranidPOs: nullTranidPOs,
            nullTranidWithSyncMatch: nullTranidWithSyncMatch,
            nullTranidNoMatch: nullTranidNoMatch,
            validNotSynced: validNotSynced,
            summary: {
                totalDump: dumpDocs.length,
                validTranid: validPOs.length,
                nullTranid: nullTranidPOs.length,
                nullTranidMatchable: nullTranidWithSyncMatch.length,
                nullTranidUnmatchable: nullTranidNoMatch.length,
                syncedInSuite: syncedSuiteSet.size
            }
        };
    }
    catch (err) {
        console.error("Error >>>", err);
    }
}
async function runFunction2() {
    try {
        const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
        const DUMP_COL = "ns_rest_purchase_order_detail_dump_dummy";
        const SUITE_COL = "suite_purchase_order_dummy";
        console.log(`\n=== PO Reconciliation Report ===\n`);
        // 🔹 PO array (to SKIP)
        const po = poNumbers;
        // 🔹 Normalize helper
        const normalizePO = (val) => {
            const num = String(val)
                .toUpperCase()
                .replace(/^PO/, "")
                .replace(/[^0-9]/g, "")
                .trim();
            return num ? `PO${num}` : null;
        };
        // 🔹 Build skip set
        const skipSet = new Set(po.map(p => normalizePO(p)).filter(Boolean));
        // 1. Fetch data
        const [dumpDocs, suiteDocs] = await Promise.all([
            ns_db.collection(DUMP_COL)
                .find({})
                .project({
                "payload.tranId": 1,
                "ns_internal_id": 1 // ✅ IMPORTANT
            })
                .toArray(),
            ns_db.collection(SUITE_COL)
                .find({})
                .project({ po_number: 1, ns_synced: 1 })
                .toArray()
        ]);
        console.log(`Records in Dump: ${dumpDocs.length}`);
        console.log(`Records in Suite: ${suiteDocs.length}`);
        // 2. Build Dump Map
        const dumpMap = {};
        for (const doc of dumpDocs) {
            const key = normalizePO(doc.payload?.tranId);
            if (!key)
                continue;
            if (skipSet.has(key))
                continue;
            if (!dumpMap[key])
                dumpMap[key] = [];
            dumpMap[key].push(doc);
        }
        // 3. Build Suite Map
        const suiteMap = {};
        for (const doc of suiteDocs) {
            if (!doc.ns_synced)
                continue;
            const key = normalizePO(doc.po_number);
            if (!key)
                continue;
            if (skipSet.has(key))
                continue;
            if (!suiteMap[key])
                suiteMap[key] = [];
            suiteMap[key].push(doc);
        }
        // 4. Sets
        const dumpSet = new Set(Object.keys(dumpMap));
        const suiteSet = new Set(Object.keys(suiteMap));
        // 5. Comparisons
        const matches = [...dumpSet].filter(k => suiteSet.has(k));
        const onlyInDump = [...dumpSet].filter(k => !suiteSet.has(k));
        // 6. Duplicates
        const dumpDuplicates = Object.entries(dumpMap)
            .filter(([_, docs]) => docs.length > 1);
        const suiteDuplicates = Object.entries(suiteMap)
            .filter(([_, docs]) => docs.length > 1);
        // 7. Summary
        console.log(`\n--- Summary ---`);
        console.log(`Matches: ${matches.length}`);
        console.log(`Missing in Suite: ${onlyInDump.length}`);
        console.log(`Duplicate POs in Dump: ${dumpDuplicates.length}`);
        console.log(`Duplicate POs in Suite: ${suiteDuplicates.length}`);
        // ✅ 8. Detailed Missing रिपोर्ट
        console.log(`\n--- Missing in Suite (Detailed) ---`);
        if (!onlyInDump.length) {
            console.log("None");
        }
        else {
            onlyInDump.forEach((key) => {
                const docs = dumpMap[key];
                docs.forEach(doc => {
                    const poNumber = key.replace(/^PO/, ""); // remove prefix
                    const internalId = doc?.ns_internal_id || "N/A";
                    console.log(`${internalId},`);
                });
            });
        }
        //  | ns_internal_id: ${internalId}
        // ✅ 9. Flat PO list (no prefix)
        const poList = onlyInDump.map(k => k.replace(/^PO/, ""));
        console.log(`\n--- PO List (No Prefix) ---`);
        console.log(poList.join(", "));
        // 10. Duplicates
        if (dumpDuplicates.length) {
            console.log(`\n--- Duplicates in Dump ---`);
            dumpDuplicates.forEach(([po, docs]) => {
                console.log(`PO: ${po.padEnd(15)} | Count: ${docs.length}`);
            });
        }
        if (suiteDuplicates.length) {
            console.log(`\n--- Duplicates in Suite ---`);
            suiteDuplicates.forEach(([po, docs]) => {
                console.log(`PO: ${po.padEnd(15)} | Count: ${docs.length}`);
            });
        }
        console.log(`\n=== Done ===\n`);
    }
    catch (err) {
        console.error("Error >>>", err);
    }
}
/** Returns true if two staged PO payloads have identical business content. */
function isStagedPOContentEqual(a, b) {
    for (const field of PO_CONTENT_FIELDS) {
        const aVal = JSON.stringify(a?.[field] ?? null);
        const bVal = JSON.stringify(b?.[field] ?? null);
        if (aVal !== bVal)
            return false;
    }
    return true;
}
const getDuplicatePoNumbersInDummy = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const results = await ns_db.collection("suite_purchase_order_dummy").aggregate([
        { $group: { _id: "$po_number", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 }, _id: { $ne: null } } },
        { $project: { po_number: "$_id", count: 1, _id: 0 } }
    ]).toArray();
    console.log(results);
    return results;
};
exports.getDuplicatePoNumbersInDummy = getDuplicatePoNumbersInDummy;
// Delete all documents with duplicate po_numbers (removes all, not just extras)
const countDuplicatesToDeleteInDummy = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const duplicateResults = await (0, exports.getDuplicatePoNumbersInDummy)();
    const duplicatePoNumbers = duplicateResults.map(d => d.po_number);
    if (duplicatePoNumbers.length > 0) {
        const count = await ns_db
            .collection("suite_purchase_order_dummy")
            .countDocuments({ po_number: { $in: duplicatePoNumbers } });
        return count;
    }
    return 0;
};
exports.countDuplicatesToDeleteInDummy = countDuplicatesToDeleteInDummy;
const deleteAllDuplicatesInDummy = async () => {
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const duplicateResults = await (0, exports.getDuplicatePoNumbersInDummy)();
    const duplicatePoNumbers = duplicateResults.map(d => d.po_number);
    if (duplicatePoNumbers.length > 0) {
        const result = await ns_db
            .collection("suite_purchase_order_dummy")
            .deleteMany({ po_number: { $in: duplicatePoNumbers } });
        return result.deletedCount || 0;
    }
    return 0;
};
exports.deleteAllDuplicatesInDummy = deleteAllDuplicatesInDummy;
