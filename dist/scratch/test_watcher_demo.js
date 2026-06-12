"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const mongdodb_config_1 = require("../config/mongdodb.config");
const mongo_watcher_service_1 = require("../services/mongo_watcher.service");
const logger_config_1 = __importDefault(require("../config/logger.config"));
async function runWatcherDemo() {
    const db = await (0, mongdodb_config_1.getDb)("netsuite");
    const sourceCol = db.collection("watcher_test_source");
    const destCol = db.collection("watcher_test_destination");
    logger_config_1.default.info("🧪 [DEMO] Starting Watcher on 'watcher_test_source'...");
    // 1. Initialize the Watcher
    await (0, mongo_watcher_service_1.createMongoWatcher)("netsuite", "watcher_test_source", async (id, doc) => {
        logger_config_1.default.info(`✨ [DEMO] Watcher caught change! Copying ID ${id} to destination...`);
        // Manipulation: Let's add a "synced_at" timestamp and a "modified" tag
        const manipulatedData = {
            ...doc,
            synced_at: new Date(),
            processed_by: "RealTimeWatcher"
        };
        await destCol.updateOne({ _id: id }, { $set: manipulatedData }, { upsert: true });
        logger_config_1.default.info(`✅ [DEMO] Successfully mirrored ID ${id} to 'watcher_test_destination'.`);
    });
    logger_config_1.default.info("🚀 Watcher is LIVE. I will now insert a test document in 3 seconds...");
    // 2. Automated Test Insert
    setTimeout(async () => {
        logger_config_1.default.info("📝 Inserting test record into 'watcher_test_source'...");
        await sourceCol.insertOne({
            name: "Test Record #1",
            description: "If this works, it will appear in the destination instantly!",
            timestamp: new Date()
        });
    }, 3000);
}
runWatcherDemo().catch(err => {
    console.error(err);
});
