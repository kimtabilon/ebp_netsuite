"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
async function updateClassificationSubsidiaries() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const collection = db.collection("ns_rest_classification_detail_dump_dummy");
    const filter = {
        "payload.subsidiary.items": {
            "$not": {
                "$elemMatch": {
                    "refName": "Parent Company : eCommerce Business Prime"
                }
            }
        }
    };
    const newSubsidiary = {
        "id": "2",
        "refName": "Parent Company : eCommerce Business Prime"
    };
    logger_config_1.default.info("🚀 Starting update for 171 classification records...");
    // We use $addToSet so we don't accidentally add it twice if the filter was slightly off
    const result = await collection.updateMany(filter, {
        $addToSet: {
            "payload.subsidiary.items": newSubsidiary
        }
    });
    logger_config_1.default.info(`✅ Update complete!`);
    logger_config_1.default.info(`📦 Matched: ${result.matchedCount}`);
    logger_config_1.default.info(`📝 Modified: ${result.modifiedCount}`);
    logger_config_1.default.info("\n=== DONE ===\n");
}
updateClassificationSubsidiaries().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
