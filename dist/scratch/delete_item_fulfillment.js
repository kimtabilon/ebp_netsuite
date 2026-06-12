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
// Get ID from command line argument
const IF_ID = process.argv[2];
async function deleteItemFulfillment(id) {
    if (!id) {
        logger_config_1.default.error("❌ Please provide an Item Fulfillment internal ID. Example: npx tsx netsuite/scratch/delete_item_fulfillment.ts 12345");
        return;
    }
    const url = `${BASE_URL}/services/rest/record/v1/itemFulfillment/${id}`;
    logger_config_1.default.info(`🗑️ Attempting to delete Item Fulfillment ID: ${id}...`);
    try {
        const res = await axios_1.default.delete(url, {
            headers: {
                Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "DELETE"),
                "Content-Type": "application/json"
            }
        });
        if (res.status === 204 || res.status === 200) {
            logger_config_1.default.info(`✅ Successfully deleted Item Fulfillment: ${id}`);
        }
        else {
            logger_config_1.default.warn(`❓ Received unexpected status code: ${res.status}`);
        }
    }
    catch (err) {
        const detail = err.response?.data?.detail || err.message;
        logger_config_1.default.error(`❌ Failed to delete IF ${id}: ${detail}`);
        if (err.response?.status === 404) {
            logger_config_1.default.error("💡 Reason: This ID does not exist or is not an Item Fulfillment.");
        }
    }
}
deleteItemFulfillment(IF_ID).then(() => process.exit(0));
