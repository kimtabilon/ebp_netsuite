"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testNetsuiteAuth = exports.callCleanup = exports.callDiagnostic = exports.postToNetsuiteForIF = exports.postToNetsuiteForCreditMemo = exports.postToNetsuiteForBill = exports.postBatchToNetsuiteForPO = exports.postToNetsuiteForPO = exports.postBatchToNetsuiteForSO = exports.postToNetsuite = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const oauth_1_0a_1 = __importDefault(require("oauth-1.0a"));
const logger_config_1 = __importDefault(require("../config/logger.config"));
// e.g. 9511322_SB1 → 9511322-sb1.restlets.api.netsuite.com
const buildRestletUrl = (scriptId, deployId) => {
    const accountId = process.env.NS_ACCOUNT_ID;
    if (!accountId)
        throw new Error("NS_ACCOUNT_ID is not set in .env");
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    return `https://${accountUrl}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deployId}`;
    // return "https://9511322.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscriptebp_sales_order_sync&deploy=customdeploy4";
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
    const batchSize = 10;
    const token = {
        key: process.env.NS_TOKEN_ID,
        secret: process.env.NS_TOKEN_SECRET
    };
    const authData = oauth.authorize({ url, method, data: {} }, token);
    return oauth.toHeader(authData).Authorization;
};
const RESTLET_TIMEOUT_MS = 120000; // 120s — increased to handle large batches of record updates
const post = async (scriptId, deployId, payload) => {
    console.log("scriptId", scriptId);
    console.log("deployId", deployId);
    const url = buildRestletUrl(scriptId, deployId);
    logger_config_1.default.info(`[NS Client] POST → ${url}`);
    const authHeader = buildOAuthHeader(url, "POST");
    try {
        const response = await axios_1.default.post(url, payload, {
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json"
            },
            timeout: RESTLET_TIMEOUT_MS,
        });
        const data = response.data;
        if (data && data.success === false) {
            const detail = typeof data === "object"
                ? JSON.stringify(data)
                : String(data);
            logger_config_1.default.warn(`[NS Client] RESTlet success:false → ${detail.slice(0, 8000)}${detail.length > 8000 ? "…(truncated)" : ""}`);
        }
        else {
            logger_config_1.default.debug("[NS Client] Response", {
                action: data?.action,
                success: data?.success,
                itemCount: data?.fetch_items_fast?.count,
            });
        }
        return data;
    }
    catch (err) {
        const status = err.response?.status;
        const body = err.response?.data;
        const msg = typeof body === "string" ? body : JSON.stringify(body || err.message);
        // NetSuite concurrency limit hit — 429 or SSS_REQUEST_LIMIT_EXCEEDED
        if (status === 429 || msg.includes("SSS_REQUEST_LIMIT_EXCEEDED") || msg.includes("concurrent request")) {
            logger_config_1.default.error(`[NS Client] ⚠️ CONCURRENCY LIMIT HIT — NetSuite rejected the request (HTTP ${status}). Reduce NS_MAX_CONCURRENT or batch sizes.`, { url, error: msg });
        }
        throw err;
    }
};
// Sales Order restlet
const postToNetsuite = (payload) => post(process.env.RESTLET_SCRIPT_ID, process.env.RESTLET_DEPLOY_ID, payload);
exports.postToNetsuite = postToNetsuite;
// Sales Order restlet — batch mode (multiple SOs in one invocation)
const postBatchToNetsuiteForSO = async (payloads) => {
    const url = buildRestletUrl(process.env.RESTLET_SCRIPT_ID, process.env.RESTLET_DEPLOY_ID);
    const authHeader = buildOAuthHeader(url, "POST");
    logger_config_1.default.info(`[NS Client] BATCH POST SO → ${url} (${payloads.length} SOs)`);
    try {
        const response = await axios_1.default.post(url, { batch: payloads }, {
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            timeout: 180000,
        });
        return response.data;
    }
    catch (err) {
        logger_config_1.default.error(`[NS Client] Batch SO call failed`, { url, error: err.message });
        const status = err.response?.status;
        const body = err.response?.data;
        const msg = typeof body === "string" ? body : JSON.stringify(body || err.message);
        if (status === 429 || msg.includes("SSS_REQUEST_LIMIT_EXCEEDED") || msg.includes("concurrent request")) {
            logger_config_1.default.error(`[NS Client] ⚠️ CONCURRENCY LIMIT HIT on batch call (HTTP ${status})`, { url, error: msg });
        }
        throw err;
    }
};
exports.postBatchToNetsuiteForSO = postBatchToNetsuiteForSO;
// Purchase Order restlet
const postToNetsuiteForPO = (payload) => post(process.env.RESTLET_PO_SCRIPT_ID, process.env.RESTLET_PO_DEPLOY_ID, payload);
exports.postToNetsuiteForPO = postToNetsuiteForPO;
// Purchase Order restlet — batch mode (multiple POs in one invocation)
const postBatchToNetsuiteForPO = async (payloads) => {
    const url = buildRestletUrl(process.env.RESTLET_PO_SCRIPT_ID, process.env.RESTLET_PO_DEPLOY_ID);
    const authHeader = buildOAuthHeader(url, "POST");
    logger_config_1.default.info(`[NS Client] BATCH POST → ${url} (${payloads.length} POs)`);
    logger_config_1.default.info(`   (${JSON.stringify(payloads)} )`);
    try {
        const response = await axios_1.default.post(url, { batch: payloads }, {
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
            timeout: 180000, // 3 min — batch calls take longer
        });
        // log.debug(`[NS Client] Batch call response`, response.data);
        return response.data;
    }
    catch (err) {
        logger_config_1.default.error(`[NS Client] Batch call failed`, { url, error: err.message });
        const status = err.response?.status;
        const body = err.response?.data;
        const msg = typeof body === "string" ? body : JSON.stringify(body || err.message);
        if (status === 429 || msg.includes("SSS_REQUEST_LIMIT_EXCEEDED") || msg.includes("concurrent request")) {
            logger_config_1.default.error(`[NS Client] ⚠️ CONCURRENCY LIMIT HIT on batch call (HTTP ${status})`, { url, error: msg });
        }
        throw err;
    }
};
exports.postBatchToNetsuiteForPO = postBatchToNetsuiteForPO;
// Vendor Bill restlet
const postToNetsuiteForBill = (payload) => post(process.env.RESTLET_BILL_SCRIPT_ID, process.env.RESTLET_BILL_DEPLOY_ID, payload);
exports.postToNetsuiteForBill = postToNetsuiteForBill;
// Vendor Credit restlet
const postToNetsuiteForCreditMemo = (payload) => post(process.env.RESTLET_CREDIT_SCRIPT_ID, process.env.RESTLET_CREDIT_DEPLOY_ID, payload);
exports.postToNetsuiteForCreditMemo = postToNetsuiteForCreditMemo;
// Item Fulfillment restlet
const postToNetsuiteForIF = (payload) => {
    logger_config_1.default.error("payload >>>", payload);
    return post(process.env.RESTLET_IF_SCRIPT_ID, process.env.RESTLET_IF_DEPLOY_ID, payload);
};
exports.postToNetsuiteForIF = postToNetsuiteForIF;
// Diagnostic RESTlet — call with sections to inspect account config
const callDiagnostic = async (payload) => {
    const scriptId = process.env.RESTLET_DIAG_SCRIPT_ID;
    const deployId = process.env.RESTLET_DIAG_DEPLOY_ID;
    if (!scriptId || !deployId) {
        logger_config_1.default.error("[DIAG] Missing RESTLET_DIAG_SCRIPT_ID or RESTLET_DIAG_DEPLOY_ID in .env");
        return null;
    }
    return post(scriptId, deployId, payload);
};
exports.callDiagnostic = callDiagnostic;
// Cleanup RESTlet — lightweight script for deleting POs and test SOs
const callCleanup = async (payload) => {
    const scriptId = process.env.RESTLET_CLEANUP_SCRIPT_ID;
    const deployId = process.env.RESTLET_CLEANUP_DEPLOY_ID;
    if (!scriptId || !deployId) {
        logger_config_1.default.error("[CLEANUP] Missing RESTLET_CLEANUP_SCRIPT_ID or RESTLET_CLEANUP_DEPLOY_ID in .env");
        return null;
    }
    return post(scriptId, deployId, payload);
};
exports.callCleanup = callCleanup;
// Auth test — sends a minimal ping to the SO restlet
const testNetsuiteAuth = async () => {
    try {
        const scriptId = process.env.RESTLET_SCRIPT_ID;
        const deployId = process.env.RESTLET_DEPLOY_ID;
        const url = buildRestletUrl(scriptId, deployId);
        logger_config_1.default.info(`[AUTH] Testing OAuth → ${url}`);
        const authHeader = buildOAuthHeader(url, "POST");
        const response = await axios_1.default.post(url, { action: "ping" }, {
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json"
            },
            timeout: RESTLET_TIMEOUT_MS,
        });
        logger_config_1.default.info("[AUTH] SUCCESS — NetSuite responded", { data: response.data });
    }
    catch (err) {
        const data = err.response?.data || err.message;
        logger_config_1.default.error("[AUTH] FAILED", { data });
    }
};
exports.testNetsuiteAuth = testNetsuiteAuth;
