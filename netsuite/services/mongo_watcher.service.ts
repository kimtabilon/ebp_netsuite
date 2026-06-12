import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";

/**
 * A reusable Real-Time Watcher for any MongoDB collection.
 * @param dbName Name of the database
 * @param collectionName Name of the collection to watch
 * @param onSync Function to run when a record is created or updated
 * @param onDelete (Optional) Function to run when a record is deleted
 */
export async function createMongoWatcher(
    dbName: string,
    collectionName: string,
    onSync: (id: any, fullDoc: any) => Promise<void>,
    onDelete?: (id: any) => Promise<void>
) {
    try {
        const db = await getDb(dbName);
        const collection = db.collection(collectionName);

        log.info(`👀 [Watcher] Starting listener for ${dbName}.${collectionName}...`);

        // Open a change stream
        const changeStream = collection.watch([], { fullDocument: 'updateLookup' });

        changeStream.on('change', async (change: any) => {
            const op = change.operationType;
            const docId = change.documentKey._id;

            try {
                if (op === 'insert' || op === 'update' || op === 'replace') {
                    log.info(`⚡ [Watcher] ${collectionName} detected ${op.toUpperCase()}: ${docId}`);
                    await onSync(docId, change.fullDocument);
                } 
                else if (op === 'delete' && onDelete) {
                    log.info(`🗑️ [Watcher] ${collectionName} detected DELETE: ${docId}`);
                    await onDelete(docId);
                }
            } catch (err: any) {
                log.error(`❌ [Watcher] Error processing ${op} for ${docId}: ${err.message}`);
            }
        });

        changeStream.on('error', (err) => {
            log.error(`🔥 [Watcher] Stream error in ${collectionName}: ${err.message}. Restarting in 5s...`);
            setTimeout(() => createMongoWatcher(dbName, collectionName, onSync, onDelete), 5000);
        });

    } catch (err: any) {
        log.error(`CRITICAL: Failed to start watcher for ${collectionName}: ${err.message}`);
    }
}
