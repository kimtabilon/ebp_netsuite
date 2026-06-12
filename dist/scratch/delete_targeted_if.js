"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const axios_1 = __importDefault(require("axios"));
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
// Get TranIDs from command line (comma separated)
const TARGET_TRAN_IDS = process.argv[2] ? process.argv[2].split(",") : [];
async function getInternalIds(tranIds) {
    const url = `${BASE_URL}/services/rest/query/v1/suiteql`;
    const formattedIds = tranIds.map(id => `'${id.trim()}'`).join(",");
    const query = `SELECT id, tranid FROM transaction WHERE type = 'ItemShip' AND (tranid IN (${formattedIds}) OR id IN (${formattedIds}))`;
    try {
        const res = await axios_1.default.post(url, { q: query }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                "Content-Type": "application/json",
                Prefer: "transient"
            }
        });
        return res.data.items || [];
    }
    catch (err) {
        logger_config_1.default.error("❌ Lookup Error:", err.response?.data || err.message);
        return [];
    }
}
async function deleteIF(id, tranid) {
    const url = `${BASE_URL}/services/rest/record/v1/itemFulfillment/${id}`;
    try {
        await axios_1.default.delete(url, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "DELETE"),
                "Content-Type": "application/json"
            }
        });
        logger_config_1.default.info(`✅ Successfully Deleted: ${tranid} (ID: ${id})`);
        return true;
    }
    catch (err) {
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`❌ Failed to Delete ${tranid}: ${detail}`);
        return false;
    }
}
async function start() {
    if (TARGET_TRAN_IDS.length === 0) {
        console.log("Usage: npx tsx netsuite/scratch/delete_targeted_if.ts IF12345,IF67890");
        return;
    }
    logger_config_1.default.info(`🔍 Looking up Internal IDs for: ${TARGET_TRAN_IDS.join(", ")}`);
    const records = await getInternalIds(TARGET_TRAN_IDS);
    if (records.length === 0) {
        logger_config_1.default.warn("⚠️ No matching Item Fulfillments found for those IDs.");
        return;
    }
    for (const rec of records) {
        await deleteIF(rec.id, rec.tranid);
    }
}
start();
