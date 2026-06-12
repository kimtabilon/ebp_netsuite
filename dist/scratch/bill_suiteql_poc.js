"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
const DUMP_COLLECTION = "dump_bill";
const PAGE_SIZE = 500;
async function runSuiteQL(query, retry = 0) {
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
        const status = err.response?.status;
        if (status === 400 && err.response?.data?.["o:errorDetails"]) {
            console.error("❌ SuiteQL Error:", JSON.stringify(err.response.data["o:errorDetails"], null, 2));
        }
        if ((status === 429 || status === 503) && retry < 5) {
            const wait = 3000 * (retry + 1);
            console.log(`⏳ throttled (${status}) retrying in ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
            return runSuiteQL(query, retry + 1);
        }
        throw err;
    }
}
async function start() {
    console.log("🚀 Starting VENDOR BILL SYNC to MongoDB");
    console.log(`📊 Page Size: ${PAGE_SIZE}`);
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection(DUMP_COLLECTION);
    await collection.createIndex({ "bill.id": 1 }, { unique: true, sparse: true });
    console.log("✅ MongoDB connected & index ensured\n");
    let lastId = 0;
    let totalBills = 0;
    let totalLines = 0;
    let batchCount = 0;
    while (true) {
        batchCount++;
        console.log(`[FETCH BATCH #${batchCount}] lastId > ${lastId}`);
        const headerQuery = `
            SELECT
                t.id AS bill_id,
                t.tranid,
                t.trandate,
                t.lastmodifieddate,
                t.createddate,
                t.memo,
                t.otherrefnum,
                t.duedate,
                t.exchangerate,
                t.total,
                BUILTIN.DF(t.status) AS status_name,
                t.entity AS vendor_id,
                BUILTIN.DF(t.entity) AS vendor_name,
                t.currency AS currency_id,
                BUILTIN.DF(t.currency) AS currency_name,
                t.location AS location_id,
                BUILTIN.DF(t.location) AS location_name,
                t.subsidiary AS subsidiary_id,
                BUILTIN.DF(t.subsidiary) AS subsidiary_name,
                t.terms AS terms_id,
                BUILTIN.DF(t.terms) AS terms_name
            FROM transaction t
            WHERE t.type = 'VendBill'
            AND t.id > ${lastId}
            ORDER BY t.id
            FETCH FIRST ${PAGE_SIZE} ROWS ONLY
        `;
        const headers = await runSuiteQL(headerQuery);
        if (!headers.length)
            break;
        const billIds = headers.map(h => h.bill_id);
        lastId = billIds[billIds.length - 1];
        console.log(`   📋 Got ${billIds.length} Bills: ${billIds[0]} → ${lastId}`);
        const linesQuery = `
            SELECT
                tl.transaction AS bill_id,
                tl.linesequencenumber AS line,
                tl.item AS item_id,
                BUILTIN.DF(tl.item) AS item_name,
                tl.quantity,
                tl.rate,
                tl.amount,
                tl.location AS location_id,
                BUILTIN.DF(tl.location) AS location_name,
                tl.isclosed
            FROM transactionLine tl
            WHERE tl.transaction IN (${billIds.join(",")})
            AND tl.item IS NOT NULL
            ORDER BY tl.transaction, tl.linesequencenumber
        `;
        const lines = await runSuiteQL(linesQuery);
        const linesByBill = new Map();
        for (const l of lines) {
            if (!linesByBill.has(l.bill_id))
                linesByBill.set(l.bill_id, []);
            linesByBill.get(l.bill_id).push({
                line: l.line,
                item: { id: l.item_id, name: l.item_name },
                quantity: Number(l.quantity || 0),
                rate: Number(l.rate || 0),
                amount: Number(l.amount || 0),
                location: { id: l.location_id, name: l.location_name },
                isClosed: l.isclosed === "T" || l.isclosed === true
            });
        }
        const docs = headers.map(h => {
            const billLines = linesByBill.get(h.bill_id) || [];
            totalLines += billLines.length;
            return {
                bill: {
                    id: h.bill_id,
                    tranid: h.tranid,
                    tranDate: h.trandate,
                    createdDate: h.createddate,
                    lastModified: h.lastmodifieddate,
                    memo: h.memo,
                    otherRefNum: h.otherrefnum,
                    dueDate: h.duedate,
                    exchangeRate: h.exchangerate ? Number(h.exchangerate) : null,
                    total: h.total ? Number(h.total) : null,
                    status: { refName: h.status_name },
                    vendor: { id: h.vendor_id, name: h.vendor_name },
                    currency: { id: h.currency_id, refName: h.currency_name },
                    location: { id: h.location_id, refName: h.location_name },
                    subsidiary: { id: h.subsidiary_id, refName: h.subsidiary_name },
                    terms: { id: h.terms_id, refName: h.terms_name },
                    items: billLines
                },
                _syncMeta: {
                    syncedAt: new Date(),
                    source: "netsuite_suiteql_bills",
                    batchNumber: batchCount
                }
            };
        });
        try {
            await collection.insertMany(docs, { ordered: false });
        }
        catch (err) {
            if (err.code !== 11000)
                throw err;
        }
        totalBills += headers.length;
        console.log(`✅ Batch done | Bills: ${headers.length} | Total: ${totalBills} | Lines: ${totalLines}`);
        if (headers.length < PAGE_SIZE) {
            console.log(`   🏁 Last batch, finishing...`);
            break;
        }
    }
    const count = await collection.countDocuments();
    console.log("\n==============================");
    console.log(`🎉 SYNC COMPLETE`);
    console.log(`📦 Total Bills synced: ${totalBills}`);
    console.log(`📋 Total line items: ${totalLines}`);
    console.log(`🗄️  Documents in ${DUMP_COLLECTION}: ${count}`);
    console.log("==============================");
}
start().catch(console.error);
