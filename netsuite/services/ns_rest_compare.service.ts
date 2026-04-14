import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { NS_REST_COMPARE_FIELD_PATHS, NS_REST_COMPARE_LOG_COLLECTION } from "../config/ns_rest_compare.fields";
import {
    NS_BASELINE_COMPARE,
    type BaselineCompareFieldSpec,
    type BaselineCompareVariant,
} from "../config/ns_baseline_compare.config";

export function parseCompareFlag(req: any): boolean {
    const q = req.query || {};
    const b = req.body || {};
    const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === 1;
    return truthy(q.compare) || truthy(b.compare);
}

function compareExplicitlyDisabled(req: any): boolean {
    const q = req.query || {};
    const b = req.body || {};
    const off = (v: unknown) => {
        if (v === false || v === 0) return true;
        if (v == null) return false;
        const s = String(v).trim().toLowerCase();
        return s === "false" || s === "0" || s === "no" || s === "off";
    };
    return off(q.compare) || off(b.compare);
}

/**
 * Run baseline compare when `compare=true`, or whenever `persistDb=true` (dump + diff in one call).
 * Opt out while persisting: `compare=false`.
 */
export function shouldRunBaselineCompareWithPersist(req: any, persistDb: boolean): boolean {
    if (compareExplicitlyDisabled(req)) return false;
    if (parseCompareFlag(req)) return true;
    return persistDb;
}

export type NsRestCompareSource = Record<string, unknown>;

export type NsRestCompareBatchResult = {
    enabled: true;
    compareMode: "dump" | "baseline";
    comparedRows: number;
    logsWritten: number;
    skippedNoId: number;
    skippedErrorStub: number;
    skippedAmbiguous: number;
    newInNetsuite: number;
    fieldMismatches: number;
    logCollection: string;
    errors: number;
    /** When compareMode === "baseline" */
    baselineCollection?: string | null;
};

/** Disambiguate `suite_sales_order` when multiple rows share the same `otherrefnum`. */
export function parseCompareOrderSource(req: any): string | undefined {
    const q = req.query || {};
    const b = req.body || {};
    const v = q.compareOrderSource ?? q.orderSource ?? b.compareOrderSource ?? b.orderSource;
    if (v == null || String(v).trim() === "") return undefined;
    return String(v).trim();
}

function getAtPath(obj: unknown, path: string): unknown {
    if (obj == null || typeof obj !== "object") return undefined;
    const parts = path.split(".").filter(Boolean);
    let cur: any = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = cur[p];
    }
    return cur;
}

function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }
    return false;
}

function isHydrateErrorStub(item: unknown): boolean {
    return item != null && typeof item === "object" && "_hydrateError" in (item as object);
}

/**
 * Extract NetSuite internal id from a list row or full GET payload (incl. error stubs with listItem).
 */
export function extractNsRestIdForCompare(item: any, extractId: (row: any) => string | null): string | null {
    if (item == null || typeof item !== "object") return null;
    if (item._hydrateError && item.listItem) {
        return extractId(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractId(item);
}

function buildFieldDiffs(
    beforePayload: unknown,
    afterPayload: unknown,
    paths: string[]
): { path: string; before: unknown; after: unknown }[] {
    const diffs: { path: string; before: unknown; after: unknown }[] = [];
    for (const path of paths) {
        const bv = getAtPath(beforePayload, path);
        const av = getAtPath(afterPayload, path);
        if (!valuesEqual(bv, av)) {
            diffs.push({ path, before: bv, after: av });
        }
    }
    return diffs;
}

function digitsToNumber(v: unknown): number | undefined {
    if (v == null) return undefined;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    const m = String(v).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : undefined;
}

function normalizeNumericId(v: unknown): string | undefined {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}

function normalizeDateLoose(v: unknown): string | undefined {
    if (v == null) return undefined;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    const d = new Date(v as string | number);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return String(v);
}

/** SO/PO line sublist: expanded subrecord uses `item.items`; some payloads use top-level `items`. */
function extractRestTransactionLineRows(rest: any): any[] {
    if (rest == null || typeof rest !== "object") return [];
    const nested = rest.item?.items;
    if (Array.isArray(nested)) return nested;
    if (Array.isArray(rest.items)) return rest.items;
    return [];
}

function roundQty(n: unknown): number {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 1_000_000) / 1_000_000;
}

function roundMoney(n: unknown): number {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 10_000) / 10_000;
}

