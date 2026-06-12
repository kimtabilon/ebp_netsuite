"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
async function run() {
    const accountId = process.env.NS_ACCOUNT_ID;
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    const url = `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
    const headers = {
        Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
        "Content-Type": "application/json",
        "Prefer": "transient"
    };
    // Query 1: All vendors registered on item C3210K0 (ID 45083)
    const q1 = `SELECT vendor.id, vendor.entityid FROM itemvendor JOIN vendor ON vendor.id = itemvendor.vendor WHERE itemvendor.item = 45083`;
    const r1 = await axios_1.default.post(url, { q: q1 }, { headers });
    const vendors = r1.data.items || [];
    console.log(`\n--- Vendors approved for item C3210K0 (ID 45083): ${vendors.length} found ---`);
    if (vendors.length === 0) {
        console.log("⚠️  NO vendors are registered on this item at all!");
    }
    else {
        vendors.forEach((v) => console.log(`  • Vendor ID: ${v.id}  |  Entity ID: ${v.entityid}`));
    }
    // Query 2: Is vendor 131 specifically registered on this item?
    const q2 = `SELECT item.itemid FROM itemvendor JOIN item ON item.id = itemvendor.item WHERE itemvendor.item = 45083 AND itemvendor.vendor = 131`;
    const r2 = await axios_1.default.post(url, { q: q2 }, { headers });
    const match = r2.data.items || [];
    console.log(`\n--- Is vendor 131 (Distribution Management - DLL) on item 45083? ---`);
    console.log(match.length > 0 ? "✅ YES — vendor 131 IS registered" : "❌ NO — vendor 131 is NOT on this item");
}
run().catch(console.error);
