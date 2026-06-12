"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectMongoBase = connectMongoBase;
exports.getDb = getDb;
const mongoose_1 = __importDefault(require("mongoose"));
let baseConnection = null;
/** Single in-flight connect so parallel getDb() / ensureIndexes() share one mongoose.connect(). */
let connectPromise = null;
function mongoClientOptions() {
    // Driver default serverSelectionTimeoutMS is 2000 — too aggressive for remote DBs or cold starts.
    const serverSelectionTimeoutMS = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 30000;
    const connectTimeoutMS = Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 30000;
    const socketTimeoutMS = Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 60000;
    const maxPoolSize = Number(process.env.MONGO_MAX_POOL_SIZE) || 50;
    return { serverSelectionTimeoutMS, connectTimeoutMS, socketTimeoutMS, maxPoolSize };
}
async function connectMongoBase() {
    if (baseConnection)
        return baseConnection;
    if (!connectPromise) {
        const user = encodeURIComponent(process.env.MONGO_USER || process.env.mUser || "");
        const pass = encodeURIComponent(process.env.MONGO_PASS || process.env.pUser || "");
        const host = process.env.MONGO_HOST || "64.225.124.70";
        const port = process.env.MONGO_PORT || "27017";
        const uri = process.env.MONGO_URI || `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`;
        connectPromise = mongoose_1.default
            .connect(uri, mongoClientOptions())
            .then((m) => {
            baseConnection = m.connection;
            return baseConnection;
        })
            .catch((err) => {
            baseConnection = null;
            throw err;
        })
            .finally(() => {
            connectPromise = null;
        });
    }
    return connectPromise;
}
// ✅ No "mongodb" import here
async function getDb(dbName) {
    const baseConn = await connectMongoBase();
    const conn = baseConn.useDb(dbName, { useCache: true });
    if (!conn.db)
        throw new Error("Mongo DB not ready");
    return conn.db; // inferred type from mongoose's mongodb
}
