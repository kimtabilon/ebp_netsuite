"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAllItemReceipts = exports.getItemReceipt = exports.listItemReceipts = exports.ITEM_RECEIPT_LIST_ABS_MAX = exports.ITEM_RECEIPT_LIST_DEFAULT_LIMIT = exports.ITEM_RECEIPT_FETCH_ALL_ABS_MAX = exports.ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX = exports.fetchAllItemFulfillments = exports.getItemFulfillment = exports.listItemFulfillments = exports.ITEM_FULFILLMENT_LIST_ABS_MAX = exports.ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT = exports.ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX = exports.ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX = exports.fetchAllClassifications = exports.getClassification = exports.listClassifications = exports.CLASSIFICATION_LIST_ABS_MAX = exports.CLASSIFICATION_LIST_DEFAULT_LIMIT = exports.CLASSIFICATION_FETCH_ALL_ABS_MAX = exports.CLASSIFICATION_FETCH_ALL_DEFAULT_MAX = exports.fetchAllInventoryItems = exports.getInventoryItem = exports.listInventoryItems = exports.INVENTORY_ITEM_LIST_ABS_MAX = exports.INVENTORY_ITEM_LIST_DEFAULT_LIMIT = exports.INVENTORY_ITEM_FETCH_ALL_ABS_MAX = exports.INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX = exports.fetchAllPurchaseOrders = exports.fetchAllSalesOrders = exports.getPurchaseOrder = exports.listPurchaseOrders = exports.getSalesOrder = exports.listSalesOrders = exports.PURCHASE_ORDER_LIST_ABS_MAX = exports.PURCHASE_ORDER_LIST_DEFAULT_LIMIT = exports.PURCHASE_ORDER_FETCH_ALL_ABS_MAX = exports.PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX = exports.SALES_ORDER_LIST_ABS_MAX = exports.SALES_ORDER_LIST_DEFAULT_LIMIT = exports.SALES_ORDER_FETCH_ALL_ABS_MAX = exports.SALES_ORDER_FETCH_ALL_DEFAULT_MAX = void 0;
exports.restListWantDetails = restListWantDetails;
exports.normalizeRestRecordListItems = normalizeRestRecordListItems;
exports.normalizeSalesOrderListItems = normalizeSalesOrderListItems;
exports.extractSalesOrderIdFromListItem = extractSalesOrderIdFromListItem;
exports.normalizePurchaseOrderListItems = normalizePurchaseOrderListItems;
exports.extractPurchaseOrderIdFromListItem = extractPurchaseOrderIdFromListItem;
exports.hydrateSalesOrdersFromListRows = hydrateSalesOrdersFromListRows;
exports.hydratePurchaseOrdersFromListRows = hydratePurchaseOrdersFromListRows;
exports.extractInventoryItemIdFromListItem = extractInventoryItemIdFromListItem;
exports.hydrateInventoryItemsFromListRows = hydrateInventoryItemsFromListRows;
exports.extractClassificationIdFromListItem = extractClassificationIdFromListItem;
exports.hydrateClassificationsFromListRows = hydrateClassificationsFromListRows;
exports.extractItemFulfillmentIdFromListItem = extractItemFulfillmentIdFromListItem;
exports.hydrateItemFulfillmentsFromListRows = hydrateItemFulfillmentsFromListRows;
exports.extractItemReceiptIdFromListItem = extractItemReceiptIdFromListItem;
exports.hydrateItemReceiptsFromListRows = hydrateItemReceiptsFromListRows;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const oauth_1_0a_1 = __importDefault(require("oauth-1.0a"));
const logger_config_1 = __importDefault(require("../config/logger.config"));
const concurrency_config_1 = require("../config/concurrency.config");
/** Default max sales orders returned by fetchAll when `maxRecords` is omitted */
exports.SALES_ORDER_FETCH_ALL_DEFAULT_MAX = 250;
/** Hard cap on fetchAll `maxRecords` (query cannot exceed this) */
exports.SALES_ORDER_FETCH_ALL_ABS_MAX = 5000;
/** Page size for list requests inside fetchAll (NetSuite list limit is typically ≤1000) */
const SALES_ORDER_FETCH_ALL_PAGE_SIZE = 500;
/** Default page size for GET /salesOrder list (non-fetchAll) */
exports.SALES_ORDER_LIST_DEFAULT_LIMIT = 200;
/** Max `limit` query for GET /salesOrder list */
exports.SALES_ORDER_LIST_ABS_MAX = 1000;
/** Default max POs returned by fetchAll when `maxRecords` is omitted */
exports.PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX = 250;
/** Hard cap on PO fetchAll `maxRecords` */
exports.PURCHASE_ORDER_FETCH_ALL_ABS_MAX = 5000;
const PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE = 500;
/** Default page size for GET /purchaseOrder list (non-fetchAll) */
exports.PURCHASE_ORDER_LIST_DEFAULT_LIMIT = 200;
/** Max `limit` query for GET /purchaseOrder list */
exports.PURCHASE_ORDER_LIST_ABS_MAX = 1000;
/**
 * Build NetSuite REST API base URL
 * e.g., 9511322_SB1 → 9511322-sb1.suitetalk.api.netsuite.com
 */
