"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCompareFlag = parseCompareFlag;
exports.shouldRunBaselineCompareWithPersist = shouldRunBaselineCompareWithPersist;
exports.parseCompareOrderSource = parseCompareOrderSource;
exports.extractNsRestIdForCompare = extractNsRestIdForCompare;
exports.runNsRestCompareBatch = runNsRestCompareBatch;
exports.runNsRestCompareBaselineBatch = runNsRestCompareBaselineBatch;
const mongdodb_config_1 = require("../config/mongdodb.config");
const logger_config_1 = __importDefault(require("../config/logger.config"));
const ns_rest_compare_fields_1 = require("../config/ns_rest_compare.fields");
const ns_baseline_compare_config_1 = require("../config/ns_baseline_compare.config");
function parseCompareFlag(req) {
    const q = req.query || {};
    const b = req.body || {};
    const truthy = (v) => v === true || v === "true" || v === "1" || v === 1;
    return truthy(q.compare) || truthy(b.compare);
}
function compareExplicitlyDisabled(req) {
    const q = req.query || {};
    const b = req.body || {};
    const off = (v) => {
        if (v === false || v === 0)
            return true;
        if (v == null)
            return false;
        const s = String(v).trim().toLowerCase();
        return s === "false" || s === "0" || s === "no" || s === "off";
    };
    return off(q.compare) || off(b.compare);
}
/**
 * Run baseline compare when `compare=true`, or whenever `persistDb=true` (dump + diff in one call).
 * Opt out while persisting: `compare=false`.
 */
function shouldRunBaselineCompareWithPersist(req, persistDb) {
    if (compareExplicitlyDisabled(req))
        return false;
    if (parseCompareFlag(req))
        return true;
    return persistDb;
}
/** Disambiguate `suite_sales_order` when multiple rows share the same `otherrefnum`. */
function parseCompareOrderSource(req) {
    const q = req.query || {};
    const b = req.body || {};
    const v = q.compareOrderSource ?? q.orderSource ?? b.compareOrderSource ?? b.orderSource;
    if (v == null || String(v).trim() === "")
        return undefined;
    return String(v).trim();
}
function getAtPath(obj, path) {
    if (obj == null || typeof obj !== "object")
        return undefined;
    const parts = path.split(".").filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (cur == null || typeof cur !== "object")
            return undefined;
        cur = cur[p];
    }
    return cur;
}
function valuesEqual(a, b) {
    if (a === b)
        return true;
    if (a == null && b == null)
        return true;
    if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        }
        catch {
            return false;
        }
    }
    return false;
}
function isHydrateErrorStub(item) {
    return item != null && typeof item === "object" && "_hydrateError" in item;
}
/**
 * Extract NetSuite internal id from a list row or full GET payload (incl. error stubs with listItem).
 */