function restSalesOrderLineItemKey(line: any): string {
    if (line == null || typeof line !== "object") return "";
    const it = line.item;
    if (it != null && typeof it === "object") {
        const ref = it.refName != null ? String(it.refName).trim() : "";
        const id = it.id != null ? String(it.id).trim() : "";
        return ref || id;
    }
    if (it != null && (typeof it === "string" || typeof it === "number")) return String(it).trim();
    return String(line.itemId ?? line.itemid ?? "").trim();
}

function normalizeRestSalesOrderLines(lines: any[]): { item: string; quantity: number; amount: number }[] {
    if (!Array.isArray(lines)) return [];
    const out: { item: string; quantity: number; amount: number }[] = [];
    for (const line of lines) {
        if (line == null || typeof line !== "object") continue;
        const item = restSalesOrderLineItemKey(line);
        const quantity = Number(line.quantity ?? line.qty ?? 0);
        const rate = line.rate != null ? Number(line.rate) : NaN;
        const amtDirect = line.amount != null ? Number(line.amount) : NaN;
        const amount = Number.isFinite(amtDirect)
            ? amtDirect
            : Number.isFinite(rate) && Number.isFinite(quantity)
              ? rate * quantity
              : 0;
        if (!item && !quantity && !amount) continue;
        out.push({ item, quantity: roundQty(quantity), amount: roundMoney(amount) });
    }
    out.sort(
        (a, b) =>
            a.item.localeCompare(b.item) || a.quantity - b.quantity || a.amount - b.amount
    );
    return out;
}

function normalizeSuiteSalesOrderItems(dbVal: unknown): { item: string; quantity: number; amount: number }[] {
    if (!Array.isArray(dbVal)) return [];
    const out: { item: string; quantity: number; amount: number }[] = [];
    for (const row of dbVal) {
        if (row == null || typeof row !== "object") continue;
        const item = String((row as any).item ?? "").trim();
        const quantity = roundQty((row as any).quantity);
        const amount = roundMoney((row as any).amount);
        if (!item && !quantity && !amount) continue;
        out.push({ item, quantity, amount });
    }
    out.sort(
        (a, b) =>
            a.item.localeCompare(b.item) || a.quantity - b.quantity || a.amount - b.amount
    );
    return out;
}

function restPoLineSku(line: any): string {
    if (line == null || typeof line !== "object") return "";
    const it = line.item;
    if (it != null && typeof it === "object") {
        return String(it.refName ?? it.id ?? "").trim();
    }
    if (it != null && (typeof it === "string" || typeof it === "number")) return String(it).trim();
    return String(line.sku ?? "").trim();
}

function normalizeRestPurchaseOrderLines(lines: any[]): { sku: string; qty: number; cost: number }[] {
    if (!Array.isArray(lines)) return [];
    const out: { sku: string; qty: number; cost: number }[] = [];
    for (const line of lines) {
        if (line == null || typeof line !== "object") continue;
        const sku = restPoLineSku(line);
        const qty = Number(line.quantity ?? line.qty ?? 0);
        const rate = line.rate != null ? Number(line.rate) : NaN;
        const amt = line.amount != null ? Number(line.amount) : NaN;
        const cost = Number.isFinite(amt)
            ? amt
            : Number.isFinite(rate) && Number.isFinite(qty)
              ? rate * qty
              : Number(line.cost ?? 0);
        if (!sku && !qty && !cost) continue;
        out.push({ sku, qty: roundQty(qty), cost: roundMoney(cost) });
    }
    out.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty || a.cost - b.cost);
    return out;
}

function normalizeSuitePurchaseOrderItems(dbVal: unknown): { sku: string; qty: number; cost: number }[] {
    if (!Array.isArray(dbVal)) return [];
    const out: { sku: string; qty: number; cost: number }[] = [];
    for (const row of dbVal) {
        if (row == null || typeof row !== "object") continue;
        const r = row as any;
        const sku = String(r.sku ?? "").trim();
        const qty = roundQty(r.qty ?? r.quantity);
        const cost = roundMoney(r.cost ?? r.amount);
        if (!sku && !qty && !cost) continue;
        out.push({ sku, qty, cost });
    }
    out.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty || a.cost - b.cost);
    return out;
}

