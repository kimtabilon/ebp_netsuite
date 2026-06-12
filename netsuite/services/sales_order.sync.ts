import mongoose from "mongoose";
import { getDb } from "../config/mongdodb.config";
import { postToNetsuite, postBatchToNetsuiteForSO } from "./netsuite.client";
import { SYNC_MODE_SO as SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";
import { withConcurrency } from "../config/concurrency.config";
import log from "../config/logger.config";

const PARALLEL_WORKERS = 5;
const BATCH_LIMIT = 500;

/** Serialize RESTlet calls per marketplace order id — avoids NetSuite RCRD_HAS_BEEN_CHANGED when workers hit the same SO. */
const soSyncTailByRef = new Map<string, Promise<unknown>>();

function runSalesOrderNetSuiteSyncSerialized<T>(otherrefnum: string, task: () => Promise<T>): Promise<T> {
    const key = String(otherrefnum);
    const prev = soSyncTailByRef.get(key) ?? Promise.resolve();
    const run = prev.then(() => task());
    soSyncTailByRef.set(key, run.then(() => undefined, () => undefined));
    return run;
}

// ── Actions the RESTlet can return ───────────────────────────────────────────
// "created"        → new SO created with line items          (success)
// "updated"        → existing SO updated with line items     (success)
// "header_updated" → existing SO, SKUs not in NS, only       (success — don't retry)
//                    dates/status patched via submitFields
// "no_items"       → create mode, no valid SKUs found        (success — don't retry)
// "skipped"        → SO already exists, action was "skip"    (success)

// Results we consider fully resolved and should never re-queue
const RESOLVED_RESULTS = ["created", "updated", "header_updated"];

// ═════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═════════════════════════════════════════════════════════════════════════════
export const syncSalesOrdersToNetsuite = async (): Promise<any[]> => {
    log.info(`[NS SO Sync] Starting — mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, stopOnError: ${STOP_ON_ERROR}`);
    return
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    // ── Build filter ─────────────────────────────────────────────────────────
    // update mode: pick up everything not permanently failed and not already
    //              resolved (no_items and header_updated should never retry)
    // skip mode:   pick up only orders that were never synced at all
    const filter = SYNC_MODE === "update"
        ? {
            ns_synced: { $exists: false }
        }
        : {
            ns_synced: { $exists: false }
        };

    console.log("Fileter: ", filter);

    const orders = await collection.find(filter).limit(BATCH_LIMIT).toArray();

    if (orders.length === 0) {
        log.info("[NS SO Sync] No orders to process. Skipping.");
        return [];
    }

    log.info(`[NS SO Sync] Found ${orders.length} orders to process${TEST_MODE ? " (TEST MODE)" : ""}`);

    // Serial mode for TEST_MODE or STOP_ON_ERROR
    if (TEST_MODE || STOP_ON_ERROR) {
        return syncSerial(collection, orders);
    }


    console.log("Order:   ", orders);

    // ── Parallel worker pool ─────────────────────────────────────────────────
    let sent = 0;
    let errors = 0;
    let skipped = 0;
    const results: any[] = [];
    let index = 0;

    async function worker() {
        while (index < orders.length) {
            const i = index++;
            const order = orders[i];
            const t0 = Date.now();

            const entry = await runSalesOrderNetSuiteSyncSerialized(order.otherrefnum, () =>
                syncOneOrder(collection, order)
            );
            const elapsed = Date.now() - t0;
            entry.ms = elapsed;
            results[i] = entry;

            const action = entry.action || "";
            if (["no_items", "skipped", "header_updated"].includes(action)) skipped++;
            else if (entry.success === false) errors++;
            else sent++;

            log.info(`[NS SO Sync] ${order.otherrefnum} → ${action || (entry.success ? "ok" : "FAIL")} (${elapsed}ms)`);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(PARALLEL_WORKERS, orders.length) }, () => worker())
    );

    const times = results.filter((r: any) => r?.ms).map((r: any) => r.ms);
    const avg = times.length > 0 ? Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;
    const min = times.length > 0 ? Math.min(...times) : 0;

    log.info(
        `[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}` +
        ` | timing: avg=${avg}ms, min=${min}ms, max=${max}ms`
    );
    return results;
};

