"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
// ── Check which items have a specific vendor registered as approved supplier ──
// Usage: tsx netsuite/scratch/check_item_vendors.ts [vendorId]
// Default vendor: 131 (Distribution Management - DLL)
async function checkItemVendors() {
    const accountId = process.env.NS_ACCOUNT_ID;
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    const url = `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
    const vendorId = process.argv[2] || "131";
    // Query all vendors we care about if no specific vendorId passed
    const vendorIds = process.argv[2]
        ? [process.argv[2]]
        : ["117", "118", "119", "131", "133", "268", "269"]; // All known distributor IDs
    console.log(`\n🔍 Checking items with approved vendor(s): [${vendorIds.join(", ")}]\n`);
    for (const vid of vendorIds) {
        const query = `
            SELECT 
                item.itemid   AS sku,
                item.id       AS item_internal_id,
                vendor.entityid AS vendor_entity_id,
                vendor.id     AS vendor_internal_id
            FROM itemvendor
            JOIN item   ON item.id   = itemvendor.item
            JOIN vendor ON vendor.id = itemvendor.vendor
            WHERE vendor.id = ${vid}
            ORDER BY item.itemid
        `;
        try {
            const response = await axios_1.default.post(url, { q: query }, {
                headers: {
                    Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                    "Content-Type": "application/json",
                    "Prefer": "transient"
                }
            });
            const items = response.data.items || [];
            console.log(`\n✅ Vendor ID ${vid} — found on ${items.length} item(s):`);
            if (items.length === 0) {
                console.log(`   ⚠️  This vendor is NOT registered on ANY item! All Dropship POs for this vendor will fail to link.`);
            }
            else {
                items.forEach((row) => {
                    console.log(`   • ${row.sku} (item_id: ${row.item_internal_id})`);
                });
            }
        }
        catch (error) {
            console.error(`[ERROR] Vendor ${vid}:`, JSON.stringify(error.response?.data || error.message));
        }
    }
    console.log("\n✅ Done.\n");
}
checkItemVendors();
