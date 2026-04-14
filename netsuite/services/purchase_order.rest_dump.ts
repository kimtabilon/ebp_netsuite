import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { extractPurchaseOrderIdFromListItem } from "./netsuite.rest.client";

/** Mongo collection for raw NetSuite REST purchase order payloads (one document per PO row). */
export const NS_REST_PO_DUMP_COLLECTION = "ns_rest_purchase_order_detail_dump";

export type PersistRestPurchaseOrderItemsOptions = {
    save: boolean;
    queryContext?: Record<string, unknown>;
};

export type PersistRestPurchaseOrderItemsResult = {
    saved: boolean;
    collection: string;
    upserted: number;
    skipped: number;
    errors: number;
    hint?: string;
};

function extractNsIdFromRestPayload(item: any): string | null {
    if (item == null || typeof item !== "object") return null;
    if (item._hydrateError && item.listItem) {
        return extractPurchaseOrderIdFromListItem(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractPurchaseOrderIdFromListItem(item);
}

/**
 * Writes each hydrated (or error stub) purchase order as its own document.
 * Upserts on `ns_internal_id`.
 */
export async function persistRestPurchaseOrderItems(
    items: any[],
    options: PersistRestPurchaseOrderItemsOptions
): Promise<PersistRestPurchaseOrderItemsResult> {
    const base: PersistRestPurchaseOrderItemsResult = {
        saved: false,
        collection: NS_REST_PO_DUMP_COLLECTION,
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
    const col = ns_db.collection(NS_REST_PO_DUMP_COLLECTION);
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
            log.error(`[NS REST PO dump] upsert failed for PO ${nsId}:`, err?.message || err);
        }
    }

    base.saved = true;
    if (base.upserted === 0 && items.length > 0) {
        base.hint =
            "No documents upserted — check persist.skipped (missing ns id) or persist.errors (Mongo). Collection: netsuite." +
            NS_REST_PO_DUMP_COLLECTION;
    }
    log.info(
        `[NS REST PO dump] collection=${NS_REST_PO_DUMP_COLLECTION} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`
    );
    return base;
}