// ═════════════════════════════════════════════════════════════════════════════
// PROCESS ONE ORDER
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Same pipeline as GET /sync-so for one staged document: validate → POST SO RESTlet → mark Mongo.
 * @param directNetSuiteCall  true = single `postToNetsuite` (sync-so-one); false = via concurrency slot (batch sync-so)
 */
export async function syncOneOrder(collection: any, order: any, directNetSuiteCall = true): Promise<any> {
    const ref = order.otherrefnum;

    // ── Guard: empty items array caught before RESTlet call ──────────────────
    if (!order.items || order.items.length === 0) {
        await markResolved(collection, order, "no_items", "No items in staged order");
        log.info(`[NS SO Sync] No items in MongoDB record: ${ref}`);
        return { otherrefnum: ref, success: true, action: "no_items", error: "No items in order" };
    }

    // ── Guard: validate required fields ──────────────────────────────────────
    if (!order.store_type) {
        const err = "Missing store_type on order";
        log.error(`[NS SO Sync] Validation failed: ${ref} — ${err}`);
        await markFailed(collection, order, err);
        return { otherrefnum: ref, success: false, error: err };
    }

    const payload = {
        action: SYNC_MODE,
        otherrefnum: ref,
        trandate: order.trandate,
        store_type: order.store_type || "amazon",
        order_status: order.order_status || "",
        fulfillment_channel: order.fulfillment_channel || "",
        ship_date: order.ship_date || null,
        items: order.items,
        shipping_address: order.shipping_address || null,
        // NetSuite RESTlet: emit EBP_SO_* audit steps in Script Execution Log (set false to reduce volume).
        ebp_diagnostic: true,
    };

    // ── Call the RESTlet ─────────────────────────────────────────────────────
    let result: any;
    try {
        if (directNetSuiteCall) {
            result = await postToNetsuite(payload);
        } else {
            result = await withConcurrency(() => postToNetsuite(payload), `SO ${ref}`);
        }
    } catch (callErr: any) {
        // Network / auth / timeout error — mark failed and retry next run
        const errMsg = callErr?.response?.data
            ? JSON.stringify(callErr.response.data)
            : callErr.message;
        log.error(`[NS SO Sync] RESTlet call exception: ${ref} → ${errMsg}`);
        await markFailed(collection, order, errMsg);
        return { otherrefnum: ref, success: false, error: errMsg };
    }

    // ── Route by action ──────────────────────────────────────────────────────

    // created / updated — fully synced with line items
    if (result.success === true && (result.action === "created" || result.action === "updated")) {
        await markResolved(collection, order, result.action);
        log.info(`[NS SO Sync] ${result.action}: ${ref} → NS ID ${result.internalId}`);
        return { otherrefnum: ref, ...result };
    }

    // header_updated — SKUs not in NS, header fields patched, lines untouched
    // Treat as resolved so we stop retrying — the SO is as up-to-date as possible
    if (result.success === true && result.action === "header_updated") {
        await markResolved(collection, order, "header_updated",
            `SKUs not found in NS: ${result.skipped ? result.skipped.join(", ") : "unknown"}`);
        log.info(`[NS SO Sync] Header updated (SKUs not in NS): ${ref}`);
        return { otherrefnum: ref, ...result };
    }

    // no_items — create mode and no SKUs exist in NS; treat as failure for manual SKU check
    if (result.success === true && result.action === "no_items") {
        const errorMsg = `No valid SKUs in NS: ${result.skipped ? result.skipped.join(", ") : result.skus_attempted || "unknown"}`;
        await markFailed(collection, order, errorMsg);
        log.info(`[NS SO Sync] No valid items (create skipped): ${ref} → Treated as FAILURE`);
        return { otherrefnum: ref, success: false, action: "no_items", error: errorMsg };
    }

    // skipped — SO already existed and action was "skip"
    if (result.success === true && result.action === "skipped") {
        await markResolved(collection, order, "skipped");
        log.info(`[NS SO Sync] Skipped (already in NS): ${ref}`);
        return { otherrefnum: ref, ...result };
    }

    // RESTlet returned success:false — check if it's a "False Negative" (order exists but update failed)
    if (result.success === false) {
        const errMsg = result.error || "Unknown RESTlet error";
        const recoveryId = result.existingId || result.internalId;

        if (recoveryId) {
            log.warn(`[NS SO Sync] Update failed for ${ref}, but order exists in NetSuite (ID: ${recoveryId}). Marking as SYNCED with warning.`);
            await markResolved(collection, order, "updated_with_errors", `Order exists in NetSuite but update failed: ${errMsg}`);
            return { otherrefnum: ref, success: true, action: "updated_with_errors", internalId: recoveryId, error: errMsg };
        }

        log.error(`[NS SO Sync] Failed: ${ref} → ${errMsg}`);
        await markFailed(collection, order, errMsg);
        return { otherrefnum: ref, success: false, error: errMsg };
    }

    // Unexpected response shape — log and mark failed
    const unexpected = `Unexpected RESTlet response: ${JSON.stringify(result)}`;
    log.error(`[NS SO Sync] Unexpected: ${ref} → ${unexpected}`);
    await markFailed(collection, order, unexpected);
    return { otherrefnum: ref, success: false, error: unexpected };
}

