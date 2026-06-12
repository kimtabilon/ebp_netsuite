"use strict";
// Fetch po_numbers with duplicates in suite_purchase_order_dummy
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stagePurchaseOrders = void 0;
exports.resolveVendor = resolveVendor;
exports.validateWarehouse = validateWarehouse;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
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
const stagePurchaseOrders = async () => {
    logger_config_1.default.info("[PO Stage Dummy Unique] Starting smart upsert (skip unchanged, reset sync on change)...");
    const po_db = await (0, mongdodb_config_1.getDb)("ebp_pomanager");
    const ns_db = await (0, mongdodb_config_1.getDb)("netsuite");
    const col = ns_db.collection("suite_purchase_order_dummy");
    const filter = {
        $and: [
            { created_at: { $gte: "2026-01-01" } },
            { po_number: { $exists: true, $ne: null } },
            {
                $or: [
                    { status2: RegExp("^shipped$", "i") },
                    { status2: RegExp("^invoiced$", "i") },
                ]
            }
        ]
    };
    const totalFound = await po_db.collection("po_management").countDocuments(filter);
    console.log("Total ", totalFound);
    // Use noCursorTimeout: true to prevent MongoDB from destroying the cursor if the loop takes over 10 minutes
    const po_cursor = po_db.collection("po_management").find(filter, { noCursorTimeout: true });
    let total = 0;
    let processed = 0; // successfully built (no error)
    let updated = 0; // actually written (new or changed)
    let skipped = 0; // content identical — not written
    const bulkOps = [];
    for await (const po of po_cursor) {
        total++;
        let skipReason = null;
        let stagedPO = null;
        try {
            if (!po.po_number) {
                skipReason = "Missing po_number";
            }
            const status = (po.status2 || "").toLowerCase();
            if (!skipReason && status !== "shipped" && status !== "invoiced") {
                skipReason = `Invalid status2: ${po.status2}`;
            }
            if (!skipReason) {
                const vendor = resolveVendor(po.distributor, po.payment_type);
                const validatedWarehouse = validateWarehouse(po.stocking_warehouse, po.po_type, po.po_number);
                const transformedItems = (po.order_items || []).map((item) => ({
                    sku: item.sku,
                    qty: item.quantity || item.qty || 0,
                    cost: item.amount || item.cost || 0,
                }));
                stagedPO = {
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
                    updated_at: po.updated_at || "",
                    skipReason: null,
                    error: null,
                };
                processed++;
            }
        }
        catch (err) {
            skipReason = `Exception: ${err.message || String(err)}`;
        }
        if (!po.po_number) {
            skipped++;
            continue;
        }
        if (!stagedPO) {
            skipped++;
            // Skipped or errored — we only want to stage valid data, so ignore this PO completely.
            continue;
        }
        // Only insert NEW purchase orders. 
        // Using $setOnInsert ensures that if the PO already exists in staging, it is completely ignored.
        updated++;
        bulkOps.push({
            updateOne: {
                filter: { po_number: po.po_number },
                update: {
                    $setOnInsert: {
                        ...stagedPO,
                        staged_at: new Date().toISOString()
                    }
                },
                upsert: true,
            }
        });
        // Execute in chunks of 500 to prevent connection timeouts
        if (bulkOps.length >= 500) {
            await col.bulkWrite(bulkOps, { ordered: false });
            bulkOps.length = 0; // Clear the array
        }
    }
    if (bulkOps.length > 0) {
        await col.bulkWrite(bulkOps, { ordered: false });
    }
    // Always close the cursor explicitly when using noCursorTimeout
    await po_cursor.close();
    logger_config_1.default.info(`[PO Stage Dummy Unique] Done — total=${total}, processed=${processed}, ` +
        `updated=${updated}, skipped=${skipped}`);
    return { processed, updated, skipped, total };
};
exports.stagePurchaseOrders = stagePurchaseOrders;
