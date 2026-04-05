// import { getDb } from "../config/mongdodb.config";
// import { postToNetsuite } from "./netsuite.client";
// import { SYNC_MODE_SO as SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";
// import { withConcurrency } from "../config/concurrency.config";
// import log from "../config/logger.config";

// const PARALLEL_WORKERS = 5;
// const BATCH_LIMIT = 500;

// export const syncSalesOrdersToNetsuite = async (): Promise<any[]> => {
//     log.info(`[NS SO Sync] Starting — mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, stopOnError: ${STOP_ON_ERROR}`);

//     const ns_db = await getDb("netsuite");
//     const collection = ns_db.collection("suite_sales_order");

//     // const filter = SYNC_MODE === "update"
//     //     ? { ns_failed: { $ne: true } }
//     //     : { ns_synced: { $ne: true }, ns_failed: { $ne: true } };
//     const filter = SYNC_MODE === "update"
//         ? { ns_failed: { $ne: true } }
//         : {
//             ns_synced: { $ne: true },
//             ns_failed: { $ne: true },
//             ns_result: { $ne: "created" } // 🚨 ADD THIS
//         };

//     const orders = await collection.find(filter).limit(BATCH_LIMIT).toArray();

//     if (orders.length === 0) {
//         log.info("[NS SO Sync] No orders to process. Skipping.");
//         return [];
//     }

//     log.info(`[NS SO Sync] Found ${orders.length} orders to process${TEST_MODE ? " (TEST MODE)" : ""}`);

//     // In TEST_MODE or STOP_ON_ERROR, fall back to serial processing
//     if (TEST_MODE || STOP_ON_ERROR) {
//         return syncSerial(collection, orders);
//     }

//     // ── Parallel sync with worker pool ────────────────────────────────────
//     let sent = 0;
//     let errors = 0;
//     let skipped = 0;
//     const results: any[] = [];
//     let index = 0;

//     async function worker() {
//         while (index < orders.length) {
//             const i = index++;
//             const order = orders[i];
//             const t0 = Date.now();
//             const entry = await syncOneOrder(collection, order);
//             const elapsed = Date.now() - t0;
//             entry.ms = elapsed;
//             results[i] = entry;

//             log.info(`[NS SO Sync] ${order.otherrefnum} took ${elapsed}ms`);
//             if (entry.action === "no_items" || entry.action === "skipped") skipped++;
//             else if (entry.success === false) errors++;
//             else sent++;
//         }
//     }

//     await Promise.all(
//         Array.from({ length: Math.min(PARALLEL_WORKERS, orders.length) }, () => worker())
//     );

//     const times = results.filter((r: any) => r?.ms).map((r: any) => r.ms);
//     const avg = times.length > 0 ? Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length) : 0;
//     const max = times.length > 0 ? Math.max(...times) : 0;
//     const min = times.length > 0 ? Math.min(...times) : 0;
//     log.info(`[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length} | timing: avg=${avg}ms, min=${min}ms, max=${max}ms`);
//     return results;
// };

// // ── Process a single order: RESTlet call + MongoDB status update ──────────
// async function syncOneOrder(collection: any, order: any): Promise<any> {
//     try {
//         if (!order.items || order.items.length === 0) {
//             await markNoItems(collection, order, "No items in staged order");
//             return {
//                 otherrefnum: order.otherrefnum,
//                 success: true,
//                 action: "no_items",
//                 error: "No items in order"
//             };
//         }

//         const result = await withConcurrency(() => postToNetsuite({
//             action: SYNC_MODE,
//             otherrefnum: order.otherrefnum,
//             trandate: order.trandate,
//             store_type: order.store_type || "amazon",
//             order_status: order.order_status,
//             fulfillment_channel: order.fulfillment_channel,
//             ship_date: order.ship_date,
//             items: order.items,
//             po: order.po || [],
//             shipping_address: order.shipping_address || null,
//         }), `SO ${order.otherrefnum}`);

//         // ── Handle "no_items" gracefully (this is NOT a failure) ─────────────
//         if (result.action === "no_items") {
//             await markNoItems(collection, order, 
//                 `No valid items found in NetSuite. Skipped SKUs: ${result.skipped ? result.skipped.join(", ") : "unknown"}`);
            
//             log.info(`[NS SO Sync] No valid items: ${order.otherrefnum}`);
//             return { 
//                 otherrefnum: order.otherrefnum, 
//                 success: true, 
//                 action: "no_items" 
//             };
//         }

