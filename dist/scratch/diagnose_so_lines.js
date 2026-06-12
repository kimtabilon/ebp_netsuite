"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
const oauth_1_0a_1 = __importDefault(require("oauth-1.0a"));
require("dotenv/config");
const buildRestletUrl = (scriptId, deployId) => {
    const accountId = process.env.NS_ACCOUNT_ID;
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    return `https://${accountUrl}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;
};
const buildOAuthHeader = (url, method) => {
    const oauth = new oauth_1_0a_1.default({
        consumer: {
            key: process.env.NS_CONSUMER_KEY,
            secret: process.env.NS_CONSUMER_SECRET
        },
        signature_method: "HMAC-SHA256",
        hash_function(baseString, key) {
            return crypto_1.default.createHmac("sha256", key).update(baseString).digest("base64");
        },
        realm: process.env.NS_ACCOUNT_ID
    });
    const token = {
        key: process.env.NS_TOKEN_ID,
        secret: process.env.NS_TOKEN_SECRET
    };
    const authData = oauth.authorize({ url, method, data: {} }, token);
    return oauth.toHeader(authData).Authorization;
};
async function run() {
    try {
        console.log("Diagnosing SO 73367 line-level database values via SuiteQL...");
        // We will call the RESTlet and send a special diagnostic query, or use our SuiteQL runner if available.
        // Let's use the RESTlet's standard URL but we can query it using a run_suiteql script.
        // Wait, is there a suiteql runner in scratch? Let's check run_suiteql.ts.
    }
    catch (e) {
        console.error("Error:", e.message);
    }
}
