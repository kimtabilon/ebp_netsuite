import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { extractInventoryItemIdFromListItem } from "./netsuite.rest.client";

export const NS_REST_INVENTORY_ITEM_DUMP_COLLECTION = "ns_rest_inventory_item_detail_dump";
export const NS_REST_INVENTORY_ITEM_DUMP_COLLECTION_DUMMY = "ns_rest_inventory_item_detail_dump_dummy";

export type PersistRestInventoryItemRowsOptions = {
    save: boolean;
    queryContext?: Record<string, unknown>;
    collection?: string;
};

export type PersistRestInventoryItemRowsResult = {
    saved: boolean;
    collection: string;
    upserted: number;
    skipped: number;
    errors: number;
};

function extractNsIdFromRestPayload(item: any): string | null {
    if (item == null || typeof item !== "object") return null;
    if (item._hydrateError && item.listItem) {
        return extractInventoryItemIdFromListItem(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractInventoryItemIdFromListItem(item);
}

export async function persistRestInventoryItemRows(
    items: any[],
    options: PersistRestInventoryItemRowsOptions
): Promise<PersistRestInventoryItemRowsResult> {
    const targetCollection = options.collection || NS_REST_INVENTORY_ITEM_DUMP_COLLECTION;
    const base: PersistRestInventoryItemRowsResult = {
        saved: false,
        collection: targetCollection,
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
    const col = ns_db.collection(targetCollection);
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
            log.error(`[NS REST inventory item dump] upsert failed for ${nsId}:`, err?.message || err);
        }
    }

    base.saved = true;
    if (base.upserted === 0 && base.skipped > 0) {
        const sample = items[0];
        const keys = sample && typeof sample === "object" ? Object.keys(sample).slice(0, 25) : [];
        log.warn(
            `[NS REST inventory item dump] all ${base.skipped} row(s) skipped (no internal id). First row keys: ${keys.join(", ")}`
        );
    }
    log.info(
        `[NS REST inventory item dump] collection=${targetCollection} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`
    );
    return base;
}