function applyBaselineCoerce(
    spec: BaselineCompareFieldSpec,
    restVal: unknown,
    dbVal: unknown
): { rv: unknown; dv: unknown } {
    let rv = restVal;
    let dv = dbVal;
    switch (spec.coerce) {
        case "digits_to_number": {
            rv = digitsToNumber(rv);
            dv = typeof dv === "number" ? dv : digitsToNumber(dv);
            break;
        }
        case "numeric_id": {
            rv = normalizeNumericId(rv);
            dv = normalizeNumericId(dv);
            break;
        }
        case "date_loose": {
            rv = normalizeDateLoose(rv);
            dv = normalizeDateLoose(dv);
            break;
        }
        default:
            break;
    }
    return { rv, dv };
}

/** Uses `compareFields` from baseline config; skips entries with empty `restPath`. */
function buildBaselineCompareDiffs(
    restObj: unknown,
    dbObj: unknown,
    specs: BaselineCompareFieldSpec[]
): { path: string; before: unknown; after: unknown }[] {
    const diffs: { path: string; before: unknown; after: unknown }[] = [];
    for (const spec of specs) {
        if (!spec.restPath || String(spec.restPath).trim() === "") continue;

        if (spec.arrayCompare === "sales_order_lines") {
            const rawLines = extractRestTransactionLineRows(restObj as any);
            let rv: unknown = normalizeRestSalesOrderLines(rawLines);
            let dv: unknown = normalizeSuiteSalesOrderItems(getAtPath(dbObj, spec.dbField));
            if (spec.coerce) {
                const coerced = applyBaselineCoerce(spec, rv, dv);
                rv = coerced.rv;
                dv = coerced.dv;
            }
            if (!valuesEqual(rv, dv)) {
                diffs.push({
                    path: `${spec.restPath}|top-level.items=>${spec.dbField} (normalized line tuples)`,
                    before: dv,
                    after: rv,
                });
            }
            continue;
        }

        if (spec.arrayCompare === "purchase_order_lines") {
            const rawLines = extractRestTransactionLineRows(restObj as any);
            let rv: unknown = normalizeRestPurchaseOrderLines(rawLines);
            let dv: unknown = normalizeSuitePurchaseOrderItems(getAtPath(dbObj, spec.dbField));
            if (spec.coerce) {
                const coerced = applyBaselineCoerce(spec, rv, dv);
                rv = coerced.rv;
                dv = coerced.dv;
            }
            if (!valuesEqual(rv, dv)) {
                diffs.push({
                    path: `${spec.restPath}|top-level.items=>${spec.dbField} (normalized line tuples)`,
                    before: dv,
                    after: rv,
                });
            }
            continue;
        }

        let rv = getAtPath(restObj, spec.restPath);
        let dv = getAtPath(dbObj, spec.dbField);
        if (spec.coerce) {
            const coerced = applyBaselineCoerce(spec, rv, dv);
            rv = coerced.rv;
            dv = coerced.dv;
        }
        if (!valuesEqual(rv, dv)) {
            diffs.push({
                path: `${spec.restPath}=>${spec.dbField}`,
                before: dv,
                after: rv,
            });
        }
    }
    return diffs;
}

function restOtherRefForSuiteSo(rest: any): string | null {
    const v = rest?.otherRefNum ?? rest?.otherrefnum ?? rest?.otherReference;
    if (v != null && String(v).trim() !== "") return String(v).trim();
    return null;
}

function restPoNumberForSuite(rest: any): number | null {
    const tr = rest?.tranId != null ? String(rest.tranId) : "";
    const m = tr.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
    return null;
}

function flattenClassificationForest(roots: any[]): Map<string, any> {
    const map = new Map<string, any>();
    function walk(node: any) {
        if (node == null || typeof node !== "object") return;
        if (node.internalid != null) map.set(String(node.internalid), node);
        const kids = node.children;
        if (Array.isArray(kids)) for (const k of kids) walk(k);
    }
    for (const r of roots) walk(r);
    return map;
}

