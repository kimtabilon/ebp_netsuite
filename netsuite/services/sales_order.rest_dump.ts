import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { extractSalesOrderIdFromListItem } from "./netsuite.rest.client";

/** Mongo collection for raw NetSuite REST sales order payloads (one document per order row). */
export const NS_REST_SO_DUMP_COLLECTION = "ns_rest_sales_order_detail_dump";

export type PersistRestSalesOrderItemsOptions = {
    /** When false, no database writes (flag off). */
    save: boolean;
    /** Optional context stored on each document for traceability. */
    queryContext?: Record<string, unknown>;
};

export type PersistRestSalesOrderItemsResult = {
    saved: boolean;
    collection: string;
    /** Rows that were written or replaced */
    upserted: number;
    /** Rows skipped (no NetSuite id, or empty item) */
    skipped: number;
    /** Replace/upsert failures */
    errors: number;
};

function extractNsIdFromRestPayload(item: any): string | null {
    if (item == null || typeof item !== "object") return null;
    if (item._hydrateError && item.listItem) {
        return extractSalesOrderIdFromListItem(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractSalesOrderIdFromListItem(item);
}

/**
 * Writes each hydrated (or error stub) sales order as its own document.
 * Uses upsert on `ns_internal_id` so re-dumps refresh the same logical row.
 */
export async function persistRestSalesOrderItems(
    items: any[],
    options: PersistRestSalesOrderItemsOptions
): Promise<PersistRestSalesOrderItemsResult> {
    const base: PersistRestSalesOrderItemsResult = {
        saved: false,
        collection: NS_REST_SO_DUMP_COLLECTION,
        upserted: 0,
        skipped: 0,
        errors: 0,
    };

    if (!options.save) {
        return base;
    }

    if (!Array.isArray(items) || items.length === 0) {
        base.saved = true;
        return base;
    }

    const ns_db = await getDb("netsuite");
    const col = ns_db.collection(NS_REST_SO_DUMP_COLLECTION);
    const now = new Date();

    for (const item of items) {
        const nsId = extractNsIdFromRestPayload(item);
        if (!nsId) {
            base.skipped++;
            continue;
        }

        const doc = {
            ns_internal_id: nsId,
            dumped_at: now,
            query_context: options.queryContext ?? null,
            payload: item,
        };

        try {
            await col.replaceOne({ ns_internal_id: nsId }, doc, { upsert: true });
            base.upserted++;
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST dump] upsert failed for SO ${nsId}:`, err?.message || err);
        }
    }

    base.saved = true;
    log.info(
        `[NS REST dump] collection=${NS_REST_SO_DUMP_COLLECTION} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`
    );
    return base;
}
