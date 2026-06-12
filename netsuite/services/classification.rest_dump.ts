import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { extractClassificationIdFromListItem } from "./netsuite.rest.client";

export const NS_REST_CLASSIFICATION_DUMP_COLLECTION = "ns_rest_classification_detail_dump";
export const NS_REST_CLASSIFICATION_DUMP_COLLECTION_DUMMY = "ns_rest_classification_detail_dump_dummy";

export type PersistRestClassificationRowsOptions = {
    save: boolean;
    queryContext?: Record<string, unknown>;
    collection?: string;
};

export type PersistRestClassificationRowsResult = {
    saved: boolean;
    collection: string;
    upserted: number;
    skipped: number;
    errors: number;
};

function extractNsIdFromRestPayload(item: any): string | null {
    if (item == null || typeof item !== "object") return null;
    if (item._hydrateError && item.listItem) {
        return extractClassificationIdFromListItem(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractClassificationIdFromListItem(item);
}

export async function persistRestClassificationRows(
    items: any[],
    options: PersistRestClassificationRowsOptions
): Promise<PersistRestClassificationRowsResult> {
    const targetCollection = options.collection || NS_REST_CLASSIFICATION_DUMP_COLLECTION;
    const base: PersistRestClassificationRowsResult = {
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
            log.error(`[NS REST classification dump] upsert failed for ${nsId}:`, err?.message || err);
        }
    }

    base.saved = true;
    log.info(
        `[NS REST classification dump] collection=${targetCollection} upserted=${base.upserted} skipped=${base.skipped} errors=${base.errors}`
    );
    return base;
}