/** Staged rows in `suite_sales_order` for inspection / pick list. */
export async function getAllStagedSalesOrderProducts(options?: {
    limit?: number;
    skip?: number;
    all?: boolean;
}): Promise<{ count: number; skip: number; limit: number | "none"; products: any[] }> {
    const skip = Math.max(Number(options?.skip) || 0, 0);
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    let cursor = collection.find({}).skip(skip);
    let limit: number | "none" = "none";
    if (!options?.all) {
        const cap = Math.min(Math.max(Number(options?.limit) || 25_000, 1), 500_000);
        limit = cap;
        cursor = cursor.limit(cap);
    }

    const products = await cursor.toArray();
    return { count: products.length, skip, limit, products };
}

function parseBodyObjectId(id: unknown): mongoose.Types.ObjectId | null {
    if (id == null || id === "") return null;
    if (id instanceof mongoose.Types.ObjectId) return id;
    try {
        return new mongoose.Types.ObjectId(String(id));
    } catch {
        return null;
    }
}

/**
 * Same as one loop iteration in `syncSalesOrdersToNetsuite`: `syncOneOrder(collection, order, true)`.
 *
 * • **Preferred:** POST the **entire** document from `GET /staged-so-products` (same shape as `find()`). That JSON is
 *   used as `order` verbatim; only `_id` is normalized from string → ObjectId so Mongo updates work.
 * • **Optional:** If `_id` is omitted, loads one row by `otherrefnum` + optional `order_source` (same as a single-match find).
 */
export async function syncSingleSalesOrderToNetsuite(body: any): Promise<any> {
    if (!body || typeof body !== "object" || !body.otherrefnum) {
        return { success: false, error: "Body must include otherrefnum." };
    }

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    const oid = parseBodyObjectId(body._id);
    let order: any;

    if (oid) {
        order = { ...body, _id: oid };
    } else {
        const ref = String(body.otherrefnum);
        let fromDb: any = null;
        if (body.order_source) {
            fromDb = await collection.findOne({ otherrefnum: ref, order_source: body.order_source });
        } else {
            const matches = await collection.find({ otherrefnum: ref }).toArray();
            if (matches.length === 1) fromDb = matches[0];
            else if (matches.length > 1) {
                return {
                    success: false,
                    error: `Multiple staged orders for otherrefnum "${ref}" — send full doc with _id, or include order_source.`,
                    candidates: matches.map((m: any) => m.order_source),
                };
            }
        }
        if (!fromDb) {
            return { success: false, error: `No staged order found for otherrefnum "${ref}".` };
        }
        order = fromDb;
    }

    return syncOneOrder(collection, order, true);
}

/**
 * Clear sync failure flags on one staged row so GET /sync-so or POST /sync-so-one can pick it up again.
 */
export async function resetOneStagedSalesOrderForResync(body: {
    otherrefnum: string;
    order_source?: string;
}): Promise<{ success: boolean; error?: string; candidates?: string[]; matched?: number; modified?: number }> {
    if (!body?.otherrefnum) {
        return { success: false, error: "Body must include otherrefnum" };
    }

    const ns_db = await getDb("netsuite");
    const col = ns_db.collection("suite_sales_order");
    const ref = String(body.otherrefnum);

    let filter: Record<string, unknown>;
    if (body.order_source) {
        filter = { otherrefnum: ref, order_source: body.order_source };
    } else {
        const matches = await col.find({ otherrefnum: ref }).toArray();
        if (matches.length === 0) {
            return { success: false, error: `No staged order found for otherrefnum "${ref}".` };
        }
        if (matches.length > 1) {
            return {
                success: false,
                error: `Multiple staged orders for otherrefnum "${ref}" — include order_source.`,
                candidates: matches.map((m: any) => m.order_source),
            };
        }
        filter = { otherrefnum: ref };
    }

    const r = await col.updateOne(filter, {
        $set: { ns_synced: false },
        $unset: {
            ns_error: "",
            ns_error_at: "",
            ns_retry_count: "",
            ns_failed: "",
            ns_result: "",
            ns_note: "",
            ns_note_at: "",
            ns_synced_at: "",
        },
    });

    if (r.matchedCount === 0) {
        return { success: false, error: `No staged order matched for otherrefnum "${ref}".` };
    }

    return { success: true, matched: r.matchedCount, modified: r.modifiedCount };
}

