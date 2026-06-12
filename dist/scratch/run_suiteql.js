"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
async function runQuery() {
    const accountId = process.env.NS_ACCOUNT_ID;
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    const url = `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
    const query = process.argv[2] || "SELECT id, itemid FROM item FETCH FIRST 10 ROWS ONLY";
    try {
        const response = await axios_1.default.post(url, { q: query }, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "POST"),
                "Content-Type": "application/json",
                "Prefer": "transient"
            }
        });
        const items = response.data.items || [];
        console.log("Results:", JSON.stringify(items, null, 2));
    }
    catch (error) {
        console.error(`[ERROR]`, JSON.stringify(error.response?.data || error.message));
    }
}
runQuery();
