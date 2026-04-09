"use strict";
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
    if (staged.length > 0) {
        logger_config_1.default.info("[PO Stage] Upserting to netsuite.suite_purchase_order...");
        await ns_db.collection("suite_purchase_order").bulkWrite(staged.map(po => ({
            updateOne: {
                filter: { po_number: po.po_number },
                update: { $set: po },
                upsert: true
            }
        })));
    }
    logger_config_1.default.info(`[PO Stage] Staged ${staged.length} purchase orders to netsuite.suite_purchase_order`);
    return { processed: staged.length };
};
exports.stagePurchaseOrders = stagePurchaseOrders;
