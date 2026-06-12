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
async function dumpFulfillments() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("dump_fulfillment");
    logger_config_1.default.info("🚀 Starting ENHANCED Fulfillment Dump (with Serial Numbers)...");
    let lastId = 0;
    let totalFulfillments = 0;
    let batchCount = 0;
    while (true) {
        batchCount++;
        logger_config_1.default.info(`[BATCH #${batchCount}] lastId > ${lastId}`);
        // 1. Fetch Header IDs
        const headerQuery = `
            SELECT id, tranid, trandate, lastmodifieddate, createddate, memo, otherrefnum,
                   BUILTIN.DF(status) as status, BUILTIN.DF(entity) as customer, entity as customer_id
            FROM transaction
            WHERE type = 'ItemShip' AND id > ${lastId}
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
        const fulfillments = {};
        headers.forEach(h => {
            fulfillments[h.id] = {
                ns_internal_id: h.id,
                ...h,
                items: {}, // Use object temporarily to group by line uniquekey
                dumped_at: new Date()
            };
            delete fulfillments[h.id].links;
        });
        lines.forEach(l => {
            if (l.item && l.taxline === 'F' && l.iscogs === 'F') {
                const lineKey = l.uniquekey;
                if (!fulfillments[l.transaction].items[lineKey]) {
                    fulfillments[l.transaction].items[lineKey] = {
                        item_id: l.item,
                        item_name: l.item_name,
                        quantity: Math.abs(parseFloat(l.quantity)),
                        location: l.location,
                        serial_numbers: []
                    };
                }
                if (l.serial_number) {
                    fulfillments[l.transaction].items[lineKey].serial_numbers.push(l.serial_number);
                }
            }
        });
        // Convert grouped items object back to array
        Object.values(fulfillments).forEach((f) => {
            f.items = Object.values(f.items);
        });
        // 4. Bulk Write to MongoDB
        const bulkOps = Object.values(fulfillments).map((f) => ({
            updateOne: {
                filter: { ns_internal_id: f.ns_internal_id },
                update: { $set: f },
                upsert: true
            }
        }));
        if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps);
        }
        totalFulfillments += headers.length;
        logger_config_1.default.info(`✅ Batch #${batchCount} processed. Total unique fulfillments: ${totalFulfillments}`);
        if (headers.length < PAGE_SIZE)
            break;
    }
    logger_config_1.default.info(`🏁 Finished. Total fulfillments dumped: ${totalFulfillments}`);
}
dumpFulfillments().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
