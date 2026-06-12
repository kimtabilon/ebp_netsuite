"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const axios_1 = __importDefault(require("axios"));
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
const PAGE_SIZE = 500;
async function runSuiteQL(query) {
    const url = `${BASE_URL}/services/rest/query/v1/suiteql`;
    try {
        const res = await axios_1.default.post(url, { q: query }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                "Content-Type": "application/json",
                Prefer: "transient"
            },
            timeout: 60000
        });
        return res.data.items || [];
    }
    catch (err) {
        logger_config_1.default.error("❌ SuiteQL Error:", err.response?.data || err.message);
        return [];
    }
}
async function dumpReceipts() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("dump_items_receipt");
    logger_config_1.default.info("🚀 Starting ENHANCED Item Receipt Dump (with Serial Numbers)...");
    let lastId = 0;
    let totalReceipts = 0;
    let batchCount = 0;
    while (true) {
        batchCount++;
        logger_config_1.default.info(`[BATCH #${batchCount}] lastId > ${lastId}`);
        // 1. Fetch Header IDs
        const headerQuery = `
            SELECT id, tranid, trandate, lastmodifieddate, createddate, memo,
                   BUILTIN.DF(status) as status, BUILTIN.DF(entity) as vendor, entity as vendor_id,
                   createdby as created_by_id, BUILTIN.DF(createdby) as created_by_name
            FROM transaction
            WHERE type = 'ItemRcpt' AND id > ${lastId}
            ORDER BY id ASC
            FETCH FIRST ${PAGE_SIZE} ROWS ONLY
        `;
        const headers = await runSuiteQL(headerQuery);
        if (!headers.length)
            break;
        const ids = headers.map(h => h.id);
        lastId = parseInt(ids[ids.length - 1], 10);
        // 2. Fetch all Lines and Serial Numbers for these IDs
        const linesQuery = `
            SELECT 
                tl.transaction, 
                tl.item, 
                BUILTIN.DF(tl.item) as item_name, 
                tl.quantity, 
                tl.mainline, 
                tl.taxline, 
                tl.iscogs, 
                BUILTIN.DF(tl.location) as location,
                tl.uniquekey,
                tl.id as line_id,
                BUILTIN.DF(ia.inventorynumber) as serial_number
            FROM transactionLine tl
            LEFT JOIN InventoryAssignment ia ON (ia.transaction = tl.transaction AND ia.transactionline = tl.id)
            WHERE tl.transaction IN (${ids.join(',')})
        `;
        const lines = await runSuiteQL(linesQuery);
        // 3. Merge Headers and Lines (Aggregating serial numbers)
        const receipts = {};
        headers.forEach(h => {
            receipts[h.id] = {
                ns_internal_id: h.id,
                ...h,
                items: {},
                dumped_at: new Date()
            };
            delete receipts[h.id].links;
        });
        lines.forEach(l => {
            if (l.item && l.taxline === 'F' && l.iscogs === 'F') {
                const lineKey = l.uniquekey;
                if (!receipts[l.transaction].items[lineKey]) {
                    receipts[l.transaction].items[lineKey] = {
                        item_id: l.item,
                        item_name: l.item_name,
                        quantity: Math.abs(parseFloat(l.quantity)),
                        location: l.location,
                        serial_numbers: []
                    };
                }
                if (l.serial_number) {
                    receipts[l.transaction].items[lineKey].serial_numbers.push(l.serial_number);
                }
            }
        });
        // Convert grouped items object back to array
        Object.values(receipts).forEach((r) => {
            r.items = Object.values(r.items);
        });
        // 4. Bulk Write to MongoDB
        const bulkOps = Object.values(receipts).map((r) => ({
            updateOne: {
                filter: { ns_internal_id: r.ns_internal_id },
                update: { $set: r },
                upsert: true
            }
        }));
        if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps);
        }
        totalReceipts += headers.length;
        logger_config_1.default.info(`✅ Batch #${batchCount} processed. Total unique receipts: ${totalReceipts}`);
        if (headers.length < PAGE_SIZE)
            break;
    }
    logger_config_1.default.info(`🏁 Finished. Total receipts dumped: ${totalReceipts}`);
}
dumpReceipts().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