//         // ── Handle real errors ─────────────────────────────────────────────
//         if (result.success === false) {
//             console.log(`[NS SO Sync] Error syncing ${order}:`, result);
//             log.error(`[NS SO Sync] Failed: ${order.otherrefnum} → ${result.error}`);
//             await markFailed(collection, order, result.error);
//             return { otherrefnum: order.otherrefnum, success: false, error: result.error };
//         }

//         // ── Success case ───────────────────────────────────────────────────
//         await collection.updateOne(
//             { _id: order._id },
//             {
//                 $set: { 
//                     ns_synced: true, 
//                     ns_synced_at: new Date(), 
//                     ns_result: result.action || "created" 
//                 },
//                 $unset: { 
//                     ns_error: "", 
//                     ns_error_at: "", 
//                     ns_retry_count: "", 
//                     ns_failed: "" 
//                 }
//             }
//         );

//         log.info(`[NS SO Sync] Successfully synced: ${order.otherrefnum} → ${result.action}`);
//         return { otherrefnum: order.otherrefnum, ...result };

//     } catch (e: any) {
//         const errMsg = e?.response?.data 
//             ? JSON.stringify(e.response.data) 
//             : e.message;

//         log.error(`[NS SO Sync] Exception for ${order.otherrefnum}:`, errMsg);
//         await markFailed(collection, order, errMsg);
//         return { otherrefnum: order.otherrefnum, success: false, error: errMsg };
//     }
// }


// async function markNoItems(collection: any, order: any, reason: string) {
//     await collection.updateOne(
//         { _id: order._id },
//         {
//             $set: {
//                 ns_synced: true,           // We consider "no_items" as processed
//                 ns_synced_at: new Date(),
//                 ns_result: "no_items",
//                 ns_error: reason,
//                 ns_error_at: new Date(),
//             },
//             $unset: {
//                 ns_failed: "",
//                 ns_retry_count: ""
//             }
//         }
//     );
// }

// // ── Serial fallback for TEST_MODE / STOP_ON_ERROR ─────────────────────────
// async function syncSerial(collection: any, orders: any[]): Promise<any[]> {
//     let sent = 0, errors = 0, skipped = 0;
//     const results: any[] = [];

//     for (const order of orders) {
//         const entry = await syncOneOrder(collection, order);
//         results.push(entry);

//         if (entry.action === "no_items" || entry.action === "skipped") { skipped++; continue; }
//         if (entry.success === false) {
//             errors++;
//             if (STOP_ON_ERROR) { log.error("[NS SO Sync] STOP_ON_ERROR — halting."); break; }
//             continue;
//         }
//         sent++;
//         if (TEST_MODE) { log.info("[NS SO Sync] TEST_MODE — stopping after first."); break; }
//     }

//     log.info(`[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}`);
//     return results;
// }

// // ─── Mark order as failed with retry tracking ────────────────────────────────
// async function markFailed(collection: any, order: any, error: any) {
//     const retryCount = (order.ns_retry_count || 0) + 1;
//     const permanentlyFailed = retryCount >= MAX_RETRIES;

//     const update: any = {
//         $set: {
//             ns_synced: false,
//             ns_error: typeof error === "string" ? error : JSON.stringify(error),
//             ns_error_at: new Date(),
//             ns_retry_count: retryCount,
//         }
//     };

//     if (permanentlyFailed) {
//         update.$set.ns_failed = true;
//         log.error(`[NS SO Sync] Order ${order.otherrefnum} exceeded ${MAX_RETRIES} retries — marked as permanently failed.`);
//     }

//     await collection.updateOne({ _id: order._id }, update);
// }

// // ─── Retry failed orders ─────────────────────────────────────────────────────
// // Resets ns_synced, ns_error, ns_retry_count so they get picked up again.
// // Optionally pass resetAll=true to also reset permanently failed orders.
// export const retryFailedSalesOrders = async (resetAll = false): Promise<any> => {
//     const ns_db = await getDb("netsuite");
//     const collection = ns_db.collection("suite_sales_order");

//     const filter = resetAll
//         ? { $or: [{ ns_synced: false, ns_error: { $exists: true } }, { ns_failed: true }] }
//         : { ns_synced: false, ns_error: { $exists: true }, ns_failed: { $ne: true } };

//     const failedOrders = await collection.find(filter).toArray();