const buildRestApiUrl = () => {
    const accountId = process.env.NS_ACCOUNT_ID;
    if (!accountId)
        throw new Error("NS_ACCOUNT_ID is not set in .env");
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    return `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/record/v1`;
};
/**
 * Build OAuth 1.0a header for NetSuite REST API
 */
const buildOAuthHeader = (url, method) => {
    const oauth = new oauth_1_0a_1.default({
        consumer: {
            key: process.env.NS_CONSUMER_KEY,
            secret: process.env.NS_CONSUMER_SECRET
        },
        signature_method: "HMAC-SHA256",
        hash_function(baseString, key) {
            return crypto_1.default.createHmac("sha256", key).update(baseString).digest("base64");
        },
        realm: process.env.NS_ACCOUNT_ID
    });
    const token = {
        key: process.env.NS_TOKEN_ID,
        secret: process.env.NS_TOKEN_SECRET
    };
    const authData = oauth.authorize({ url, method, data: {} }, token);
    return oauth.toHeader(authData).Authorization;
};
/** Path segment for sales order record (try camelCase first; 404 → lowercase). */
const SALES_ORDER_RECORD_PATH = "salesOrder";
function nsDetailParallelism() {
    return Math.max(1, parseInt(process.env.NS_MAX_CONCURRENT || "4", 10));
}
/** Same semantics as SO/PO routes: details on unless explicitly turned off. */
function restListWantDetails(query) {
    if (!query)
        return true;
    const d = query.details;
    if (d === false || d === 0)
        return false;
    if (typeof d === "string") {
        const s = d.trim().toLowerCase();
        if (s === "false" || s === "0" || s === "no" || s === "off")
            return false;
    }
    return true;
}
/**
 * Turn NetSuite list payload (array, single row, or id→row map) into a row array.
 */
function flattenNetsuiteListPayload(raw) {
    if (raw == null)
        return [];
    if (Array.isArray(raw))
        return raw;
    if (typeof raw !== "object")
        return [];
    const vals = Object.values(raw);
    if (vals.length === 0)
        return [];
    const allPlainObjects = vals.every((v) => v != null && typeof v === "object" && !Array.isArray(v));
    if (allPlainObjects)
        return vals;
    return [raw];
}
/**
 * Parse internal id from list row `links` (e.g. rel=self → .../purchaseorder/327000).
 * Prefers `rel: "self"` over other links.
 */
