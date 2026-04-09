import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { extractItemFulfillmentIdFromListItem } from "./netsuite.rest.client";

export const NS_REST_ITEM_FULFILLMENT_DUMP_COLLECTION = "ns_rest_item_fulfillment_detail_dump";

export type PersistRestItemFulfillmentRowsOptions = {
    save: boolean;
    queryContext?: Record<string, unknown>;
};

export type PersistRestItemFulfillmentRowsResult = {
    saved: boolean;
    collection: string;
    upserted: number;
    skipped: number;
    errors: number;
};

function extractNsIdFromRestPayload(item: any): string | null {
    if (item == null || typeof item !== "object") return null;
    if (item._hydrateError && item.listItem) {
        return extractItemFulfillmentIdFromListItem(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractItemFulfillmentIdFromListItem(item);
}

export async function persistRestItemFulfillmentRows(
    items: any[],
    options: PersistRestItemFulfillmentRowsOptions
): Promise<PersistRestItemFulfillmentRowsResult> {
    const base: PersistRestItemFulfillmentRowsResult = {
        saved: false,
        collection: NS_REST_ITEM_FULFILLMENT_DUMP_COLLECTION,
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
    const col = ns_db.collection(NS_REST_ITEM_FULFILLMENT_DUMP_COLLECTION);
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
            log.error(`[NS REST item fulfillment dump] upsert failed for ${nsId}:`, err?.message || err);
        }
    }

    base.saved = true;
    log.info(
        `[NS REST item fulfillment dump] collection=${NS_REST_ITEM_FULFILLMENT_DUMP_COLLECTION} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`
    );
    return base;
}
