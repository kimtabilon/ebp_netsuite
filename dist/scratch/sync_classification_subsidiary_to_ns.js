"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const logger_config_1 = __importDefault(require("../config/logger.config"));
async function patchClassification(id, subsidiaries) {
    const baseUrl = (0, netsuite_rest_client_1.buildRestApiUrl)();
    const url = `${baseUrl}/classification/${id}`;
    // NetSuite REST API for collections often requires the "items" wrapper
    const body = {
        subsidiary: {
            items: subsidiaries.map(id => ({ id }))
        }
    };
    logger_config_1.default.info(`[NS REST] PATCH ${url} -> ${JSON.stringify(body)}`);
    const response = await axios_1.default.patch(url, body, {
        headers: {
            Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "PATCH"),
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        timeout: 60000,
    });
    return response.data;
}
async function syncToNetSuite() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("ns_rest_classification_detail_dump_dummy");
    // Filter for records missing subsidiary ID 2
    const filter = {
        "payload.subsidiary.items": {
            "$not": {
                "$elemMatch": {
                    "id": "2"
                }
            }
        }
    };
    const records = await collection.find(filter).toArray();
    logger_config_1.default.info(`🚀 Found ${records.length} classifications to update in NetSuite...`);
    let success = 0;
    let failed = 0;
    for (const doc of records) {
        const nsId = doc.ns_internal_id || doc.id;
        if (!nsId) {
            logger_config_1.default.warn(`⚠️  Record missing NetSuite ID: ${doc._id}`);
            continue;
        }
        try {
            // ONLY send ID 2 as the subsidiary (replaces existing ID 1)
            const subIds = ["2"];
            logger_config_1.default.info(`🔄 Updating Classification ${nsId} (${doc.payload?.name || "?"}) to Subsidiary ID 2...`);
            const data = await patchClassification(nsId, subIds);
            logger_config_1.default.info(` data >>>>>>  ${data} `);
            // Update MongoDB to reflect the change
            // await collection.updateOne(
            //     { _id: doc._id },
            //     { 
            //         $set: { 
            //             "payload.subsidiary.items": [{ id: "2", refName: "Parent Company : eCommerce Business Prime" }],
            //             "payload.subsidiary.count": 1,
            //             ns_synced_back_at: new Date()
            //         }
            //     }
            // );
            success++;
            logger_config_1.default.info(`✅  Success (${success}/${records.length})`);
        }
        catch (err) {
            failed++;
            const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            logger_config_1.default.error(`❌  Failed to update Classification ${nsId}: ${errMsg}`);
        }
        // Throttle to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
    }
    logger_config_1.default.info(`\n--- SYNC COMPLETE ---`);
    logger_config_1.default.info(`Success: ${success}`);
    logger_config_1.default.info(`Failed:  ${failed}`);
}
syncToNetSuite().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
