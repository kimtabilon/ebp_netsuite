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
const DUMP_COLLECTION = "dump_sales_order";
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
        }
        else {
            console.error(`❌ SuiteQL Error (${status}):`, err.message);
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
    console.log("🚀 Starting ENHANCED SO SYNC to MongoDB");
    console.log(`📊 Page Size: ${PAGE_SIZE}`);
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection(DUMP_COLLECTION);
    await collection.createIndex({ "so.id": 1 }, { unique: true, sparse: true });
    console.log("✅ MongoDB connected & index ensured\n");
    let lastId = 0;
    let totalSOs = 0;
    let totalLines = 0;
    let batchCount = 0;
    while (true) {
        batchCount++;
        console.log(`[FETCH BATCH #${batchCount}] lastId > ${lastId}`);
        const headerQuery = `
            SELECT
                t.id AS so_id,
                t.tranid,
                t.trandate,
                t.lastmodifieddate,
                t.createddate,
                t.memo,
                t.otherrefnum,
                t.shipdate,
                t.exchangerate,
                t.total,
                BUILTIN.DF(t.status) AS status_name,
                t.entity AS customer_id,
                BUILTIN.DF(t.entity) AS customer_name,
                t.currency AS currency_id,
                BUILTIN.DF(t.currency) AS currency_name,
                tl_main.location AS location_id,
                BUILTIN.DF(tl_main.location) AS location_name,
                t.subsidiary AS subsidiary_id,
                BUILTIN.DF(t.subsidiary) AS subsidiary_name,
                t.csegecomm_channel AS channel_id,
                BUILTIN.DF(t.csegecomm_channel) AS channel_name,
                t.terms AS terms_id,
                BUILTIN.DF(t.terms) AS terms_name,
                t.custbody1,
                t.custbody3,
                t.billingaddress,
                t.shippingaddress,
                t.customform AS customform_id,
                BUILTIN.DF(t.customform) AS customform_name,
                t.transactionnumber,
                t.custbody_nsc_prime
            FROM transaction t
            JOIN transactionline tl_main ON (tl_main.transaction = t.id AND tl_main.mainline = 'T')
            WHERE t.type = 'SalesOrd'
            AND t.id > ${lastId}
            ORDER BY t.id
            FETCH FIRST ${PAGE_SIZE} ROWS ONLY
        `;
        const headers = await runSuiteQL(headerQuery);
        if (!headers.length)
            break;
        const soIds = headers.map(h => h.so_id);
        lastId = soIds[soIds.length - 1];
        console.log(`   📋 Got ${soIds.length} SOs: ${soIds[0]} → ${lastId}`);
        const linesQuery = `
            SELECT
                tl.transaction AS so_id,
                tl.linesequencenumber AS line,
                tl.item AS item_id,
                BUILTIN.DF(tl.item) AS item_name,
                tl.quantity,
                tl.rate,
                tl.amount,
                tl.location AS location_id,
                BUILTIN.DF(tl.location) AS location_name,
                tl.isclosed,
                tl.custcol_rm_po_rate
            FROM transactionLine tl
            WHERE tl.transaction IN (${soIds.join(",")})
            AND tl.mainline = 'F'
            AND tl.item IS NOT NULL
            AND tl.itemtype IN ('InvtPart', 'NonInvtPart', 'Assembly', 'Kit', 'Service', 'OtherCharge', 'GiftCert')
            ORDER BY tl.transaction, tl.linesequencenumber
        `;
        const lines = await runSuiteQL(linesQuery);
        const linesBySo = new Map();
        for (const l of lines) {
            if (!linesBySo.has(l.so_id))
                linesBySo.set(l.so_id, []);
            linesBySo.get(l.so_id).push({
                line: l.line,
                item: { id: l.item_id, name: l.item_name },
                quantity: Math.abs(Number(l.quantity || 0)),
                rate: Number(l.rate || 0),
                amount: Math.abs(Number(l.amount || 0)),
                location: { id: l.location_id, name: l.location_name },
                isClosed: l.isclosed === "T" || l.isclosed === true,
                custcol_rm_po_rate: l.custcol_rm_po_rate ? Number(l.custcol_rm_po_rate) : null
            });
        }
        const docs = headers.map(h => {
            const soLines = linesBySo.get(h.so_id) || [];
            totalLines += soLines.length;
            return {
                so: {
                    id: h.so_id,
                    tranid: h.tranid,
                    tranDate: h.trandate,
                    createdDate: h.createddate,
                    lastModified: h.lastmodifieddate,
                    memo: h.memo,
                    otherRefNum: h.otherrefnum,
                    shipDate: h.shipdate,
                    exchangeRate: h.exchangerate ? Number(h.exchangerate) : null,
                    total: h.total ? Number(h.total) : null,
                    status: { refName: h.status_name },
                    customer: { id: h.customer_id, name: h.customer_name },
                    currency: { id: h.currency_id, refName: h.currency_name },
                    location: { id: h.location_id, refName: h.location_name },
                    subsidiary: { id: h.subsidiary_id, refName: h.subsidiary_name },
                    channel: { id: h.channel_id, refName: h.channel_name },
                    terms: { id: h.terms_id, refName: h.terms_name },
                    custbody1: h.custbody1,
                    custbody3: h.custbody3,
                    billingAddress: h.billingaddress,
                    shippingAddress: h.shippingaddress,
                    customForm: { id: h.customform_id, refName: h.customform_name },
                    transactionNumber: h.transactionnumber,
                    custbody_nsc_prime: h.custbody_nsc_prime === "T" || h.custbody_nsc_prime === true,
                    items: soLines
                },
                _syncMeta: {
                    syncedAt: new Date(),
                    source: "netsuite_so_suiteql_poc",
                    batchNumber: batchCount
                }
            };
        });
        try {
            if (docs.length > 0) {
                const bulkOps = docs.map(d => ({
                    updateOne: {
                        filter: { "so.id": d.so.id },
                        update: { $set: d },
                        upsert: true
                    }
                }));
                await collection.bulkWrite(bulkOps, { ordered: false });
            }
        }
        catch (err) {
            console.error("⚠️ BulkWrite warning:", err.message);
        }
        totalSOs += headers.length;
        console.log(`✅ Batch done | SOs: ${headers.length} | Total: ${totalSOs} | Lines: ${totalLines}`);
        if (headers.length < PAGE_SIZE) {
            console.log(`   🏁 Last batch, finishing...`);
            break;
        }
    }
    const count = await collection.countDocuments();
    console.log("\n==============================");
    console.log(`🎉 SYNC COMPLETE`);
    console.log(`📦 Total SOs synced: ${totalSOs}`);
    console.log(`📋 Total line items: ${totalLines}`);
    console.log(`🗄️  Documents in ${DUMP_COLLECTION}: ${count}`);
    console.log("==============================");
}
start().catch(err => {
    console.error("❌ Fatal Error:", err);
    process.exit(1);
});