function extractNsRestIdForCompare(item, extractId) {
    if (item == null || typeof item !== "object")
        return null;
    if (item._hydrateError && item.listItem) {
        return extractId(item.listItem);
    }
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "")
        return String(direct).trim();
    return extractId(item);
}
function buildFieldDiffs(beforePayload, afterPayload, paths) {
    const diffs = [];
    for (const path of paths) {
        const bv = getAtPath(beforePayload, path);
        const av = getAtPath(afterPayload, path);
        if (!valuesEqual(bv, av)) {
            diffs.push({ path, before: bv, after: av });
        }
    }
    return diffs;
}
function digitsToNumber(v) {
    if (v == null)
        return undefined;
    if (typeof v === "number" && !Number.isNaN(v))
        return v;
    const m = String(v).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : undefined;
}
function normalizeNumericId(v) {
    if (v == null || v === "")
        return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.trunc(n)) : undefined;
}
function normalizeDateLoose(v) {
    if (v == null)
        return undefined;
    if (v instanceof Date && !Number.isNaN(v.getTime()))
        return v.toISOString().slice(0, 10);
    const d = new Date(v);
    if (!Number.isNaN(d.getTime()))
        return d.toISOString().slice(0, 10);
    return String(v);
}
/** SO/PO line sublist: expanded subrecord uses `item.items`; some payloads use top-level `items`. */
function extractRestTransactionLineRows(rest) {
    if (rest == null || typeof rest !== "object")
        return [];
    const nested = rest.item?.items;
    if (Array.isArray(nested))
        return nested;
    if (Array.isArray(rest.items))
        return rest.items;
    return [];
}
function roundQty(n) {
    const x = Number(n);
    if (!Number.isFinite(x))
        return 0;
    return Math.round(x * 1000000) / 1000000;
}
function roundMoney(n) {
    const x = Number(n);
    if (!Number.isFinite(x))
        return 0;
    return Math.round(x * 10000) / 10000;
}
function restSalesOrderLineItemKey(line) {
    if (line == null || typeof line !== "object")
        return "";
    const it = line.item;
    if (it != null && typeof it === "object") {
        const ref = it.refName != null ? String(it.refName).trim() : "";
        const id = it.id != null ? String(it.id).trim() : "";
        return ref || id;
    }
    if (it != null && (typeof it === "string" || typeof it === "number"))
        return String(it).trim();
    return String(line.itemId ?? line.itemid ?? "").trim();
}
function normalizeRestSalesOrderLines(lines) {
    if (!Array.isArray(lines))
        return [];
    const out = [];
    for (const line of lines) {
        if (line == null || typeof line !== "object")
            continue;
        const item = restSalesOrderLineItemKey(line);
        const quantity = Number(line.quantity ?? line.qty ?? 0);
        const rate = line.rate != null ? Number(line.rate) : NaN;
        const amtDirect = line.amount != null ? Number(line.amount) : NaN;
        const amount = Number.isFinite(amtDirect)
            ? amtDirect
            : Number.isFinite(rate) && Number.isFinite(quantity)
                ? rate * quantity
                : 0;
        if (!item && !quantity && !amount)
            continue;
        out.push({ item, quantity: roundQty(quantity), amount: roundMoney(amount) });
    }
    out.sort((a, b) => a.item.localeCompare(b.item) || a.quantity - b.quantity || a.amount - b.amount);
    return out;
}
function normalizeSuiteSalesOrderItems(dbVal) {
    if (!Array.isArray(dbVal))
        return [];
    const out = [];
    for (const row of dbVal) {
        if (row == null || typeof row !== "object")
            continue;
        const item = String(row.item ?? "").trim();
        const quantity = roundQty(row.quantity);
        const amount = roundMoney(row.amount);
        if (!item && !quantity && !amount)
            continue;
        out.push({ item, quantity, amount });
    }
    out.sort((a, b) => a.item.localeCompare(b.item) || a.quantity - b.quantity || a.amount - b.amount);
    return out;
}
function restPoLineSku(line) {
    if (line == null || typeof line !== "object")
        return "";
    const it = line.item;
    if (it != null && typeof it === "object") {
        return String(it.refName ?? it.id ?? "").trim();
    }
    if (it != null && (typeof it === "string" || typeof it === "number"))
        return String(it).trim();
    return String(line.sku ?? "").trim();
}
function normalizeRestPurchaseOrderLines(lines) {
    if (!Array.isArray(lines))
        return [];
    const out = [];
    for (const line of lines) {
        if (line == null || typeof line !== "object")
            continue;
        const sku = restPoLineSku(line);
        const qty = Number(line.quantity ?? line.qty ?? 0);
        const rate = line.rate != null ? Number(line.rate) : NaN;
        const amt = line.amount != null ? Number(line.amount) : NaN;
        const cost = Number.isFinite(amt)
            ? amt
            : Number.isFinite(rate) && Number.isFinite(qty)
                ? rate * qty
                : Number(line.cost ?? 0);
        if (!sku && !qty && !cost)
            continue;
        out.push({ sku, qty: roundQty(qty), cost: roundMoney(cost) });
    }
    out.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty || a.cost - b.cost);
    return out;
}
function normalizeSuitePurchaseOrderItems(dbVal) {
    if (!Array.isArray(dbVal))
        return [];
    const out = [];
    for (const row of dbVal) {
        if (row == null || typeof row !== "object")
            continue;
        const r = row;
        const sku = String(r.sku ?? "").trim();
        const qty = roundQty(r.qty ?? r.quantity);
        const cost = roundMoney(r.cost ?? r.amount);
        if (!sku && !qty && !cost)
            continue;
        out.push({ sku, qty, cost });
    }
    out.sort((a, b) => a.sku.localeCompare(b.sku) || a.qty - b.qty || a.cost - b.cost);
    return out;
}
function applyBaselineCoerce(spec, restVal, dbVal) {
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
function buildBaselineCompareDiffs(restObj, dbObj, specs) {
    const diffs = [];
    for (const spec of specs) {
        if (!spec.restPath || String(spec.restPath).trim() === "")
            continue;
        if (spec.arrayCompare === "sales_order_lines") {
            const rawLines = extractRestTransactionLineRows(restObj);
            let rv = normalizeRestSalesOrderLines(rawLines);
            let dv = normalizeSuiteSalesOrderItems(getAtPath(dbObj, spec.dbField));
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
            const rawLines = extractRestTransactionLineRows(restObj);
            let rv = normalizeRestPurchaseOrderLines(rawLines);
            let dv = normalizeSuitePurchaseOrderItems(getAtPath(dbObj, spec.dbField));
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
function restOtherRefForSuiteSo(rest) {
    const v = rest?.otherRefNum ?? rest?.otherrefnum ?? rest?.otherReference;
    if (v != null && String(v).trim() !== "")
        return String(v).trim();
    return null;
}
function restPoNumberForSuite(rest) {
    const tr = rest?.tranId != null ? String(rest.tranId) : "";
    const m = tr.match(/(\d+)/);
    if (m)
        return parseInt(m[1], 10);
    return null;
}
function flattenClassificationForest(roots) {
    const map = new Map();
    function walk(node) {
        if (node == null || typeof node !== "object")
            return;
        if (node.internalid != null)
            map.set(String(node.internalid), node);
        const kids = node.children;
        if (Array.isArray(kids))
            for (const k of kids)
                walk(k);
    }
    for (const r of roots)
        walk(r);
    return map;
}
async function runNsRestCompareBatch(options) {
    const base = {
        enabled: true,
        compareMode: "dump",
        comparedRows: 0,
        logsWritten: 0,
        skippedNoId: 0,
        skippedErrorStub: 0,
        skippedAmbiguous: 0,
        newInNetsuite: 0,
        fieldMismatches: 0,
        logCollection: ns_rest_compare_fields_1.NS_REST_COMPARE_LOG_COLLECTION,
        errors: 0,
        baselineCollection: null,
    };
    const paths = ns_rest_compare_fields_1.NS_REST_COMPARE_FIELD_PATHS[options.recordTypeKey] ?? [];
    if (paths.length === 0) {
        logger_config_1.default.warn(`[NS REST compare] No field paths for record_type=${options.recordTypeKey} — only "new_in_netsuite" checks run`);
    }
    if (!Array.isArray(options.items) || options.items.length === 0) {
        return base;
    }
    const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
    const dumpCol = nsDb.collection(options.dumpCollection);
    const logCol = nsDb.collection(ns_rest_compare_fields_1.NS_REST_COMPARE_LOG_COLLECTION);
    const idToItem = new Map();
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
    let existing = [];
    try {
        existing = await dumpCol.find({ ns_internal_id: { $in: ids } }).toArray();
    }
    catch (err) {
        base.errors++;
        logger_config_1.default.error(`[NS REST compare] load dump ${options.dumpCollection}:`, err?.message || err);
        return base;
    }
    const byId = new Map(existing.map((d) => [String(d.ns_internal_id), d]));
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
            }
            catch (err) {
                base.errors++;
                logger_config_1.default.error(`[NS REST compare] log insert ${id}:`, err?.message || err);
            }
            continue;
        }
        const fieldDiffs = paths.length ? buildFieldDiffs(oldPayload, incoming, paths) : [];
        if (fieldDiffs.length === 0)
            continue;
        base.fieldMismatches++;
        logger_config_1.default.warn(`[NS REST compare] ${options.recordTypeKey} id=${id} — ${fieldDiffs.length} field(s) differ vs ${options.dumpCollection}`);
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
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST compare] log insert ${id}:`, err?.message || err);
        }
    }
    return base;
}
/**
 * Compare each live REST item to an operational Mongo document (suite_* / netsuite_*),
 * not the ns_rest_* detail_dump `payload` rows.
 */
async function runNsRestCompareBaselineBatch(options) {
    const cfg = ns_baseline_compare_config_1.NS_BASELINE_COMPARE[options.variant];
    const base = {
        enabled: true,
        compareMode: "baseline",
        comparedRows: 0,
        logsWritten: 0,
        skippedNoId: 0,
        skippedErrorStub: 0,
        skippedAmbiguous: 0,
        newInNetsuite: 0,
        fieldMismatches: 0,
        logCollection: ns_rest_compare_fields_1.NS_REST_COMPARE_LOG_COLLECTION,
        errors: 0,
        baselineCollection: cfg.baselineCollection,
    };
    const compareFields = cfg.compareFields;
    if (!Array.isArray(options.items) || options.items.length === 0) {
        return base;
    }
    const nsDb = await (0, mongdodb_config_1.getDb)("netsuite");
    const baselineCol = nsDb.collection(cfg.baselineCollection);
    const logCol = nsDb.collection(ns_rest_compare_fields_1.NS_REST_COMPARE_LOG_COLLECTION);
    const now = new Date();
    const validItems = [];
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
    let classMap = null;
    if (options.variant === "classification_tree") {
        try {
            const roots = await baselineCol.find({}).toArray();
            classMap = flattenClassificationForest(roots);
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST compare baseline] load ${cfg.baselineCollection}:`, err?.message || err);
            return base;
        }
    }
    /** sales_order: otherrefnum -> docs */
    let soByRef = null;
    if (options.variant === "sales_order_staged") {
        const refs = new Set();
        for (const { item } of validItems) {
            const r = restOtherRefForSuiteSo(item);
            if (r)
                refs.add(r);
        }
        if (refs.size === 0) {
            for (const { item } of validItems)
                base.skippedNoId++;
            return base;
        }
        try {
            const docs = await baselineCol.find({ otherrefnum: { $in: [...refs] } }).toArray();
            soByRef = new Map();
            for (const d of docs) {
                const k = String(d.otherrefnum ?? "");
                if (!k)
                    continue;
                const arr = soByRef.get(k) ?? [];
                arr.push(d);
                soByRef.set(k, arr);
            }
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST compare baseline] load suite_sales_order:`, err?.message || err);
            return base;
        }
    }
    /** purchase_order: po_number -> doc */
    let poByNum = null;
    if (options.variant === "purchase_order_staged") {
        const nums = new Set();
        for (const { item } of validItems) {
            const n = restPoNumberForSuite(item);
            if (n != null)
                nums.add(n);
        }
        if (nums.size === 0) {
            for (const { item } of validItems)
                base.skippedNoId++;
            return base;
        }
        try {
            const docs = await baselineCol.find({ po_number: { $in: [...nums] } }).toArray();
            poByNum = new Map();
            for (const d of docs) {
                if (d.po_number != null)
                    poByNum.set(Number(d.po_number), d);
            }
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST compare baseline] load suite_purchase_order:`, err?.message || err);
            return base;
        }
    }
    /** inventory: internalid string -> doc */
    let itemByInternal = null;
    if (options.variant === "inventory_item_full") {
        const ids = new Set();
        for (const { item, nsId } of validItems) {
            const id = nsId ?? extractNsRestIdForCompare(item, options.extractId);
            if (id)
                ids.add(String(id));
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
            itemByInternal = new Map();
            for (const d of docs) {
                if (d.internalid != null)
                    itemByInternal.set(String(d.internalid), d);
            }
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST compare baseline] load netsuite_items_full:`, err?.message || err);
            return base;
        }
    }
    for (const { item, nsId } of validItems) {
        base.comparedRows++;
        let baselineDoc = null;
        let lookupFilter = {};
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
            }
            else if (candidates.length === 1) {
                baselineDoc = candidates[0];
                lookupFilter = { otherrefnum: ref };
            }
            else if (candidates.length === 0) {
                baselineDoc = null;
                lookupFilter = { otherrefnum: ref };
            }
            else {
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
                }
                catch (err) {
                    base.errors++;
                    logger_config_1.default.error(`[NS REST compare baseline] log insert:`, err?.message || err);
                }
                continue;
            }
        }
        else if (options.variant === "purchase_order_staged") {
            const n = restPoNumberForSuite(item);
            if (n == null) {
                base.skippedNoId++;
                continue;
            }
            baselineDoc = poByNum?.get(n) ?? null;
            lookupFilter = { po_number: n };
        }
        else if (options.variant === "inventory_item_full") {
            const id = nsId ?? extractNsRestIdForCompare(item, options.extractId);
            if (!id) {
                base.skippedNoId++;
                continue;
            }
            baselineDoc = itemByInternal?.get(String(id)) ?? null;
            lookupFilter = { internalid: id };
        }
        else if (options.variant === "classification_tree") {
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
            }
            catch (err) {
                base.errors++;
                logger_config_1.default.error(`[NS REST compare baseline] log insert:`, err?.message || err);
            }
            continue;
        }
        const fieldDiffs = compareFields.length ? buildBaselineCompareDiffs(item, baselineDoc, compareFields) : [];
        if (fieldDiffs.length === 0)
            continue;
        base.fieldMismatches++;
        logger_config_1.default.warn(`[NS REST compare baseline] ${cfg.logRecordType} lookup=${JSON.stringify(lookupFilter)} — ${fieldDiffs.length} field pair(s) differ`);
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
        }
        catch (err) {
            base.errors++;
            logger_config_1.default.error(`[NS REST compare baseline] log insert:`, err?.message || err);
        }
    }
    return base;
}
