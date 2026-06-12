"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMongoWatcher = createMongoWatcher;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
/**
 * A reusable Real-Time Watcher for any MongoDB collection.
 * @param dbName Name of the database
 * @param collectionName Name of the collection to watch
 * @param onSync Function to run when a record is created or updated
 * @param onDelete (Optional) Function to run when a record is deleted
 */
async function createMongoWatcher(dbName, collectionName, onSync, onDelete) {
    try {
        const db = await (0, mongdodb_config_1.getDb)(dbName);
        const collection = db.collection(collectionName);
        logger_config_1.default.info(`👀 [Watcher] Starting listener for ${dbName}.${collectionName}...`);
        // Open a change stream
        const changeStream = collection.watch([], { fullDocument: 'updateLookup' });
        changeStream.on('change', async (change) => {
            const op = change.operationType;
            const docId = change.documentKey._id;
            try {
                if (op === 'insert' || op === 'update' || op === 'replace') {
                    logger_config_1.default.info(`⚡ [Watcher] ${collectionName} detected ${op.toUpperCase()}: ${docId}`);
                    await onSync(docId, change.fullDocument);
                }
                else if (op === 'delete' && onDelete) {
                    logger_config_1.default.info(`🗑️ [Watcher] ${collectionName} detected DELETE: ${docId}`);
                    await onDelete(docId);
                }
            }
            catch (err) {
                logger_config_1.default.error(`❌ [Watcher] Error processing ${op} for ${docId}: ${err.message}`);
            }
        });
        changeStream.on('error', (err) => {
            logger_config_1.default.error(`🔥 [Watcher] Stream error in ${collectionName}: ${err.message}. Restarting in 5s...`);
            setTimeout(() => createMongoWatcher(dbName, collectionName, onSync, onDelete), 5000);
        });
    }
    catch (err) {
        logger_config_1.default.error(`CRITICAL: Failed to start watcher for ${collectionName}: ${err.message}`);
    }
}