// ═════════════════════════════════════════════════════════════════════════════
// DATABASE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mark an order as fully resolved (created, updated, header_updated, no_items, skipped).
 * Clears all error / retry fields.
 * Optionally stores a note (used for no_items and header_updated to explain why).
 */
async function markResolved(
    collection: any,
    order: any,
    action: string,
    note?: string
) {
    const setFields: any = {
        ns_synced: true,
        ns_synced_at: new Date(),
        ns_result: action,
    };

    // Preserve a human-readable note for non-full-sync outcomes
    if (note) {
        setFields.ns_note = note;
        setFields.ns_note_at = new Date();
    }

    await collection.updateOne(
        { _id: order._id },
        {
            $set: setFields,
            $unset: {
                ns_error: "",
                ns_error_at: "",
                ns_retry_count: "",
                ns_failed: "",
            }
        }
    );
}

/**
 * Mark an order as failed and increment the retry counter.
 * After MAX_RETRIES, sets ns_failed: true to stop automatic retries.
 */
async function markFailed(collection: any, order: any, error: any) {
    const retryCount = (order.ns_retry_count || 0) + 1;
    // You can adjust MAX_RETRIES in config. currently it marks as failed immediately if permanentlyFailed is true
    const permanentlyFailed = retryCount >= MAX_RETRIES;

    const setFields: any = {
        ns_synced: false,
        ns_error: typeof error === "string" ? error : JSON.stringify(error),
        ns_error_at: new Date(),
        ns_retry_count: retryCount,
    };

    if (permanentlyFailed) {
        setFields.ns_failed = true;
        log.error(
            `[NS SO Sync] ${order.otherrefnum} exceeded ${MAX_RETRIES} retries — permanently failed.`
        );
    }

    await collection.updateOne(
        { _id: order._id },
        {
            $set: setFields,
            $unset: {
                ns_result: "",
                ns_note: "",
                ns_note_at: "",
                ns_synced_at: "",
            }
        }
    );
}

