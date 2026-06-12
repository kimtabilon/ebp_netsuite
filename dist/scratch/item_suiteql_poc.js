"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const mongdodb_config_1 = require("../config/mongdodb.config");
async function runSuiteQL(query) {
    const accountId = process.env.NS_ACCOUNT_ID;
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    const url = `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
    try {
        const response = await axios_1.default.post(url, { q: query }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                "Content-Type": "application/json",
                "Prefer": "transient"
            }
        });
        return response.data.items || [];
    }
    catch (error) {
        console.error(`[ERROR]`, JSON.stringify(error.response?.data || error.message));
        return [];
    }
}
async function syncAllItems() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("dump_inventory_item");
    let lastId = null;
    const pageSize = 1000;
    let totalSynced = 0;
    console.log("Starting Exhaustive Inventory Item Sync...");
    // Auto-Resume logic: Find the last synced ID in the database
    // We fetch the highest ID by sorting numerically
    const lastDoc = await collection.aggregate([
        { $project: { numericId: { $toInt: "$ns_internal_id" } } },
        { $sort: { numericId: -1 } },
        { $limit: 1 }
    ]).toArray();
    if (lastDoc.length > 0) {
        lastId = lastDoc[0].numericId;
        console.log(`🔄 Resuming from last synced ID: ${lastId}`);
    }
    while (true) {
        console.log(`[FETCH] Last ID: ${lastId ?? 'START'}...`);
        const whereClause = lastId !== null
            ? `WHERE i.itemtype IN ('InvtPart', 'Assembly', 'Kit') AND i.id > ${lastId}`
            : `WHERE i.itemtype IN ('InvtPart', 'Assembly', 'Kit')`;
        // Main item query
        const itemQuery = `
            SELECT 
                i.id, i.itemid, i.displayname, i.description,
                i.assetaccount, BUILTIN.DF(i.assetaccount) as asset_name,
                i.expenseaccount, BUILTIN.DF(i.expenseaccount) as expense_name,
                i.class, BUILTIN.DF(i.class) as class_name,
                i.custitem2, BUILTIN.DF(i.custitem2) as brand_name,
                i.createddate, i.averagecost, i.totalquantityonhand
            FROM item i 
            ${whereClause}
            ORDER BY i.id 
            FETCH NEXT ${pageSize} ROWS ONLY
        `;
        const items = await runSuiteQL(itemQuery);
        if (items.length === 0)
            break;
        const itemIds = items.map((r) => r.id).join(",");
        // Fetch preferred vendors for this batch
        const vendorQuery = `
            SELECT 
                iv.item,
                iv.vendor as vendor_id,
                v.entitytitle as vendor_name,
                iv.purchaseprice
            FROM itemvendor iv
            INNER JOIN vendor v ON v.id = iv.vendor
            WHERE iv.item IN (${itemIds})
            AND iv.preferredvendor = 'T'
        `;
        const vendors = await runSuiteQL(vendorQuery);
        const vendorMap = new Map();
        vendors.forEach((v) => {
            vendorMap.set(String(v.item), {
                id: String(v.vendor_id),
                name: v.vendor_name
            });
        });
        // Fetch locations for this batch — using correct field names from AggregateItemLocation
        const locationQuery = `
            SELECT 
                ail.item,
                ail.location as location_id,
                BUILTIN.DF(ail.location) as location_name,
                ail.quantityonhand,
                ail.quantityavailable,
                ail.quantitycommitted,
                ail.quantityonorder,
                ail.quantitybackordered,
                ail.preferredstocklevel,
                ail.leadtime,
                ail.lastpurchasepricemli
            FROM aggregateitemlocation ail
            WHERE ail.item IN (${itemIds})
        `;
        const locations = await runSuiteQL(locationQuery);
        const locationMap = new Map();
        locations.forEach((loc) => {
            const itemId = String(loc.item);
            if (!locationMap.has(itemId))
                locationMap.set(itemId, []);
            locationMap.get(itemId).push({
                id: String(loc.location_id),
                name: loc.location_name,
                quantityOnHand: parseFloat(loc.quantityonhand || "0"),
                quantityAvailable: parseFloat(loc.quantityavailable || "0"),
                quantityCommitted: parseFloat(loc.quantitycommitted || "0"),
                quantityOnOrder: parseFloat(loc.quantityonorder || "0"),
                quantityBackOrdered: parseFloat(loc.quantitybackordered || "0"),
                preferredStockLevel: parseFloat(loc.preferredstocklevel || "0"),
                leadTime: parseInt(loc.leadtime || "0"),
                lastPurchasePrice: parseFloat(loc.lastpurchasepricemli || "0")
            });
        });
        // Build docs
        const docs = items.map((row) => {
            const itemIdStr = String(row.id);
            const vendor = vendorMap.get(itemIdStr);
            const itemLocs = locationMap.get(itemIdStr) || [];
            return {
                ns_internal_id: itemIdStr,
                dumped_at: new Date(),
                payload: {
                    id: itemIdStr,
                    itemId: row.itemid,
                    displayName: row.displayname,
                    description: row.description,
                    assetAccount: { id: row.assetaccount, refName: row.asset_name },
                    expenseAccount: { id: row.expenseaccount, refName: row.expense_name },
                    class: { id: row.class, refName: row.class_name },
                    brand: { id: row.custitem2, refName: row.brand_name },
                    createdDate: row.createddate,
                    averageCost: parseFloat(row.averagecost || "0"),
                    totalQuantityOnHand: parseFloat(row.totalquantityonhand || "0"),
                    preferredVendor: vendor || null,
                    purchasePrice: vendor ? parseFloat(vendors.find((v) => String(v.item) === itemIdStr)?.purchaseprice || "0") : 0,
                    locations: itemLocs
                }
            };
        });
        const ops = docs.map(doc => ({
            updateOne: { filter: { ns_internal_id: doc.ns_internal_id }, update: { $set: doc }, upsert: true }
        }));
        await collection.bulkWrite(ops);
        totalSynced += docs.length;
        lastId = items[items.length - 1].id;
        console.log(`[SYNCED] ${totalSynced} items total. Last ID: ${lastId}`);
        if (items.length < pageSize)
            break;
    }
    console.log(`\n✅ COMPLETED. Total records synced: ${totalSynced}`);
    process.exit(0);
}
syncAllItems();