function extractIdFromNetSuiteRecordLinks(links, recordPathRegex) {
    if (!Array.isArray(links))
        return null;
    const tryHref = (href) => {
        const m1 = href.match(recordPathRegex);
        if (m1?.[1])
            return decodeURIComponent(m1[1]);
        const m2 = href.match(/\/record\/v1\/[^/]+\/([^/?#]+)/i);
        if (m2?.[1])
            return decodeURIComponent(m2[1]);
        return null;
    };
    for (const L of links) {
        if (String(L?.rel || "").toLowerCase() !== "self")
            continue;
        const href = L?.href;
        if (typeof href !== "string")
            continue;
        const id = tryHref(href);
        if (id)
            return id;
    }
    for (const L of links) {
        const href = L?.href;
        if (typeof href !== "string")
            continue;
        const id = tryHref(href);
        if (id)
            return id;
    }
    return null;
}
/** NetSuite list response shape varies; normalize to an array of row objects (shared by all record types). */
function normalizeNetsuiteRecordListResponse(data) {
    if (data == null)
        return [];
    if (Array.isArray(data))
        return data;
    const raw = data.items ??
        data.Items ??
        data.item ??
        data.records ??
        data.Records ??
        data.results ??
        data.Results;
    if (raw === undefined || raw === null)
        return [];
    return flattenNetsuiteListPayload(raw);
}
/** Alias for generic REST record routes (same normalization as SO/PO lists). */
function normalizeRestRecordListItems(data) {
    return normalizeNetsuiteRecordListResponse(data);
}
/**
 * NetSuite list response shape varies; normalize to an array of row objects.
 */
function normalizeSalesOrderListItems(data) {
    return normalizeNetsuiteRecordListResponse(data);
}
/**
 * NetSuite list row: use top-level `id` when present (e.g. "327000"), else `links` (prefer rel=self href).
 */
function extractSalesOrderIdFromListItem(item) {
    if (!item || typeof item !== "object")
        return null;
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "")
        return String(direct).trim();
    return extractIdFromNetSuiteRecordLinks(item.links, /\/(?:salesOrder|salesorder)\/([^/?#]+)/i);
}
/** CamelCase path (fallback if lowercase list/get returns 404). */
const PURCHASE_ORDER_RECORD_PATH = "purchaseOrder";
/** NetSuite often returns self hrefs with lowercase `purchaseorder` — use first for list + detail GET. */
const PURCHASE_ORDER_RECORD_PATH_LOWER = "purchaseorder";
/**
 * NetSuite PO list response shape varies; normalize to an array of row objects.
 */
function normalizePurchaseOrderListItems(data) {
    return normalizeNetsuiteRecordListResponse(data);
}
/**
 * PO list row: top-level `id` (string/number) first, e.g. `"id": "327000"`;
 * if missing, parse `links` (prefer rel=self → .../purchaseorder/327000).
 */
function extractPurchaseOrderIdFromListItem(item) {
    if (!item || typeof item !== "object")
        return null;
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "")
        return String(direct).trim();
    return extractIdFromNetSuiteRecordLinks(item.links, /\/(?:purchaseOrder|purchaseorder)\/([^/?#]+)/i);
}
/**
 * List Sales Orders from NetSuite
 * GET /services/rest/record/v1/salesOrder
 */
const listSalesOrders = async (options) => {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();
    if (options.q)
        params.append("q", options.q);
    const lim = options.limit != null ? Math.max(1, options.limit) : undefined;
    if (lim != null)
        params.append("limit", String(lim));
    const off = options.offset != null ? Math.max(0, options.offset) : 0;
    params.append("offset", String(off));
    if (options.expandSubResources)
        params.append("expandSubResources", options.expandSubResources);
    const queryString = params.toString();
    const url = `${baseUrl}/${SALES_ORDER_RECORD_PATH}${queryString ? `?${queryString}` : ""}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json"
        },
        timeout: 120000
    });
    return response.data;
};
exports.listSalesOrders = listSalesOrders;
async function getSalesOrderWithPath(id, expandSubResources, pathSegment) {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: 60000,
    });
    return response.data;
}
/**
 * Run at most `NS_MAX_CONCURRENT` detail fetches at a time so queued waiters do not hit the
 * 60s concurrency acquire timeout (Promise.all + N×withConcurrency queues all N at once).
 */
async function hydrateSalesOrdersWithWorkerPool(listItems, expandSubResources) {
    if (!listItems.length)
        return [];
    logger_config_1.default.info(`[NS REST] SO hydrate: ${listItems.length} list row(s) → per-id GET (workers≤${nsDetailParallelism()})`);
    const results = new Array(listItems.length);
    const pool = Math.min(nsDetailParallelism(), listItems.length);
    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= listItems.length)
                return;
            const item = listItems[i];
            const idForLabel = extractSalesOrderIdFromListItem(item) || "?";
            results[i] = await (0, concurrency_config_1.withConcurrency)(async () => {
                const id = extractSalesOrderIdFromListItem(item);
                if (!id) {
                    return { _hydrateError: "missing_id", listItem: item };
                }
                try {
                    return await (0, exports.getSalesOrder)(id, expandSubResources);
                }
                catch (err) {
                    logger_config_1.default.error(`[NS REST] Failed to fetch SO ${id}:`, err.message);
                    return {
                        _hydrateError: err?.response?.data
                            ? JSON.stringify(err.response.data)
                            : err?.message || "request_failed",
                        id,
                        listItem: item,
                    };
                }
            }, `SO detail ${idForLabel}`);
        }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()));
    return results;
}
/**
 * For each list row, GET `/record/v1/salesOrder/{id}` (full record). Bounded parallelism.
 */
async function hydrateSalesOrdersFromListRows(listItems, expandSubResources) {
    return hydrateSalesOrdersWithWorkerPool(listItems, expandSubResources);
}
/**
 * Get single Sales Order by ID
 * GET /services/rest/record/v1/salesOrder/{id}
 */
const getSalesOrder = async (id, expandSubResources) => {
    const sid = String(id).trim();
    try {
        return await getSalesOrderWithPath(sid, expandSubResources, SALES_ORDER_RECORD_PATH);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn(`[NS REST] GET salesOrder/${sid} returned 404, retrying path salesorder`);
            return await getSalesOrderWithPath(sid, expandSubResources, "salesorder");
        }
        throw err;
    }
};
exports.getSalesOrder = getSalesOrder;
async function listPurchaseOrdersWithPath(options, pathSegment) {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();
    if (options.q)
        params.append("q", options.q);
    const lim = options.limit != null ? Math.max(1, options.limit) : undefined;
    if (lim != null)
        params.append("limit", String(lim));
    const off = options.offset != null ? Math.max(0, options.offset) : 0;
    params.append("offset", String(off));
    if (options.expandSubResources)
        params.append("expandSubResources", options.expandSubResources);
    const queryString = params.toString();
    const url = `${baseUrl}/${pathSegment}${queryString ? `?${queryString}` : ""}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: 120000,
    });
    return response.data;
}
/**
 * List Purchase Orders — try lowercase path first (matches typical `links[].href`), then camelCase on 404.
 */
const listPurchaseOrders = async (options) => {
    try {
        return await listPurchaseOrdersWithPath(options, PURCHASE_ORDER_RECORD_PATH_LOWER);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn("[NS REST] list purchaseorder 404, retrying purchaseOrder");
            return await listPurchaseOrdersWithPath(options, PURCHASE_ORDER_RECORD_PATH);
        }
        throw err;
    }
};
exports.listPurchaseOrders = listPurchaseOrders;
async function getPurchaseOrderWithPath(id, expandSubResources, pathSegment) {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: 60000,
    });
    return response.data;
}
async function hydratePurchaseOrdersWithWorkerPool(listItems, expandSubResources) {
    if (!listItems.length)
        return [];
    logger_config_1.default.info(`[NS REST] PO hydrate: ${listItems.length} list row(s) → per-id GET (workers≤${nsDetailParallelism()})`);
    const results = new Array(listItems.length);
    const pool = Math.min(nsDetailParallelism(), listItems.length);
    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= listItems.length)
                return;
            const item = listItems[i];
            const idForLabel = extractPurchaseOrderIdFromListItem(item) || "?";
            results[i] = await (0, concurrency_config_1.withConcurrency)(async () => {
                const id = extractPurchaseOrderIdFromListItem(item);
                if (!id) {
                    return { _hydrateError: "missing_id", listItem: item };
                }
                try {
                    return await (0, exports.getPurchaseOrder)(id, expandSubResources);
                }
                catch (err) {
                    logger_config_1.default.error(`[NS REST] Failed to fetch PO ${id}:`, err.message);
                    return {
                        _hydrateError: err?.response?.data
                            ? JSON.stringify(err.response.data)
                            : err?.message || "request_failed",
                        id,
                        listItem: item,
                    };
                }
            }, `PO detail ${idForLabel}`);
        }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()));
    return results;
}
/**
 * For each list row, GET `/record/v1/purchaseOrder/{id}`. Bounded parallelism.
 */