export async function runNsRestCompareBatch(options: {
    recordTypeKey: keyof typeof NS_REST_COMPARE_FIELD_PATHS | string;
    dumpCollection: string;
    items: any[];
    extractId: (item: any) => string | null;
    source: NsRestCompareSource;
}): Promise<NsRestCompareBatchResult> {
    const base: NsRestCompareBatchResult = {
        enabled: true,
        compareMode: "dump",
        comparedRows: 0,
        logsWritten: 0,
        skippedNoId: 0,
        skippedErrorStub: 0,
        skippedAmbiguous: 0,
        newInNetsuite: 0,
        fieldMismatches: 0,
        logCollection: NS_REST_COMPARE_LOG_COLLECTION,
        errors: 0,
        baselineCollection: null,
    };

    const paths =
        NS_REST_COMPARE_FIELD_PATHS[options.recordTypeKey as keyof typeof NS_REST_COMPARE_FIELD_PATHS] ?? [];
    if (paths.length === 0) {
        log.warn(`[NS REST compare] No field paths for record_type=${options.recordTypeKey} — only "new_in_netsuite" checks run`);
    }

    if (!Array.isArray(options.items) || options.items.length === 0) {
        return base;
    }

    const nsDb = await getDb("netsuite");
    const dumpCol = nsDb.collection(options.dumpCollection);
    const logCol = nsDb.collection(NS_REST_COMPARE_LOG_COLLECTION);

    const idToItem = new Map<string, any>();
    for (const item of options.items) {
        if (isHydrateErrorStub(item)) {
            base.skippedErrorStub++;
            continue;
        }
        const id = extractNsRestIdForCompare(item, options.extractId);
        if (!id) {
            base.skippedNoId++;
            continue;
        }
        idToItem.set(id, item);
    }

    const ids = [...idToItem.keys()];
    if (ids.length === 0) {
        return base;
    }

    let existing: any[] = [];
    try {
        existing = await dumpCol.find({ ns_internal_id: { $in: ids } }).toArray();
    } catch (err: any) {
        base.errors++;
        log.error(`[NS REST compare] load dump ${options.dumpCollection}:`, err?.message || err);
        return base;
    }

    const byId = new Map<string, any>(existing.map((d) => [String(d.ns_internal_id), d]));
    const now = new Date();

    for (const [id, incoming] of idToItem) {
        base.comparedRows++;
        const prev = byId.get(id);
        const oldPayload = prev?.payload;

        if (oldPayload == null) {
            base.newInNetsuite++;
            try {
                await logCol.insertOne({
                    compared_at: now,
                    record_type: options.recordTypeKey,
                    ns_internal_id: id,
                    dump_collection: options.dumpCollection,
                    change_kind: "new_in_netsuite",
                    source: options.source,
                    field_diffs: [],
                    note: "No prior row in REST dump collection for this internal id.",
                });
                base.logsWritten++;
            } catch (err: any) {
                base.errors++;
                log.error(`[NS REST compare] log insert ${id}:`, err?.message || err);
            }
            continue;
        }

        const fieldDiffs = paths.length ? buildFieldDiffs(oldPayload, incoming, paths) : [];
        if (fieldDiffs.length === 0) continue;

        base.fieldMismatches++;
        log.warn(
            `[NS REST compare] ${options.recordTypeKey} id=${id} — ${fieldDiffs.length} field(s) differ vs ${options.dumpCollection}`
        );

        try {
            await logCol.insertOne({
                compared_at: now,
                record_type: options.recordTypeKey,
                ns_internal_id: id,
                dump_collection: options.dumpCollection,
                change_kind: "field_mismatch",
                source: options.source,
                field_diffs: fieldDiffs,
                previous_dumped_at: prev.dumped_at ?? null,
            });
            base.logsWritten++;
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST compare] log insert ${id}:`, err?.message || err);
        }
    }

    return base;
}

/**
 * Compare each live REST item to an operational Mongo document (suite_* / netsuite_*),
 * not the ns_rest_* detail_dump `payload` rows.
 */
export async function runNsRestCompareBaselineBatch(options: {
    variant: BaselineCompareVariant;
    items: any[];
    extractId: (item: any) => string | null;
    source: NsRestCompareSource;
    /** For sales_order_staged: narrows `suite_sales_order` when several rows share `otherrefnum`. */
    orderSource?: string | undefined;
}): Promise<NsRestCompareBatchResult> {
    const cfg = NS_BASELINE_COMPARE[options.variant];
    const base: NsRestCompareBatchResult = {
        enabled: true,
        compareMode: "baseline",
        comparedRows: 0,
        logsWritten: 0,
        skippedNoId: 0,
        skippedErrorStub: 0,
        skippedAmbiguous: 0,
        newInNetsuite: 0,
        fieldMismatches: 0,
        logCollection: NS_REST_COMPARE_LOG_COLLECTION,
        errors: 0,
        baselineCollection: cfg.baselineCollection,
    };

    const compareFields = cfg.compareFields;
    if (!Array.isArray(options.items) || options.items.length === 0) {
        return base;
    }

    const nsDb = await getDb("netsuite");
    const baselineCol = nsDb.collection(cfg.baselineCollection);
    const logCol = nsDb.collection(NS_REST_COMPARE_LOG_COLLECTION);
    const now = new Date();

    const validItems: { item: any; nsId: string | null }[] = [];
    for (const item of options.items) {
        if (isHydrateErrorStub(item)) {
            base.skippedErrorStub++;
            continue;
        }
        const nsId = extractNsRestIdForCompare(item, options.extractId);
        validItems.push({ item, nsId });
    }

    if (validItems.length === 0) {
        return base;
    }

    let classMap: Map<string, any> | null = null;
    if (options.variant === "classification_tree") {
        try {
            const roots = await baselineCol.find({}).toArray();
            classMap = flattenClassificationForest(roots);
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST compare baseline] load ${cfg.baselineCollection}:`, err?.message || err);
            return base;
        }
    }

    /** sales_order: otherrefnum -> docs */
    let soByRef: Map<string, any[]> | null = null;
    if (options.variant === "sales_order_staged") {
        const refs = new Set<string>();
        for (const { item } of validItems) {
            const r = restOtherRefForSuiteSo(item);
            if (r) refs.add(r);
        }
        if (refs.size === 0) {
            for (const { item } of validItems) base.skippedNoId++;
            return base;
        }
        try {
            const docs = await baselineCol.find({ otherrefnum: { $in: [...refs] } }).toArray();
            soByRef = new Map<string, any[]>();
            for (const d of docs) {
                const k = String(d.otherrefnum ?? "");
                if (!k) continue;
                const arr = soByRef.get(k) ?? [];
                arr.push(d);
                soByRef.set(k, arr);
            }
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST compare baseline] load suite_sales_order:`, err?.message || err);
            return base;
        }
    }

    /** purchase_order: po_number -> doc */
    let poByNum: Map<number, any> | null = null;
    if (options.variant === "purchase_order_staged") {
        const nums = new Set<number>();
        for (const { item } of validItems) {
            const n = restPoNumberForSuite(item);
            if (n != null) nums.add(n);
        }
        if (nums.size === 0) {
            for (const { item } of validItems) base.skippedNoId++;
            return base;
        }
        try {
            const docs = await baselineCol.find({ po_number: { $in: [...nums] } }).toArray();
            poByNum = new Map<number, any>();
            for (const d of docs) {
                if (d.po_number != null) poByNum.set(Number(d.po_number), d);
            }
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST compare baseline] load suite_purchase_order:`, err?.message || err);
            return base;
        }
    }

    /** inventory: internalid string -> doc */
    let itemByInternal: Map<string, any> | null = null;
    if (options.variant === "inventory_item_full") {
        const ids = new Set<string>();
        for (const { item, nsId } of validItems) {
            const id = nsId ?? extractNsRestIdForCompare(item, options.extractId);
            if (id) ids.add(String(id));
        }
        if (ids.size === 0) {
            base.skippedNoId += validItems.length;
            return base;
        }
        const numIds = [...ids].map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
        try {
            const docs = await baselineCol
                .find({ internalid: { $in: numIds.length ? numIds : [...ids] } })
                .toArray();
            itemByInternal = new Map<string, any>();
            for (const d of docs) {
                if (d.internalid != null) itemByInternal.set(String(d.internalid), d);
            }
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST compare baseline] load netsuite_items_full:`, err?.message || err);
            return base;
        }
    }

    for (const { item, nsId } of validItems) {
        base.comparedRows++;
        let baselineDoc: any = null;
        let lookupFilter: Record<string, unknown> = {};

        if (options.variant === "sales_order_staged") {
            const ref = restOtherRefForSuiteSo(item);
            if (!ref) {
                base.skippedNoId++;
                continue;
            }
            const candidates = soByRef?.get(ref) ?? [];
            if (options.orderSource) {
                baselineDoc = candidates.find((c) => String(c.order_source) === options.orderSource) ?? null;
                lookupFilter = { otherrefnum: ref, order_source: options.orderSource };
            } else if (candidates.length === 1) {
                baselineDoc = candidates[0];
                lookupFilter = { otherrefnum: ref };
            } else if (candidates.length === 0) {
                baselineDoc = null;
                lookupFilter = { otherrefnum: ref };
            } else {
                base.skippedAmbiguous++;
                try {
                    await logCol.insertOne({
                        compared_at: now,
                        record_type: cfg.logRecordType,
                        ns_internal_id: nsId,
                        compare_mode: "baseline",
                        baseline_collection: cfg.baselineCollection,
                        lookup_filter: { otherrefnum: ref },
                        change_kind: "ambiguous_baseline_lookup",
                        source: options.source,
                        field_diffs: [],
                        note: `${candidates.length} rows in suite_sales_order for otherrefnum — pass compareOrderSource (order_source) to pick one.`,
                    });
                    base.logsWritten++;
                } catch (err: any) {
                    base.errors++;
                    log.error(`[NS REST compare baseline] log insert:`, err?.message || err);
                }
                continue;
            }
        } else if (options.variant === "purchase_order_staged") {
            const n = restPoNumberForSuite(item);
            if (n == null) {
                base.skippedNoId++;
                continue;
            }
            baselineDoc = poByNum?.get(n) ?? null;
            lookupFilter = { po_number: n };
        } else if (options.variant === "inventory_item_full") {
            const id = nsId ?? extractNsRestIdForCompare(item, options.extractId);
            if (!id) {
                base.skippedNoId++;
                continue;
            }
            baselineDoc = itemByInternal?.get(String(id)) ?? null;
            lookupFilter = { internalid: id };
        } else if (options.variant === "classification_tree") {
            const id = nsId ?? extractNsRestIdForCompare(item, options.extractId);
            if (!id) {
                base.skippedNoId++;
                continue;
            }
            baselineDoc = classMap?.get(String(id)) ?? null;
            lookupFilter = { internalid: id };
        }

        if (baselineDoc == null) {
            base.newInNetsuite++;
            try {
                await logCol.insertOne({
                    compared_at: now,
                    record_type: cfg.logRecordType,
                    ns_internal_id: nsId,
                    compare_mode: "baseline",
                    baseline_collection: cfg.baselineCollection,
                    lookup_filter: lookupFilter,
                    change_kind: "not_in_baseline",
                    source: options.source,
                    field_diffs: [],
                    note: `No matching document in ${cfg.baselineCollection} for lookup_filter.`,
                });
                base.logsWritten++;
            } catch (err: any) {
                base.errors++;
                log.error(`[NS REST compare baseline] log insert:`, err?.message || err);
            }
            continue;
        }

        const fieldDiffs = compareFields.length ? buildBaselineCompareDiffs(item, baselineDoc, compareFields) : [];
        if (fieldDiffs.length === 0) continue;

        base.fieldMismatches++;
        log.warn(
            `[NS REST compare baseline] ${cfg.logRecordType} lookup=${JSON.stringify(lookupFilter)} — ${fieldDiffs.length} field pair(s) differ`
        );

        try {
            await logCol.insertOne({
                compared_at: now,
                record_type: cfg.logRecordType,
                ns_internal_id: nsId,
                compare_mode: "baseline",
                baseline_collection: cfg.baselineCollection,
                lookup_filter: lookupFilter,
                change_kind: "field_mismatch",
                source: options.source,
                field_diffs: fieldDiffs,
            });
            base.logsWritten++;
        } catch (err: any) {
            base.errors++;
            log.error(`[NS REST compare baseline] log insert:`, err?.message || err);
        }
    }

    return base;
}