//     if (failedOrders.length === 0) {
//         return { message: "No failed orders to retry.", count: 0 };
//     }

//     const result = await collection.updateMany(
//         { _id: { $in: failedOrders.map((o: any) => o._id) } },
//         {
//             $set: { ns_synced: false },
//             $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
//         }
//     );

//     const orderList = failedOrders.map((o: any) => ({
//         otherrefnum: o.otherrefnum,
//         previousError: o.ns_error,
//         retryCount: o.ns_retry_count || 0
//     }));

//     return {
//         message: `Reset ${result.modifiedCount} failed orders for retry.`,
//         count: result.modifiedCount,
//         orders: orderList
//     };
// };


import { getDb } from "../config/mongdodb.config";
import { postToNetsuite } from "./netsuite.client";
import { SYNC_MODE_SO as SYNC_MODE, TEST_MODE, STOP_ON_ERROR, MAX_RETRIES } from "../config/sync.config";
import { withConcurrency } from "../config/concurrency.config";
import log from "../config/logger.config";

const PARALLEL_WORKERS = 5;
const BATCH_LIMIT      = 500;

// ── Actions the RESTlet can return ───────────────────────────────────────────
// "created"        → new SO created with line items          (success)
// "updated"        → existing SO updated with line items     (success)
// "header_updated" → existing SO, SKUs not in NS, only       (success — don't retry)
//                    dates/status patched via submitFields
// "no_items"       → create mode, no valid SKUs found        (success — don't retry)
// "skipped"        → SO already exists, action was "skip"    (success)

// Results we consider fully resolved and should never re-queue
const RESOLVED_RESULTS = ["created", "updated", "header_updated", "no_items"];

