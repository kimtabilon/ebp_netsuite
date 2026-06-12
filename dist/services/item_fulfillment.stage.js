"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageItemFulfillmentsDummy = exports.IF_COLLECTION = void 0;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
exports.IF_COLLECTION = "suite_item_fulfillment";
const STAGE_WORKERS = 5;
const stageItemFulfillmentsDummy = async () => {
    logger_config_1.default.info("[IF Stage Dummy] Starting...");
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = ns_db.collection(exports.IF_COLLECTION);
    const soCollection = ns_db.collection("suite_sales_order");
    const poCollection = ns_db.collection("suite_purchase_order_dummy");
    const billCollection = ns_db.collection("suite_vendor_bill_dummy");
    const filter = {
        $and: [
            { po_type: "Dropship" },
            {
                $or: [
                    { status2: RegExp("^shipped$", "i") },
                    { status2: RegExp("^invoiced$", "i") },
                ]
            },
            { website_order_number: { $exists: true, $ne: "" } },
            { tracking: { $exists: true, $ne: null } },
            { created_at: { $gte: "2026-01-01" } }
        ]
    };
    const pos = await po_db.collection("po_management").find(filter).toArray();
    logger_config_1.default.info(`[IF Stage Dummy] Found ${pos.length} Dropship Shipped POs`);
    if (pos.length === 0)
        return { processed: 0, skipped: 0, reasons: {} };
    // --- OPTIMIZATION: BATCH FETCH ALL DEPENDENCIES ---
    logger_config_1.default.info(`[IF Stage Dummy] Batch fetching dependencies...`);
    const allPoNumbers = pos.map(p => Number(p.po_number));
    const allWebsiteOrderNums = pos.map(p => String(p.website_order_number || "").trim()).filter(Boolean);
    // Fetch in parallel
    const [poDocs, soDocs, billDocs, existingIfDocs] = await Promise.all([
        poCollection.find({ po_number: { $in: allPoNumbers } }).project({ po_number: 1, ns_synced: 1 }).toArray(),
        soCollection.find({ otherrefnum: { $in: allWebsiteOrderNums } }).project({ otherrefnum: 1, ns_synced: 1 }).toArray(),
        billCollection.find({ po_number: { $in: allPoNumbers } }).project({ po_number: 1, invoice_number: 1 }).toArray(),
        collection.find({ po_number: { $in: allPoNumbers } }).toArray()
    ]);
    // Convert to Maps for O(1) lookup
    const poMap = new Map(poDocs.map(d => [d.po_number, d]));
    const soMap = new Map(soDocs.map(d => [d.otherrefnum, d]));
    const billMap = new Map(billDocs.map(d => [d.po_number, d]));
    const existingIfMap = new Map(existingIfDocs.map(d => [d.po_number, d]));
    logger_config_1.default.info(`[IF Stage Dummy] Dependency maps ready.`);
    const staged = [];
    let skippedCount = 0;
    const skipReasons = {};
    function markSkip(ref, reason) {
        skippedCount++;
        skipReasons[reason] = (skipReasons[reason] || 0) + 1;
        // log.warn(`[IF Stage][SKIP] PO: ${ref} | Reason: ${reason}`);
    }
    for (const po of pos) {
        const poNum = Number(po.po_number);
        const websiteOrderNum = String(po.website_order_number || "").trim();
        if (!websiteOrderNum) {
            markSkip(String(poNum), "no_website_order_number");
            continue;
        }
        // Resolve tracking number
        let trackingNumber = "";
        if (Array.isArray(po.tracking)) {
            trackingNumber = po.tracking[0]?.tracking_number || po.tracking[0] || "";
        }
        else if (typeof po.tracking === "string") {
            trackingNumber = po.tracking;
        }
        else if (po.tracking && po.tracking.tracking_number) {
            trackingNumber = po.tracking.tracking_number;
        }
        if (!trackingNumber) {
            markSkip(String(poNum), "no_tracking_number");
            continue;
        }
        // Check dependencies via memory Maps (INSTANT)
        const poDoc = poMap.get(poNum);
        const po_exist = !!poDoc;
        const po_synced = !!(poDoc && poDoc.ns_synced === true);
        const soDoc = soMap.get(websiteOrderNum);
        const so_exist = !!soDoc;
        const so_synced = !!(soDoc && soDoc.ns_synced === true);
        if (!po_synced) {
            markSkip(String(poNum), "po_not_synced");
            continue;
        }
        if (!so_synced) {
            markSkip(String(poNum), "so_not_synced");
            continue;
        }
        // --- SERIAL BUCKET PREP ---
        let serialBucket = [];
        if (Array.isArray(po.serials) && po.serials.length > 0) {
            serialBucket = [...po.serials];
        }
        // Build items with serial numbers (with smart distribution)
        let serialPtr = 0;
        const items = (po.order_items || []).map((item) => {
            const sku = String(item.sku || "").trim();
            const qty = parseInt(item.qty || item.quantity || "1", 10);
            // Path 1: Direct line-item serials
            let serials = Array.isArray(item.serial_numbers) ? item.serial_numbers : [];
            // Path 2: Smart distribution from top-level "serials" bucket
            if (serials.length === 0 && serialBucket.length > 0) {
                // Take up to 'qty' serials from the bucket
                serials = serialBucket.slice(serialPtr, serialPtr + qty);
                serialPtr += qty;
            }
            // Path 3: Nested distributor_items -> shipmentdetails -> serialnumber (Fallback)
            if (serials.length === 0 && po.distributor_items && po.distributor_items[sku]) {
                const distItem = po.distributor_items[sku];
                const shipDetails = Array.isArray(distItem.shipmentdetails) ? distItem.shipmentdetails : [];
                if (shipDetails.length > 0) {
                    serials = shipDetails[0].serialnumber || shipDetails[0].serial_numbers || [];
                }
            }
            return {
                sku: sku,
                quantity: qty,
                serial_numbers: Array.isArray(serials) ? serials : []
            };
        }).filter((item) => item.sku);
        if (items.length === 0) {
            markSkip(String(poNum), "no_items");
            continue;
        }
        // Build shipping address (with null check as requested)
        const rawShipping = po.shipping_details;
        let shipping_address = null;
        if (rawShipping && typeof rawShipping === "object" && Object.keys(rawShipping).length > 0) {
            shipping_address = {
                addressee: rawShipping.name || rawShipping.addressee || "",
                addr1: rawShipping.address1 || rawShipping.addr1 || "",
                addr2: rawShipping.address2 || rawShipping.addr2 || "",
                city: rawShipping.city || "",
                state: rawShipping.state || "",
                zip: rawShipping.zip || rawShipping.postal_code || "",
                country: rawShipping.country || ""
            };
        }
        const doc = {
            po_number: poNum,
            website_order_number: websiteOrderNum,
            ship_date: po.ship_date || po.updated_at || "",
            tracking_number: trackingNumber,
            weight_lbs: 1,
            po_type: "Dropship",
            bill_number: String(billMap.get(poNum)?.invoice_number || ""),
            shipping_address,
            items,
            po_exist,
            po_synced,
            so_exist,
            so_synced
        };
        const existingDoc = existingIfMap.get(poNum);
        // User requested: Do not update already staged item fulfillments
        if (existingDoc) {
            // (doc as any).updated_at = new Date();
            continue; // Skip it completely in memory
        }
        else {
            doc.created_at = new Date();
        }
        staged.push(doc);
    }
    if (staged.length > 0) {
        await collection.bulkWrite(staged.map(doc => ({
            updateOne: {
                filter: { po_number: doc.po_number },
                update: {
                    // $setOnInsert ensures that if the IF already exists, it is completely ignored
                    // It will also NOT inject ns_synced or overwrite anything on an existing record.
                    $setOnInsert: {
                        ...doc,
                        staged_at: new Date()
                    }
                },
                upsert: true
            }
        })), { ordered: false });
    }
    logger_config_1.default.info(`[IF Stage Dummy] Done. Staged: ${staged.length} | Skipped: ${skippedCount}`);
    return { processed: staged.length, skipped: skippedCount, reasons: skipReasons };
};
exports.stageItemFulfillmentsDummy = stageItemFulfillmentsDummy;
// export async function runFunctionItemfullfillment () {
//     try {
//         const ns_db = await getDb("netsuite");
//         const DUMP_COL = "dump_fulfillment";
//         const SUITE_COL = "suite_item_fulfillment";
//         // Helper to extract PO number from memo string (e.g. PO232139-111-7013803-5073813 -> 232139)
//         const extractPoFromMemo = (memo: string): number | null => {
//             const match = memo.match(/^PO(\d+)/i);
//             return match ? Number(match[1]) : null;
//         };
//         // 1. Get all dump Fulfillments
//         const dumpDocs = await ns_db.collection(DUMP_COL)
//             .find({})
//             .project({ ns_internal_id: 1, id: 1, memo: 1 })
//             .toArray();
//         // 2. Build Sets for dump fulfillments: one for ID, one for Memo
//         const dumpIdSet = new Set<string>();
//         const dumpMemoSet = new Set<string>();
//         for (const doc of dumpDocs) {
//             const internalId = String(doc.ns_internal_id || doc.id || "").trim();
//             if (internalId) {
//                 dumpIdSet.add(internalId);
//             }
//             const memo = String(doc.memo || "").trim().toUpperCase();
//             if (memo) {
//                 dumpMemoSet.add(memo);
//             }
//         }
//         // 3. Get all dummy / staged Fulfillments
//         const suiteDocs = await ns_db.collection(SUITE_COL)
//             .find({})
//             .project({ po_number: 1, website_order_number: 1, ns_synced: 1, ns_internal_id: 1 })
//             .toArray();
//         const dummyKeysSet = new Set<string>();
//         const dummyIdSet = new Set<string>();
//         const unsyncedDummyKeysSet = new Set<string>();
//         const ghostFulfillments: number[] = [];
//         for (const doc of suiteDocs) {
//             const poNum = doc.po_number;
//             const webOrdNum = doc.website_order_number;
//             const compositeKey = `PO${poNum}-${webOrdNum}`.toUpperCase();
//             const internalId = String(doc.ns_internal_id || "").trim();
//             dummyKeysSet.add(compositeKey);
//             if (internalId) {
//                 dummyIdSet.add(internalId);
//             }
//             if (doc.ns_synced !== true) {
//                 unsyncedDummyKeysSet.add(compositeKey);
//             }
//             // Check 2: Exist in dummy and ns_synced: true but not in dump_fulfillment
//             if (doc.ns_synced === true) {
//                 let existsInDump = false;
//                 if (internalId && dumpIdSet.has(internalId)) {
//                     existsInDump = true;
//                 } else if (dumpMemoSet.has(compositeKey)) {
//                     existsInDump = true;
//                 }
//                 if (!existsInDump) {
//                     ghostFulfillments.push(Number(poNum));
//                 }
//             }
//         }
//         // Check 1: Exist in dump_fulfillment and not in dummy at all
//         const onlyInDump: number[] = [];
//         for (const doc of dumpDocs) {
//             const memo = String(doc.memo || "").trim().toUpperCase();
//             const internalId = String(doc.ns_internal_id || doc.id || "").trim();
//             let existsInDummy = false;
//             if (memo && dummyKeysSet.has(memo)) {
//                 existsInDummy = true;
//             } else if (internalId && dummyIdSet.has(internalId)) {
//                 existsInDummy = true;
//             }
//             if (!existsInDummy) {
//                 const po = extractPoFromMemo(memo);
//                 if (po !== null) {
//                     onlyInDump.push(po);
//                 }
//             }
//         }
//         // Check 3: Exist in dump_fulfillment but in dummy their ns_synced is false
//         const existInDumpButUnsyncedInDummy: number[] = [];
//         for (const doc of dumpDocs) {
//             const memo = String(doc.memo || "").trim().toUpperCase();
//             // We only count it as unsynced if the record exists in dummy but has ns_synced false
//             if (memo && unsyncedDummyKeysSet.has(memo)) {
//                 const po = extractPoFromMemo(memo);
//                 if (po !== null) {
//                     existInDumpButUnsyncedInDummy.push(po);
//                 }
//             }
//         }
//         // 5. Print results
//         console.log(`\n======================================================`);
//         console.log(`📊 ITEM FULFILLMENT DUMP VS STAGING RECONCILIATION REPORT`);
//         console.log(`======================================================`);
//         console.log(`Fulfillments only in Dump (Exist in dump_fulfillment, not in staging at all): ${onlyInDump.length}`);
//         console.log(onlyInDump.join(", ") || "[]");
//         console.log(`\nFulfillments in Dump but in Staging their ns_synced is false: ${existInDumpButUnsyncedInDummy.length}`);
//         console.log(existInDumpButUnsyncedInDummy.join(", ") || "[]");
//         console.log(`\nGhost Fulfillments (Exist in staging with ns_synced: true, not in dump_fulfillment): ${ghostFulfillments.length}`);
//         console.log(ghostFulfillments.join(", ") || "[]");
//         console.log(`======================================================\n`);
//     } catch (err) {
//         console.error("Error >>>", err);
//     }
// }
// export async function resetFulfillmentsByPoNumbers( ) {
//     try {
//         const poNumbers =  
//  []
//         const ns_db = await getDb("netsuite");
//         const collection = ns_db.collection(IF_COLLECTION);
//         const result = await collection.updateMany(
//             { po_number: { $in: poNumbers } },
//             {
//                 $unset: {
//                     ns_error: "",
//                     ns_error_at: "",
//                     ns_internal_id: "",
//                     ns_result: "",
//                     ns_so_number: "",
//                     ns_synced: "",
//                     ns_synced_at: ""
//                 }
//             }
//         );
//         console.log(`Successfully reset ${result.modifiedCount} fulfillments in ${IF_COLLECTION} for the provided PO numbers.`);
//         return result.modifiedCount;
//     } catch (err) {
//         console.error("Error in resetFulfillmentsByPoNumbers >>>", err);
//         throw err;
//     }
// }
