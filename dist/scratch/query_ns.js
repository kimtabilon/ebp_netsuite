"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const netsuite_rest_client_1 = require("../services/netsuite.rest.client");
const ACCOUNT = process.env.NS_ACCOUNT_ID;
async function runSuiteQL(query) {
    const baseUrl = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
    const url = `${baseUrl}/services/rest/query/v1/suiteql`;
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
        console.error("❌ SuiteQL Error:", err.response?.data || err.message);
        return [];
    }
}
const query = process.argv[2];
if (!query) {
    console.log("Usage: npx tsx netsuite/scratch/query_ns.ts \"SELECT ...\"");
    process.exit(1);
}
runSuiteQL(query).then(results => {
    if (results.length === 0) {
        console.log("No results found.");
    }
    else {
        console.table(results);
    }
    process.exit(0);
});