async function hydratePurchaseOrdersFromListRows(listItems, expandSubResources) {
    return hydratePurchaseOrdersWithWorkerPool(listItems, expandSubResources);
}
/**
 * Get single Purchase Order by ID
 * GET /services/rest/record/v1/purchaseOrder/{id}
 */
const getPurchaseOrder = async (id, expandSubResources) => {
    const sid = String(id).trim();
    try {
        return await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH_LOWER);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn(`[NS REST] GET purchaseorder/${sid} 404, retrying purchaseOrder`);
            return await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH);
        }
        throw err;
    }
};
exports.getPurchaseOrder = getPurchaseOrder;
/**
 * Fetch sales orders with full details, up to a capped count.
 * Uses paged list + parallel detail GETs (bounded by shared NetSuite concurrency).
 */
const fetchAllSalesOrders = async (options) => {
    const maxRecords = Math.min(Math.max(1, options.maxRecords ?? exports.SALES_ORDER_FETCH_ALL_DEFAULT_MAX), exports.SALES_ORDER_FETCH_ALL_ABS_MAX);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? SALES_ORDER_FETCH_ALL_PAGE_SIZE), 1000);
    const allRecords = [];
    let offset = 0;
    logger_config_1.default.info(`[NS REST] fetchAllSalesOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
        (options.q ? `, q=present` : ""));
    while (allRecords.length < maxRecords) {
        const remaining = maxRecords - allRecords.length;
        const listLimit = Math.min(pageSize, remaining);
        const data = await (0, exports.listSalesOrders)({
            q: options.q,
            limit: listLimit,
            offset,
            expandSubResources: undefined,
        });
        const items = normalizeSalesOrderListItems(data);
        if (items.length === 0)
            break;
        const slice = items.slice(0, remaining);
        const hydrated = await hydrateSalesOrdersWithWorkerPool(slice, options.expandSubResources);
        const batch = hydrated
            .map((r) => {
            if (!r || typeof r !== "object")
                return null;
            if ("_hydrateError" in r) {
                if (r._hydrateError === "missing_id")
                    return null;
                return r.listItem ?? null;
            }
            return r;
        })
            .filter((r) => r != null);
        allRecords.push(...batch);
        logger_config_1.default.info(`[NS REST] fetchAll page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`);
        if (!data.hasMore)
            break;
        if (items.length < listLimit)
            break;
        offset += items.length;
    }
    logger_config_1.default.info(`[NS REST] fetchAllSalesOrders done — ${allRecords.length} records`);
    return allRecords;
};
exports.fetchAllSalesOrders = fetchAllSalesOrders;
/**
 * Fetch purchase orders with full details, up to a capped count (paged list + worker-pool detail GETs).
 */
const fetchAllPurchaseOrders = async (options) => {
    const maxRecords = Math.min(Math.max(1, options.maxRecords ?? exports.PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX), exports.PURCHASE_ORDER_FETCH_ALL_ABS_MAX);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE), 1000);
    const allRecords = [];
    let offset = 0;
    logger_config_1.default.info(`[NS REST] fetchAllPurchaseOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
        (options.q ? `, q=present` : ""));
    while (allRecords.length < maxRecords) {
        const remaining = maxRecords - allRecords.length;
        const listLimit = Math.min(pageSize, remaining);
        const data = await (0, exports.listPurchaseOrders)({
            q: options.q,
            limit: listLimit,
            offset,
            expandSubResources: undefined,
        });
        const items = normalizePurchaseOrderListItems(data);
        if (items.length === 0)
            break;
        const slice = items.slice(0, remaining);
        const hydrated = await hydratePurchaseOrdersWithWorkerPool(slice, options.expandSubResources);
        const batch = hydrated
            .map((r) => {
            if (!r || typeof r !== "object")
                return null;
            if ("_hydrateError" in r) {
                if (r._hydrateError === "missing_id")
                    return null;
                return r.listItem ?? null;
            }
            return r;
        })
            .filter((r) => r != null);
        allRecords.push(...batch);
        logger_config_1.default.info(`[NS REST] fetchAll PO page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`);
        if (!data.hasMore)
            break;
        if (items.length < listLimit)
            break;
        offset += items.length;
    }
    logger_config_1.default.info(`[NS REST] fetchAllPurchaseOrders done — ${allRecords.length} records`);
    return allRecords;
};
exports.fetchAllPurchaseOrders = fetchAllPurchaseOrders;
// ═══════════════════════════════════════════════════════════════════════════════
// Generic list / GET / hydrate / fetchAll (inventory item, classification, IF, IR)
// ═══════════════════════════════════════════════════════════════════════════════
async function listRestRecordWithPath(pathSegment, options) {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();
    if (options.q)
        params.append("q", options.q);
    const lim = options.limit != null ? Math.max(1, options.limit) : undefined;
    if (lim != null)
        params.append("limit", String(lim));
    const off = options.offset != null ? Math.max(0, options.offset) : 0;
    params.append("offset", String(off));
    if (options.expandSubResources)
        params.append("expandSubResources", options.expandSubResources);
    const queryString = params.toString();
    const url = `${baseUrl}/${pathSegment}${queryString ? `?${queryString}` : ""}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: 120000,
    });
    return response.data;
}
async function getRestRecordWithPath(id, expandSubResources, pathSegment) {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: 60000,
    });
    return response.data;
}
function extractRestRecordIdFromListItem(item, linkPathRegex) {
    if (!item || typeof item !== "object")
        return null;
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "")
        return String(direct).trim();
    return extractIdFromNetSuiteRecordLinks(item.links, linkPathRegex);
}
async function hydrateRestRecordsFromListRows(listItems, expandSubResources, extractId, getRecord, logPrefix) {
    if (!listItems.length)
        return [];
    logger_config_1.default.info(`[NS REST] ${logPrefix} hydrate: ${listItems.length} list row(s) → per-id GET (workers≤${nsDetailParallelism()})`);
    const results = new Array(listItems.length);
    const pool = Math.min(nsDetailParallelism(), listItems.length);
    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= listItems.length)
                return;
            const item = listItems[i];
            const idForLabel = extractId(item) || "?";
            results[i] = await (0, concurrency_config_1.withConcurrency)(async () => {
                const id = extractId(item);
                if (!id) {
                    return { _hydrateError: "missing_id", listItem: item };
                }
                try {
                    return await getRecord(id, expandSubResources);
                }
                catch (err) {
                    logger_config_1.default.error(`[NS REST] ${logPrefix} Failed to fetch ${id}:`, err.message);
                    return {
                        _hydrateError: err?.response?.data
                            ? JSON.stringify(err.response.data)
                            : err?.message || "request_failed",
                        id,
                        listItem: item,
                    };
                }
            }, `${logPrefix} detail ${idForLabel}`);
        }
    }
    await Promise.all(Array.from({ length: pool }, () => worker()));
    return results;
}
async function fetchAllRestRecordsWithDetails(options) {
    const maxRecords = Math.min(Math.max(1, options.maxRecords ?? options.defaultMax), options.absMax);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? options.pageSizeDefault), 1000);
    const allRecords = [];
    let offset = 0;
    logger_config_1.default.info(`[NS REST] fetchAll${options.logLabel} start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
        (options.q ? `, q=present` : ""));
    while (allRecords.length < maxRecords) {
        const remaining = maxRecords - allRecords.length;
        const listLimit = Math.min(pageSize, remaining);
        const data = await options.listFn({
            q: options.q,
            limit: listLimit,
            offset,
            expandSubResources: undefined,
        });
        const items = options.normalizeItems(data);
        if (items.length === 0)
            break;
        const slice = items.slice(0, remaining);
        const hydrated = await hydrateRestRecordsFromListRows(slice, options.expandSubResources, options.extractId, options.getRecord, options.logLabel);
        const batch = hydrated
            .map((r) => {
            if (!r || typeof r !== "object")
                return null;
            if ("_hydrateError" in r) {
                if (r._hydrateError === "missing_id")
                    return null;
                return r.listItem ?? null;
            }
            return r;
        })
            .filter((r) => r != null);
        allRecords.push(...batch);
        logger_config_1.default.info(`[NS REST] fetchAll${options.logLabel} page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`);
        if (!data.hasMore)
            break;
        if (items.length < listLimit)
            break;
        offset += items.length;
    }
    logger_config_1.default.info(`[NS REST] fetchAll${options.logLabel} done — ${allRecords.length} records`);
    return allRecords;
}
async function listRestRecordDualPath(primaryPath, altPath, options) {
    try {
        return await listRestRecordWithPath(primaryPath, options);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn(`[NS REST] list ${primaryPath} 404, retrying ${altPath}`);
            return await listRestRecordWithPath(altPath, options);
        }
        throw err;
    }
}
async function getRestRecordDualPath(id, expandSubResources, primaryPath, altPath) {
    const sid = String(id).trim();
    try {
        return await getRestRecordWithPath(sid, expandSubResources, primaryPath);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn(`[NS REST] GET ${primaryPath}/${sid} 404, retrying ${altPath}`);
            return await getRestRecordWithPath(sid, expandSubResources, altPath);
        }
        throw err;
    }
}
// ─── Inventory Item (REST “items” for sellable stock) ─────────────────────────
exports.INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX = 250;
exports.INVENTORY_ITEM_FETCH_ALL_ABS_MAX = 5000;
const INVENTORY_ITEM_FETCH_ALL_PAGE_SIZE = 500;
exports.INVENTORY_ITEM_LIST_DEFAULT_LIMIT = 200;
exports.INVENTORY_ITEM_LIST_ABS_MAX = 1000;
const INVENTORY_ITEM_PATH = "inventoryItem";
const INVENTORY_ITEM_PATH_LOWER = "inventoryitem";
const INVENTORY_ITEM_LINK_RE = /\/(?:inventoryItem|inventoryitem)\/([^/?#]+)/i;
/**
 * NetSuite list rows often use `id` / `links[].href`.
 * Self links may be `.../inventoryItem/{id}`, `.../item/{id}`, or relative paths without `/record/v1/`.
 */
function extractInventoryItemIdFromListItem(item) {
    const fromStandard = extractRestRecordIdFromListItem(item, INVENTORY_ITEM_LINK_RE);
    if (fromStandard)
        return fromStandard;
    if (!item?.links || !Array.isArray(item.links))
        return null;
    const tryHref = (href) => {
        const decoded = decodeURIComponent(href);
        const mInv = decoded.match(/\/(?:inventoryItem|inventoryitem)\/([^/?#]+)/i) ||
            decoded.match(/(?:^|\/)(?:inventoryItem|inventoryitem)\/([^/?#]+)/i);
        if (mInv?.[1])
            return String(mInv[1]).trim();
        const mItem = decoded.match(/\/(?:item)\/([^/?#]+)/i);
        if (mItem?.[1])
            return String(mItem[1]).trim();
        const mGen = decoded.match(/\/record\/v1\/[^/]+\/([^/?#]+)/i);
        if (mGen?.[1])
            return String(mGen[1]).trim();
        return null;
    };
    for (const L of item.links) {
        if (String(L?.rel || "").toLowerCase() === "self") {
            const href = L?.href;
            if (typeof href === "string") {
                const id = tryHref(href);
                if (id)
                    return id;
            }
        }
    }
    for (const L of item.links) {
        const href = L?.href;
        if (typeof href === "string") {
            const id = tryHref(href);
            if (id)
                return id;
        }
    }
    return null;
}
const listInventoryItems = async (options) => {
    return listRestRecordDualPath(INVENTORY_ITEM_PATH, INVENTORY_ITEM_PATH_LOWER, options);
};
exports.listInventoryItems = listInventoryItems;
const getInventoryItem = async (id, expandSubResources) => {
    return getRestRecordDualPath(String(id).trim(), expandSubResources, INVENTORY_ITEM_PATH, INVENTORY_ITEM_PATH_LOWER);
};
exports.getInventoryItem = getInventoryItem;
async function hydrateInventoryItemsFromListRows(listItems, expandSubResources) {
    return hydrateRestRecordsFromListRows(listItems, expandSubResources, extractInventoryItemIdFromListItem, exports.getInventoryItem, "InventoryItem");
}
const fetchAllInventoryItems = async (options) => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        defaultMax: exports.INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX,
        absMax: exports.INVENTORY_ITEM_FETCH_ALL_ABS_MAX,
        pageSizeDefault: INVENTORY_ITEM_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => (0, exports.listInventoryItems)(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractInventoryItemIdFromListItem,
        getRecord: exports.getInventoryItem,
        logLabel: "InventoryItems",
    });
};
exports.fetchAllInventoryItems = fetchAllInventoryItems;
// ─── Classification (NetSuite “Class”) ──────────────────────────────────────
exports.CLASSIFICATION_FETCH_ALL_DEFAULT_MAX = 250;
exports.CLASSIFICATION_FETCH_ALL_ABS_MAX = 5000;
const CLASSIFICATION_FETCH_ALL_PAGE_SIZE = 500;
exports.CLASSIFICATION_LIST_DEFAULT_LIMIT = 200;
exports.CLASSIFICATION_LIST_ABS_MAX = 1000;
const CLASSIFICATION_PATH = "classification";
const CLASSIFICATION_PATH_LOWER = "classification";
const CLASSIFICATION_LINK_RE = /\/(?:classification)\/([^/?#]+)/i;
function extractClassificationIdFromListItem(item) {
    return extractRestRecordIdFromListItem(item, CLASSIFICATION_LINK_RE);
}
const listClassifications = async (options) => {
    return listRestRecordWithPath(CLASSIFICATION_PATH, options);
};
exports.listClassifications = listClassifications;
const getClassification = async (id, expandSubResources) => {
    return getRestRecordWithPath(String(id).trim(), expandSubResources, CLASSIFICATION_PATH);
};
exports.getClassification = getClassification;
async function hydrateClassificationsFromListRows(listItems, expandSubResources) {
    return hydrateRestRecordsFromListRows(listItems, expandSubResources, extractClassificationIdFromListItem, exports.getClassification, "Classification");
}
const fetchAllClassifications = async (options) => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        defaultMax: exports.CLASSIFICATION_FETCH_ALL_DEFAULT_MAX,
        absMax: exports.CLASSIFICATION_FETCH_ALL_ABS_MAX,
        pageSizeDefault: CLASSIFICATION_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => (0, exports.listClassifications)(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractClassificationIdFromListItem,
        getRecord: exports.getClassification,
        logLabel: "Classifications",
    });
};
exports.fetchAllClassifications = fetchAllClassifications;
// ─── Item Fulfillment ───────────────────────────────────────────────────────
exports.ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX = 250;
exports.ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX = 5000;
const ITEM_FULFILLMENT_FETCH_ALL_PAGE_SIZE = 500;
exports.ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT = 200;
exports.ITEM_FULFILLMENT_LIST_ABS_MAX = 1000;
const ITEM_FULFILLMENT_PATH = "itemFulfillment";
const ITEM_FULFILLMENT_PATH_LOWER = "itemfulfillment";
const ITEM_FULFILLMENT_LINK_RE = /\/(?:itemFulfillment|itemfulfillment)\/([^/?#]+)/i;
function extractItemFulfillmentIdFromListItem(item) {
    return extractRestRecordIdFromListItem(item, ITEM_FULFILLMENT_LINK_RE);
}
const listItemFulfillments = async (options) => {
    return listRestRecordDualPath(ITEM_FULFILLMENT_PATH, ITEM_FULFILLMENT_PATH_LOWER, options);
};
exports.listItemFulfillments = listItemFulfillments;
const getItemFulfillment = async (id, expandSubResources) => {
    return getRestRecordDualPath(String(id).trim(), expandSubResources, ITEM_FULFILLMENT_PATH, ITEM_FULFILLMENT_PATH_LOWER);
};
exports.getItemFulfillment = getItemFulfillment;
async function hydrateItemFulfillmentsFromListRows(listItems, expandSubResources) {
    return hydrateRestRecordsFromListRows(listItems, expandSubResources, extractItemFulfillmentIdFromListItem, exports.getItemFulfillment, "ItemFulfillment");
}
const fetchAllItemFulfillments = async (options) => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        defaultMax: exports.ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX,
        absMax: exports.ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX,
        pageSizeDefault: ITEM_FULFILLMENT_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => (0, exports.listItemFulfillments)(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractItemFulfillmentIdFromListItem,
        getRecord: exports.getItemFulfillment,
        logLabel: "ItemFulfillments",
    });
};
exports.fetchAllItemFulfillments = fetchAllItemFulfillments;
// ─── Item Receipt ─────────────────────────────────────────────────────────────
exports.ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX = 250;
exports.ITEM_RECEIPT_FETCH_ALL_ABS_MAX = 5000;
const ITEM_RECEIPT_FETCH_ALL_PAGE_SIZE = 500;
exports.ITEM_RECEIPT_LIST_DEFAULT_LIMIT = 200;
exports.ITEM_RECEIPT_LIST_ABS_MAX = 1000;
const ITEM_RECEIPT_PATH = "itemReceipt";
const ITEM_RECEIPT_PATH_LOWER = "itemreceipt";
const ITEM_RECEIPT_LINK_RE = /\/(?:itemReceipt|itemreceipt)\/([^/?#]+)/i;
function extractItemReceiptIdFromListItem(item) {
    return extractRestRecordIdFromListItem(item, ITEM_RECEIPT_LINK_RE);
}
const listItemReceipts = async (options) => {
    return listRestRecordDualPath(ITEM_RECEIPT_PATH, ITEM_RECEIPT_PATH_LOWER, options);
};
exports.listItemReceipts = listItemReceipts;
const getItemReceipt = async (id, expandSubResources) => {
    return getRestRecordDualPath(String(id).trim(), expandSubResources, ITEM_RECEIPT_PATH, ITEM_RECEIPT_PATH_LOWER);
};
exports.getItemReceipt = getItemReceipt;
async function hydrateItemReceiptsFromListRows(listItems, expandSubResources) {
    return hydrateRestRecordsFromListRows(listItems, expandSubResources, extractItemReceiptIdFromListItem, exports.getItemReceipt, "ItemReceipt");
}
const fetchAllItemReceipts = async (options) => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        defaultMax: exports.ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX,
        absMax: exports.ITEM_RECEIPT_FETCH_ALL_ABS_MAX,
        pageSizeDefault: ITEM_RECEIPT_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => (0, exports.listItemReceipts)(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractItemReceiptIdFromListItem,
        getRecord: exports.getItemReceipt,
        logLabel: "ItemReceipts",
    });
};
exports.fetchAllItemReceipts = fetchAllItemReceipts;