// ═════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═════════════════════════════════════════════════════════════════════════════
export const syncSalesOrdersToNetsuite = async (): Promise<any[]> => {
    log.info(`[NS SO Sync] Starting — mode: ${SYNC_MODE}, workers: ${PARALLEL_WORKERS}, stopOnError: ${STOP_ON_ERROR}`);

    const ns_db      = await getDb("netsuite");
    const collection = ns_db.collection("suite_sales_order");

    // ── Build filter ─────────────────────────────────────────────────────────
    // update mode: pick up everything not permanently failed and not already
    //              resolved (no_items and header_updated should never retry)
    // skip mode:   pick up only orders that were never synced at all
    const filter = SYNC_MODE === "update"
        ? {
            ns_failed:  { $ne: true },
            ns_result:  { $nin: RESOLVED_RESULTS }   // don't re-queue resolved orders
          }
        : {
            ns_synced:  { $ne: true },
            ns_failed:  { $ne: true },
            ns_result:  { $nin: RESOLVED_RESULTS }
          };

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

    // ── Parallel worker pool ─────────────────────────────────────────────────
    let sent    = 0;
    let errors  = 0;
    let skipped = 0;
    const results: any[] = [];
    let index = 0;

    async function worker() {
        while (index < orders.length) {
            const i     = index++;
            const order = orders[i];
            const t0    = Date.now();

            const entry  = await syncOneOrder(collection, order);
            const elapsed = Date.now() - t0;
            entry.ms      = elapsed;
            results[i]    = entry;

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
    const avg   = times.length > 0 ? Math.round(times.reduce((a: number, b: number) => a + b, 0) / times.length) : 0;
    const max   = times.length > 0 ? Math.max(...times) : 0;
    const min   = times.length > 0 ? Math.min(...times) : 0;

    log.info(
        `[NS SO Sync] Done — sent: ${sent}, skipped: ${skipped}, errors: ${errors}, total: ${orders.length}` +
        ` | timing: avg=${avg}ms, min=${min}ms, max=${max}ms`
    );
    return results;
};

// ═════════════════════════════════════════════════════════════════════════════
// PROCESS ONE ORDER
// ═════════════════════════════════════════════════════════════════════════════
async function syncOneOrder(collection: any, order: any): Promise<any> {
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

    // ── Call the RESTlet ─────────────────────────────────────────────────────
    let result: any;
    try {
        result = await withConcurrency(() => postToNetsuite({
            action:              SYNC_MODE,
            otherrefnum:         ref,
            trandate:            order.trandate,
            store_type:          order.store_type || "amazon",
            order_status:        order.order_status        || "",
            fulfillment_channel: order.fulfillment_channel || "",
            ship_date:           order.ship_date           || null,
            items:               order.items,
            shipping_address:    order.shipping_address    || null,
        }), `SO ${ref}`);
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

    // no_items — create mode and no SKUs exist in NS; don't create empty SO
    if (result.success === true && result.action === "no_items") {
        await markResolved(collection, order, "no_items",
            `No valid SKUs in NS: ${result.skipped ? result.skipped.join(", ") : result.skus_attempted || "unknown"}`);
        log.info(`[NS SO Sync] No valid items (create skipped): ${ref}`);
        return { otherrefnum: ref, success: true, action: "no_items" };
    }

    // skipped — SO already existed and action was "skip"
    if (result.success === true && result.action === "skipped") {
        await markResolved(collection, order, "skipped");
        log.info(`[NS SO Sync] Skipped (already in NS): ${ref}`);
        return { otherrefnum: ref, ...result };
    }

    // RESTlet returned success:false — real error, mark failed for retry
    if (result.success === false) {
        const errMsg = result.error || "Unknown RESTlet error";
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
        ns_synced:    true,
        ns_synced_at: new Date(),
        ns_result:    action,
    };

    // Preserve a human-readable note for non-full-sync outcomes
    if (note) {
        setFields.ns_note     = note;
        setFields.ns_note_at  = new Date();
    }

    await collection.updateOne(
        { _id: order._id },
        {
            $set:   setFields,
            $unset: {
                ns_error:       "",
                ns_error_at:    "",
                ns_retry_count: "",
                ns_failed:      "",
            }
        }
    );
}

/**
 * Mark an order as failed and increment the retry counter.
 * After MAX_RETRIES, sets ns_failed: true to stop automatic retries.
 */
async function markFailed(collection: any, order: any, error: any) {
    const retryCount       = (order.ns_retry_count || 0) + 1;
    const permanentlyFailed = retryCount >= MAX_RETRIES;

    const setFields: any = {
        ns_synced:      false,
        ns_error:       typeof error === "string" ? error : JSON.stringify(error),
        ns_error_at:    new Date(),
        ns_retry_count: retryCount,
    };

    if (permanentlyFailed) {
        setFields.ns_failed = true;
        log.error(
            `[NS SO Sync] ${order.otherrefnum} exceeded ${MAX_RETRIES} retries — permanently failed.`
        );
    }

    await collection.updateOne({ _id: order._id }, { $set: setFields });
}

// ═════════════════════════════════════════════════════════════════════════════
// SERIAL FALLBACK (TEST_MODE / STOP_ON_ERROR)
// ═════════════════════════════════════════════════════════════════════════════
async function syncSerial(collection: any, orders: any[]): Promise<any[]> {
    let sent = 0, errors = 0, skipped = 0;
    const results: any[] = [];

    for (const order of orders) {
        const entry = await syncOneOrder(collection, order);
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

/**
 * Reset failed orders so they get picked up on the next sync run.
 *
 * resetAll = false  →  only non-permanently-failed orders (ns_failed not set)
 * resetAll = true   →  also resets permanently failed orders (ns_failed: true)
 *
 * Does NOT reset "no_items" or "header_updated" orders because those are
 * resolved correctly — the SKUs simply don't exist in NetSuite.
 * To force-reset those, pass resetNoItems = true.
 */
export const retryFailedSalesOrders = async (
    resetAll     = false,
    resetNoItems = false
): Promise<any> => {
    const ns_db      = await getDb("netsuite");
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
            $set:   { ns_synced: false },
            $unset: {
                ns_error:       "",
                ns_error_at:    "",
                ns_retry_count: "",
                ns_failed:      "",
                ns_result:      "",
                ns_note:        "",
                ns_note_at:     "",
            }
        }
    );

    const orderList = failedOrders.map((o: any) => ({
        otherrefnum:   o.otherrefnum,
        previousResult: o.ns_result   || null,
        previousError: o.ns_error     || null,
        retryCount:    o.ns_retry_count || 0,
    }));

    log.info(`[NS SO Sync] Reset ${result.modifiedCount} orders for retry.`);
    return {
        message: `Reset ${result.modifiedCount} orders for retry.`,
        count:   result.modifiedCount,
        orders:  orderList,
    };
};

/**
 * Convenience: reset only no_items and header_updated orders.
 * Use this after adding new SKUs to NetSuite so those orders get re-attempted.
 */
export const retryUnmappedSalesOrders = async (): Promise<any> => {
    return retryFailedSalesOrders(false, true);
};