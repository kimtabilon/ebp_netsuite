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
async function dumpClasses() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("dump_class");
    let lastId = 0;
    const limit = 1000;
    let hasMore = true;
    let totalDumped = 0;
    while (hasMore) {
        const sql = `
            SELECT 
                id, 
                name, 
                fullname, 
                isinactive, 
                lastmodifieddate,
                BUILTIN.DF(subsidiary) as subsidiary_name,
                subsidiary as subsidiary_id
            FROM 
                classification
            WHERE 
                id > ${lastId}
            ORDER BY 
                id ASC
            FETCH FIRST ${limit} ROWS ONLY
        `;
        try {
            const results = await runSuiteQL(sql);
            logger_config_1.default.info(`📥 [LastId: ${lastId}] Received ${results.length} classes from NetSuite.`);
            if (results.length === 0) {
                hasMore = false;
                break;
            }
            const bulkOps = results.map((c) => {
                delete c.links;
                return {
                    updateOne: {
                        filter: { id: c.id },
                        update: { $set: { ...c, dumped_at: new Date() } },
                        upsert: true
                    }
                };
            });
            const result = await collection.bulkWrite(bulkOps);
            totalDumped += result.upsertedCount + result.modifiedCount;
            // Update lastId for the next page
            lastId = parseInt(results[results.length - 1].id, 10);
            if (results.length < limit) {
                hasMore = false;
            }
        }
        catch (err) {
            logger_config_1.default.error(`🔥 Dump Failed at LastId ${lastId}: ${err.message}`);
            hasMore = false;
        }
    }
    logger_config_1.default.info(`✅ Successfully dumped ${totalDumped} total classifications.`);
}
dumpClasses().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