// ═════════════════════════════════════════════════════════════════════════════
// SERIAL FALLBACK (TEST_MODE / STOP_ON_ERROR)
// ═════════════════════════════════════════════════════════════════════════════
async function syncSerial(collection: any, orders: any[]): Promise<any[]> {
    let sent = 0, errors = 0, skipped = 0;
    const results: any[] = [];

    for (const order of orders) {
        const entry = await runSalesOrderNetSuiteSyncSerialized(order.otherrefnum, () =>
            syncOneOrder(collection, order)
        );
        results.push(entry);

        const action = entry.action || "";

        if (["no_items", "skipped", "header_updated"].includes(action)) {
            skipped++;
            continue;
        }

        if (entry.success === false) {
            errors++;
            if (STOP_ON_ERROR) {
                log.error("[NS SO Sync] STOP_ON_ERROR — halting after first failure.");
                break;
            }
            continue;
        }

        sent++;
        if (TEST_MODE) {
            log.info("[NS SO Sync] TEST_MODE — stopping after first success.");
            break;
        }
    }

    log.info(
        `[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`
    );
    return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// RETRY HELPERS
// ═════════════════════════════════════════════════════════════════════════════

export const retryFailedSalesOrders = async (
    resetAll = false,
    resetNoItems = false
): Promise<any> => {
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    // Build the filter
    const conditions: any[] = [];

    // Always include orders that failed with an error
    conditions.push({ ns_synced: false, ns_error: { $exists: true } });

    if (resetAll) {
        // Also include permanently failed orders
        conditions.push({ ns_failed: true });
    }

    if (resetNoItems) {
        // Also reset orders that were resolved as no_items or header_updated
        // (useful if SKUs have since been added to NetSuite)
        conditions.push({ ns_result: { $in: ["no_items", "header_updated"] } });
    }

    const filter = conditions.length === 1 ? conditions[0] : { $or: conditions };

    const failedOrders = await collection.find(filter).toArray();

    if (failedOrders.length === 0) {
        return { message: "No orders to reset.", count: 0 };
    }

    const result = await collection.updateMany(
        { _id: { $in: failedOrders.map((o: any) => o._id) } },
        {
            $set: { ns_synced: false },
            $unset: {
                ns_error: "",
                ns_error_at: "",
                ns_retry_count: "",
                ns_failed: "",
                ns_result: "",
                ns_note: "",
                ns_note_at: "",
            }
        }
    );

    const orderList = failedOrders.map((o: any) => ({
        otherrefnum: o.otherrefnum,
        previousResult: o.ns_result || null,
        previousError: o.ns_error || null,
        retryCount: o.ns_retry_count || 0,
    }));

    log.info(`[NS SO Sync] Reset ${result.modifiedCount} orders for retry.`);
    return {
        message: `Reset ${result.modifiedCount} orders for retry.`,
        count: result.modifiedCount,
        orders: orderList,
    };
};

/**
 * Convenience: reset only no_items and header_updated orders.
 * Use this after adding new SKUs to NetSuite so those orders get re-attempted.
 */
export const retryUnmappedSalesOrders = async (): Promise<any> => {
    return retryFailedSalesOrders(false, true);
};

// ═════════════════════════════════════════════════════════════════════════════
// DUMMY SYNC 
// ═════════════════════════════════════════════════════════════════════════════

export const syncDummySalesOrdersToNetsuite = async (): Promise<any[]> => {
    log.info(`[NS SO Sync Dummy] Starting — mode: ${SYNC_MODE}, concurrency: dynamic via withConcurrency`);

    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    const filter = { $or: [{ ns_synced: { $exists: false, } }] };


    const totalToProcess = await collection.countDocuments(filter);
    log.info(`[NS SO Sync Dummy] Found ${totalToProcess} dummy orders to process${TEST_MODE ? " (TEST MODE)" : ""}`);

    if (totalToProcess === 0) {
        log.info("[NS SO Sync Dummy] No orders to process. Skipping.");
        return [];
    }

    const orders = await collection.find(filter).toArray();

    let sent = 0;
    let errors = 0;
    let skipped = 0;
    let processedCount = 0;
    const results: any[] = [];
    let index = 0;

    // Parallel worker logic using a materialized array to avoid cursor/session reuse.
    const workers = Array.from({ length: Math.min(5, orders.length) }, async () => {
        while (true) {
            const i = index++;
            if (i >= orders.length) break;
            const order = orders[i];

            processedCount++;
            const t0 = Date.now();

            if (processedCount % 100 === 0 || processedCount === 1) {
                log.info(`[NS SO Sync Dummy] Progress: ${processedCount}/${totalToProcess} (${Math.round((processedCount / totalToProcess) * 100)}%)`);
            }

            // directNetSuiteCall = false ensures we use withConcurrency slots
            const entry = await runSalesOrderNetSuiteSyncSerialized(order.otherrefnum, () =>
                syncOneOrder(collection, order, false)
            );

            const elapsed = Date.now() - t0;
            entry.ms = elapsed;
            results.push(entry);

            const action = entry.action || "";
            if (["no_items", "skipped", "header_updated"].includes(action)) skipped++;
            else if (entry.success === false) errors++;
            else sent++;

            if (TEST_MODE && sent >= 1) {
                log.info("[NS SO Sync Dummy] TEST_MODE — stopping after first success.");
                break;
            }
            if (STOP_ON_ERROR && entry.success === false) {
                log.error("[NS SO Sync Dummy] STOP_ON_ERROR — halting after failure.");
                break;
            }
        }
    });

    await Promise.all(workers);

    const times = results.filter((r: any) => r?.ms).map((r: any) => r.ms);
    const avg = times.length > 0 ? Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length) : 0;
    const max = times.length > 0 ? Math.max(...times) : 0;
    const min = times.length > 0 ? Math.min(...times) : 0;

    log.info(
        `[NS SO Sync Dummy] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${totalToProcess}` +
        ` | timing: avg=${avg}ms, min=${min}ms, max=${max}ms`
    );
    return results;
};