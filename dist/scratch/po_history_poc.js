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
async function runSuiteQL(query, limit = 1000) {
    const url = `${BASE_URL}/services/rest/query/v1/suiteql?limit=${limit}`;
    try {
        const res = await axios_1.default.post(url, { q: query }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                "Content-Type": "application/json",
                Prefer: "transient"
            }
        });
        const items = res.data.items || [];
        return items.map((item) => {
            delete item.links;
            return item;
        });
    }
    catch (err) {
        logger_config_1.default.error("❌ SuiteQL Error:", err.response?.data || err.message);
        return [];
    }
}
async function dumpPoWithHistory() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("po_history_test");
    logger_config_1.default.info("🚀 Starting COMPREHENSIVE PO History Dump (2 Samples)...");
    // 1. Fetch 2 Detailed PO Headers from transactionLine (mainline='T')
    // This table is more reliable for 'foreignamount' and locations
    const poQuery = `
        SELECT 
            tl.transaction as id, t.tranid, t.trandate, t.createddate, t.lastmodifieddate, t.memo, 
            BUILTIN.DF(t.status) as status, 
            BUILTIN.DF(t.entity) as vendor, t.entity as vendor_id,
            BUILTIN.DF(t.currency) as currency,
            tl.foreignamount as total_amount,
            BUILTIN.DF(tl.location) as location,
            BUILTIN.DF(tl.department) as department,
            BUILTIN.DF(tl.class) as class
        FROM transactionLine tl
        JOIN transaction t ON t.id = tl.transaction
        WHERE t.type = 'PurchOrd' AND tl.mainline = 'T'
        ORDER BY t.lastmodifieddate DESC
    `;
    const pos = await runSuiteQL(poQuery, 2);
    if (!pos.length)
        return;
    for (const po of pos) {
        logger_config_1.default.info(`⏳ Fetching Lines and History for PO: ${po.tranid}...`);
        const linesQuery = `
            SELECT 
                item, BUILTIN.DF(item) as item_name, 
                quantity, rate, foreignamount as amount, 
                BUILTIN.DF(location) as line_location
            FROM transactionLine
            WHERE transaction = ${po.id} AND mainline = 'F' AND taxline = 'F' AND iscogs = 'F'
        `;
        const lines = await runSuiteQL(linesQuery);
        const historyQuery = `
            SELECT 
                date as change_date, 
                BUILTIN.DF(field) as field_name, 
                oldvalue as previous_value, 
                newvalue as current_value, 
                BUILTIN.DF(name) as changed_by
            FROM systemnote
            WHERE recordid = ${po.id} AND recordtypeid = -30
            ORDER BY date DESC
        `;
        const history = await runSuiteQL(historyQuery);
        const document = {
            ns_internal_id: po.id,
            ...po,
            items: lines,
            history_log: history,
            dumped_at: new Date()
        };
        await collection.updateOne({ ns_internal_id: po.id }, { $set: document }, { upsert: true });
        logger_config_1.default.info(`✅ Saved Complete PO ${po.tranid} (${lines.length} items, ${history.length} notes).`);
    }
    logger_config_1.default.info("🏁 Finished. Check 'po_history_test' for the full data structure.");
}
dumpPoWithHistory().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
