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
const DUMP_COLLECTION = "dump_po";
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
    console.log("🚀 Starting ENHANCED PO SYNC to MongoDB");
    console.log(`📊 Expected POs: 5 | Page Size: ${PAGE_SIZE}`);
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection(DUMP_COLLECTION);
    await collection.createIndex({ "po.id": 1 }, { unique: true, sparse: true });
    console.log("✅ MongoDB connected & index ensured\n");
    let lastId = 0;
    let totalPOs = 0;
    let totalLines = 0;
    let batchCount = 0;
    while (true) {
        batchCount++;
        console.log(`[FETCH BATCH #${batchCount}] lastId > ${lastId}`);
        const headerQuery = `
            SELECT
                t.id AS po_id,
                t.tranid,
                t.trandate,
                t.lastmodifieddate,
                t.createddate,
                t.memo,
                t.otherrefnum, 
                t.shipdate,
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
                BUILTIN.DF(t.terms) AS terms_name,
                t.custbody2
            FROM transaction t
            WHERE t.type = 'PurchOrd'
            AND t.id > ${lastId}
            ORDER BY t.id
            FETCH FIRST ${PAGE_SIZE} ROWS ONLY
        `;
        const headers = await runSuiteQL(headerQuery);
        if (!headers.length)
            break;
        const poIds = headers.map(h => h.po_id);
        lastId = poIds[poIds.length - 1];
        console.log(`   📋 Got ${poIds.length} POs: ${poIds[0]} → ${lastId}`);
        // FIXED: Only valid SuiteQL transactionLine fields
        const linesQuery = `
            SELECT
                tl.transaction AS po_id,
                tl.linesequencenumber AS line,
                tl.item AS item_id,
                BUILTIN.DF(tl.item) AS item_name,
                tl.quantity,
                tl.rate,
                tl.amount,
                tl.expectedreceiptdate,
                tl.location AS location_id,
                BUILTIN.DF(tl.location) AS location_name,
                tl.custcol_rm_po_rate,
                tl.isclosed,
                tl.isbillable
            FROM transactionLine tl
            WHERE tl.transaction IN (${poIds.join(",")})
            AND tl.item IS NOT NULL
            ORDER BY tl.transaction, tl.linesequencenumber
        `;
        const lines = await runSuiteQL(linesQuery);
        const linesByPo = new Map();
        for (const l of lines) {
            if (!linesByPo.has(l.po_id))
                linesByPo.set(l.po_id, []);
            linesByPo.get(l.po_id).push({
                line: l.line,
                item: { id: l.item_id, name: l.item_name },
                quantity: Number(l.quantity || 0),
                rate: Number(l.rate || 0),
                amount: Number(l.amount || 0),
                expectedReceiptDate: l.expectedreceiptdate,
                location: { id: l.location_id, name: l.location_name },
                custcol_rm_po_rate: l.custcol_rm_po_rate ? Number(l.custcol_rm_po_rate) : null,
                isClosed: l.isclosed === "T" || l.isclosed === true,
                isBillable: l.isbillable === "T" || l.isbillable === true
            });
        }
        const docs = headers.map(h => {
            const poLines = linesByPo.get(h.po_id) || [];
            totalLines += poLines.length;
            return {
                po: {
                    id: h.po_id,
                    tranid: h.tranid,
                    tranDate: h.trandate,
                    createdDate: h.createddate,
                    lastModified: h.lastmodifieddate,
                    memo: h.memo,
                    otherRefNum: h.otherrefnum,
                    shipDate: h.shipdate,
                    dueDate: h.duedate,
                    exchangeRate: h.exchangerate ? Number(h.exchangerate) : null,
                    total: h.total ? Number(h.total) : null,
                    status: { refName: h.status_name },
                    vendor: { id: h.vendor_id, name: h.vendor_name },
                    currency: { id: h.currency_id, refName: h.currency_name },
                    location: { id: h.location_id, refName: h.location_name },
                    subsidiary: { id: h.subsidiary_id, refName: h.subsidiary_name },
                    terms: { id: h.terms_id, refName: h.terms_name },
                    custbody2: h.custbody2,
                    items: poLines
                },
                _syncMeta: {
                    syncedAt: new Date(),
                    source: "netsuite_suiteql_enhanced",
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
        totalPOs += headers.length;
        console.log(`✅ Batch done | POs: ${headers.length} | Total: ${totalPOs} | Lines: ${totalLines}`);
        if (headers.length < PAGE_SIZE) {
            console.log(`   🏁 Last batch, finishing...`);
            break;
        }
    }
    const count = await collection.countDocuments();
    console.log("\n==============================");
    console.log(`🎉 SYNC COMPLETE`);
    console.log(`📦 Total POs synced: ${totalPOs}`);
    console.log(`📋 Total line items: ${totalLines}`);
    console.log(`🗄️  Documents in ${DUMP_COLLECTION}: ${count}`);
    console.log("==============================");
}
start().catch(console.error);
