import mongoose, { Connection } from "mongoose";

let baseConnection: Connection | null = null;
/** Single in-flight connect so parallel getDb() / ensureIndexes() share one mongoose.connect(). */
let connectPromise: Promise<Connection> | null = null;

function mongoClientOptions() {
  // Driver default serverSelectionTimeoutMS is 2000 — too aggressive for remote DBs or cold starts.
  const serverSelectionTimeoutMS = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 30_000;
  const connectTimeoutMS = Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 30_000;
  return { serverSelectionTimeoutMS, connectTimeoutMS };
}

export async function connectMongoBase(): Promise<Connection> {
  if (baseConnection) return baseConnection;

  if (!connectPromise) {
    const user = encodeURIComponent(process.env.MONGO_USER || process.env.mUser || "");
    const pass = encodeURIComponent(process.env.MONGO_PASS || process.env.pUser || "");
    const host = process.env.MONGO_HOST || "64.225.124.70";
    const port = process.env.MONGO_PORT || "27017";
    const uri = process.env.MONGO_URI || `mongodb://${user}:${pass}@${host}:${port}/?authSource=admin`;

    connectPromise = mongoose
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
export async function getDb(dbName: string) {
  const baseConn = await connectMongoBase();

  const conn = baseConn.useDb(dbName, { useCache: true });

  if (!conn.db) throw new Error("Mongo DB not ready");
  return conn.db; // inferred type from mongoose's mongodb
}