"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listVendorBills = exports.fetchAllItemReceipts = exports.getItemReceipt = exports.listItemReceipts = exports.ITEM_RECEIPT_LIST_ABS_MAX = exports.ITEM_RECEIPT_LIST_DEFAULT_LIMIT = exports.ITEM_RECEIPT_FETCH_ALL_ABS_MAX = exports.ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX = exports.fetchAllItemFulfillments = exports.getItemFulfillment = exports.listItemFulfillments = exports.ITEM_FULFILLMENT_LIST_ABS_MAX = exports.ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT = exports.ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX = exports.ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX = exports.fetchAllClassifications = exports.getClassification = exports.listClassifications = exports.CLASSIFICATION_LIST_ABS_MAX = exports.CLASSIFICATION_LIST_DEFAULT_LIMIT = exports.CLASSIFICATION_FETCH_ALL_ABS_MAX = exports.CLASSIFICATION_FETCH_ALL_DEFAULT_MAX = exports.fetchAllInventoryItems = exports.getInventoryItem = exports.listInventoryItems = exports.INVENTORY_ITEM_LIST_ABS_MAX = exports.INVENTORY_ITEM_LIST_DEFAULT_LIMIT = exports.INVENTORY_ITEM_FETCH_ALL_ABS_MAX = exports.INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX = exports.fetchAllPurchaseOrders = exports.fetchAllSalesOrders = exports.getPurchaseOrder = exports.listPurchaseOrders = exports.getSalesOrder = exports.listSalesOrders = exports.buildOAuthHeader = exports.buildRestApiUrl = exports.PURCHASE_ORDER_LIST_ABS_MAX = exports.PURCHASE_ORDER_LIST_DEFAULT_LIMIT = exports.PURCHASE_ORDER_FETCH_ALL_ABS_MAX = exports.PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX = exports.SALES_ORDER_LIST_ABS_MAX = exports.SALES_ORDER_LIST_DEFAULT_LIMIT = exports.SALES_ORDER_FETCH_ALL_ABS_MAX = exports.SALES_ORDER_FETCH_ALL_DEFAULT_MAX = void 0;
exports.nsRestFetchUntilExhaustedCap = nsRestFetchUntilExhaustedCap;
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
exports.normalizeVendorBillListItems = normalizeVendorBillListItems;
exports.extractVendorBillIdFromListItem = extractVendorBillIdFromListItem;
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
const PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE = 100;
/** Default page size for GET /purchaseOrder list (non-fetchAll) */
exports.PURCHASE_ORDER_LIST_DEFAULT_LIMIT = 200;
/** Max `limit` query for GET /purchaseOrder list */
exports.PURCHASE_ORDER_LIST_ABS_MAX = 1000;
/**
 * Max records when `fetchAll*` uses `untilExhausted: true` (pages until a short/empty list or `hasMore === false`).
 * Env `NS_REST_FETCH_UNTIL_EXHAUSTED_CAP` (default 10_000_000, hard max 50_000_000).
 */
function nsRestFetchUntilExhaustedCap() {
    const raw = process.env.NS_REST_FETCH_UNTIL_EXHAUSTED_CAP;
    const n = raw != null && String(raw).trim() !== "" ? parseInt(String(raw), 10) : NaN;
    if (Number.isFinite(n) && n >= 1)
        return Math.min(n, 50000000);
    return 10000000;
}
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
exports.buildRestApiUrl = buildRestApiUrl;
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
exports.buildOAuthHeader = buildOAuthHeader;
/** Path segment for sales order record (try camelCase first; 404 → lowercase). */
const SALES_ORDER_RECORD_PATH = "salesOrder";
function nsDetailParallelism() {
    return Math.max(1, parseInt(process.env.NS_MAX_CONCURRENT || "4", 10));
}
/** Per-id GET /salesOrder/{id} (and PO); default 120s to match {@link nsRestOAuthGetAbsolute}. */
function nsRestRecordGetTimeoutMs() {
    const n = parseInt(process.env.NS_REST_RECORD_GET_TIMEOUT_MS || "120000", 10);
    if (!Number.isFinite(n) || n < 10000)
        return 120000;
    return Math.min(n, 600000);
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
/** OAuth GET for a full SuiteTalk URL (e.g. `links[].href` on a subresource). */
async function nsRestOAuthGetAbsolute(url, timeoutMs = 120000) {
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
            Accept: "application/json",
        },
        timeout: timeoutMs,
    });
    return response.data;
}
function extractSelfLinkHref(links) {
    if (!Array.isArray(links))
        return null;
    for (const L of links) {
        if (String(L?.rel || "").toLowerCase() !== "self")
            continue;
        const method = String(L?.method || "GET").toUpperCase();
        if (method !== "GET")
            continue;
        const href = L?.href;
        if (typeof href === "string" && href.trim() !== "")
            return href.trim();
    }
    return null;
}
/** Sublist/collection subresources reject `limit`/`offset`; page via `rel: "next"` on the response. */
function extractNextLinkHref(links) {
    if (!Array.isArray(links))
        return null;
    for (const L of links) {
        if (String(L?.rel || "").toLowerCase() !== "next")
            continue;
        const method = String(L?.method || "GET").toUpperCase();
        if (method !== "GET")
            continue;
        const href = L?.href;
        if (typeof href === "string" && href.trim() !== "")
            return href.trim();
    }
    return null;
}
const STRIP_NS_LINKS_MAX_DEPTH = 120;
/**
 * Remove every `links` array from a NetSuite REST JSON tree (root, nested refs, line rows).
 * Mutates plain objects in place. Pagination still uses `links` on raw fetch responses before merge.
 */
function stripNetSuiteLinksDeep(value, depth = 0) {
    if (value == null || typeof value !== "object")
        return;
    if (depth > STRIP_NS_LINKS_MAX_DEPTH)
        return;
    if (Array.isArray(value)) {
        for (const el of value) {
            stripNetSuiteLinksDeep(el, depth + 1);
        }
        return;
    }
    const obj = value;
    if ("links" in obj) {
        delete obj.links;
    }
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v != null && typeof v === "object") {
            stripNetSuiteLinksDeep(v, depth + 1);
        }
    }
}
function parseFollowSubresourceKeys(envVal, fallback) {
    const raw = envVal != null && String(envVal).trim() !== "" ? String(envVal) : fallback;
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function isPlainRestObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
/** True when at least one line row is only a link shell (e.g. `{ links: [...] }`) and needs a full sublist GET. */
function lineItemsNeedSublistRefetch(items) {
    if (!Array.isArray(items) || items.length === 0)
        return false;
    return items.some((row) => {
        if (!isPlainRestObject(row))
            return true;
        const keys = Object.keys(row).filter((k) => k !== "links");
        return keys.length === 0;
    });
}
/** `.../salesorder/123/item/456` (line row) — not the sublist collection `.../item`. */
function isTransactionLineItemSelfHref(href, kind) {
    try {
        const path = new URL(href).pathname;
        if (kind === "salesOrder") {
            return /\/(?:salesOrder|salesorder)\/\d+\/item\/[^/]+$/i.test(path);
        }
        return /\/(?:purchaseOrder|purchaseorder)\/\d+\/item\/[^/]+$/i.test(path);
    }
    catch {
        return false;
    }
}
/**
 * Each `item.items[]` row often returns as a link shell. This runs **before** generic deep follow so
 * `NS_REST_DEEP_FOLLOW_MAX_REQUESTS` is not exhausted on currency/entity/etc. before lines are expanded.
 */
async function expandTransactionSublistLineRows(record, kind) {
    const items = record?.item?.items;
    if (!Array.isArray(items) || items.length === 0)
        return;
    const rid = record?.id != null ? String(record.id) : "?";
    if (items.length > 10000) {
        logger_config_1.default.warn(`[NS REST] ${kind} ${rid}: item.items length ${items.length} exceeds cap 10k — truncating line expand`);
    }
    const slice = items.length > 10000 ? items.slice(0, 10000) : items;
    /** Sequential: must not use `withConcurrency` here — list hydrate already holds one global slot per SO. */
    for (let i = 0; i < slice.length; i++) {
        const row = slice[i];
        if (!isPlainRestObject(row))
            continue;
        const href = extractSelfLinkHref(row.links);
        if (!href || !isTransactionLineItemSelfHref(href, kind))
            continue;
        try {
            const data = await nsRestOAuthGetAbsolute(href);
            Object.assign(row, data);
            delete row.links;
        }
        catch (err) {
            logger_config_1.default.warn(`[NS REST] ${kind} ${rid} item.items[${i}] line GET:`, err?.response?.data ?? err?.message ?? err);
            row._lineExpandError =
                err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "request_failed";
        }
    }
}
/**
 * Line GET responses include nested refs (e.g. `item` → inventory) with `links` to full records.
 * We only fetch each line row’s own `.../item/{lineId}` URL in {@link expandTransactionSublistLineRows};
 * strip nested `links` under each row so optional deep follow never GETs full product/inventory payloads.
 */
function stripNetSuiteLinksUnderTransactionLineItems(record) {
    const items = record?.item?.items;
    if (!Array.isArray(items))
        return;
    for (const row of items) {
        stripNetSuiteLinksDeep(row);
    }
}
function deepFollowMaxRequestsPerRecord() {
    const n = parseInt(process.env.NS_REST_DEEP_FOLLOW_MAX_REQUESTS || "250", 10);
    if (!Number.isFinite(n) || n < 1)
        return 250;
    return Math.min(n, 5000);
}
/**
 * Recursive GET of every nested `rel:self` link (custom lists, refs, etc.). Off by default — those URLs
 * often 404 (stale IDs), 403 (role permissions), or 500 (NetSuite). SO/PO still expand item sublist,
 * addresses, and line rows without this flag.
 */
function isDeepFollowSelfLinksEnabled() {
    return process.env.NS_REST_DEEP_FOLLOW_SELF_LINKS === "true";
}
/** When false (default), 401/403/404/429 deep-follow failures log at debug to reduce noise. */
function deepFollowLogAllClientErrors() {
    return process.env.NS_REST_DEEP_FOLLOW_LOG_CLIENT_ERRORS === "true";
}
function logDeepFollowFailure(label, err) {
    const status = err?.response?.status;
    const quietClient = status != null && [401, 403, 404, 429].includes(Number(status)) && !deepFollowLogAllClientErrors();
    const detail = err?.response?.data ?? err?.message ?? err;
    if (quietClient) {
        logger_config_1.default.debug(`[NS REST] deep follow skipped (client error) ${label}:`, detail);
    }
    else {
        logger_config_1.default.warn(`[NS REST] deep follow failed ${label}:`, detail);
    }
}
/** Skip redundant GET of the transaction root (same body as the full record GET). */
function isTransactionalRootSelfHref(href, rootId, kind) {
    if (!rootId || !href)
        return false;
    try {
        const path = new URL(href).pathname.replace(/\/+$/, "");
        const rid = rootId.trim();
        if (!rid)
            return false;
        if (kind === "salesOrder") {
            return /\/(?:salesOrder|salesorder)\/[^/]+$/i.test(path) && path.endsWith(`/${rid}`);
        }
        return /\/(?:purchaseOrder|purchaseorder)\/[^/]+$/i.test(path) && path.endsWith(`/${rid}`);
    }
    catch {
        return false;
    }
}
function looksLikeNetSuitePagedItemsWrapper(data) {
    return data != null && typeof data === "object" && Array.isArray(data.items);
}
/** Paginate a sublist starting from an already-fetched first page (no duplicate GET of `href`). */
async function collectSublistRowsAfterFirstPage(firstPage, label, ctx) {
    const allRows = [...normalizeNetsuiteRecordListResponse(firstPage)];
    let pageUrl = firstPage?.hasMore === true ? extractNextLinkHref(firstPage.links) : null;
    let pages = 1;
    while (pageUrl) {
        if (ctx.requests >= ctx.maxRequests) {
            if (!ctx.cappedLogged) {
                ctx.cappedLogged = true;
                logger_config_1.default.warn(`[NS REST] deep follow: cap NS_REST_DEEP_FOLLOW_MAX_REQUESTS=${ctx.maxRequests} mid-sublist (${label})`);
            }
            break;
        }
        pages++;
        if (pages > 10000) {
            logger_config_1.default.warn(`[NS REST] ${label}: sublist page cap 10k`);
            break;
        }
        ctx.requests++;
        const data = await nsRestOAuthGetAbsolute(pageUrl);
        allRows.push(...normalizeNetsuiteRecordListResponse(data));
        if (allRows.length > 500000) {
            logger_config_1.default.warn(`[NS REST] ${label}: sublist row cap 500k`);
            break;
        }
        if (data?.hasMore !== true)
            break;
        const nextHref = extractNextLinkHref(data.links);
        if (!nextHref) {
            if (allRows.length > 0) {
                logger_config_1.default.warn(`[NS REST] ${label}: hasMore without rel=next`);
            }
            break;
        }
        pageUrl = nextHref;
    }
    return allRows;
}
/**
 * Recursively GET nested `rel:self` objects when {@link isDeepFollowSelfLinksEnabled} is true.
 */
async function deepFollowSelfLinksInValue(value, ctx, depth) {
    if (value == null || depth > 100)
        return;
    if (Array.isArray(value)) {
        /** Sequential walk: avoids nested `withConcurrency` deadlock with SO/PO list workers. */
        for (const el of value) {
            await deepFollowSelfLinksInValue(el, ctx, depth + 1);
        }
        return;
    }
    if (!isPlainRestObject(value))
        return;
    const node = value;
    if (node._hydrateError != null)
        return;
    const href = extractSelfLinkHref(node.links);
    if (href &&
        !isTransactionalRootSelfHref(href, ctx.rootId, ctx.kind) &&
        !node._deepFollowError) {
        if (ctx.requests >= ctx.maxRequests) {
            if (!ctx.cappedLogged) {
                ctx.cappedLogged = true;
                logger_config_1.default.warn(`[NS REST] deep follow: cap NS_REST_DEEP_FOLLOW_MAX_REQUESTS=${ctx.maxRequests} reached for ${ctx.kind} ${ctx.rootId ?? "?"}`);
            }
        }
        else {
            ctx.requests++;
            const label = `deep ${ctx.kind} ${ctx.rootId ?? "?"} #${ctx.requests}`;
            try {
                const data = await nsRestOAuthGetAbsolute(href);
                if (looksLikeNetSuitePagedItemsWrapper(data)) {
                    const allRows = await collectSublistRowsAfterFirstPage(data, label, ctx);
                    Object.assign(node, data, {
                        items: allRows,
                        hasMore: false,
                        count: allRows.length,
                    });
                }
                else {
                    Object.assign(node, data);
                }
                delete node.links;
            }
            catch (err) {
                logDeepFollowFailure(label, err);
                node._deepFollowError =
                    err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "request_failed";
            }
        }
    }
    for (const k of Object.keys(node)) {
        const v = node[k];
        if (v != null && typeof v === "object")
            await deepFollowSelfLinksInValue(v, ctx, depth + 1);
    }
}
async function deepFollowSelfLinksOnRecord(record, kind) {
    if (record == null || typeof record !== "object")
        return;
    if (process.env.NS_REST_FOLLOW_SUBRESOURCE_LINKS === "false")
        return;
    if (!isDeepFollowSelfLinksEnabled())
        return;
    const rootId = record.id != null && String(record.id).trim() !== "" ? String(record.id).trim() : null;
    const ctx = {
        kind,
        rootId,
        requests: 0,
        maxRequests: deepFollowMaxRequestsPerRecord(),
        cappedLogged: false,
    };
    await deepFollowSelfLinksInValue(record, ctx, 0);
}
/**
 * When GET /salesOrder/{id} returns `item` / `shippingAddress` / `billingAddress` as link shells only,
 * follow `rel: "self"` GET hrefs and merge bodies onto the record.
 * Line sublists (`item`): do not append `limit`/`offset` (NetSuite returns INVALID_PARAMETER); page using `rel: "next"` when `hasMore` is true.
 * Then expands each `item.items[]` line via that row’s `rel:self` URL only (`.../item/{lineId}`), then strips nested `links`
 * inside each line (e.g. inventory item) so we do not GET full product records—only the line subresource.
 * Optional: recursively follow other nested `rel:self` links on the **header** record — NS_REST_DEEP_FOLLOW_SELF_LINKS=true (default off).
 * Disable follow: NS_REST_FOLLOW_SUBRESOURCE_LINKS=false
 * Keys: NS_REST_SO_FOLLOW_LINK_KEYS=item,shippingAddress,billingAddress
 * Cap (only when deep follow on): NS_REST_DEEP_FOLLOW_MAX_REQUESTS=250
 * Verbose logs for 401/403/404/429 on deep follow: NS_REST_DEEP_FOLLOW_LOG_CLIENT_ERRORS=true
 */
async function hydrateGenericRestRecordFollowLinkSubresources(record, label, envKey, defaultKeys, options = {}) {
    if (record == null || typeof record !== "object")
        return record;
    if (process.env.NS_REST_FOLLOW_SUBRESOURCE_LINKS === "false") {
        stripNetSuiteLinksDeep(record);
        return record;
    }
    const keys = parseFollowSubresourceKeys(envKey, defaultKeys);
    for (const key of keys) {
        const sub = record[key];
        if (sub == null || typeof sub !== "object" || Array.isArray(sub)) {
            logger_config_1.default.debug(`[NS REST] ${label} hydrate skip "${key}": null/non-object/array`);
            continue;
        }
        const href = extractSelfLinkHref(sub.links);
        if (!href) {
            const hasLinks = Array.isArray(sub.links);
            logger_config_1.default.debug(`[NS REST] ${label} hydrate skip "${key}": no self-link href. hasLinks=${hasLinks}, links=${JSON.stringify(sub.links ?? null).slice(0, 200)}`);
            continue;
        }
        if (key === "item" &&
            Array.isArray(sub.items) &&
            sub.items.length > 0 &&
            !lineItemsNeedSublistRefetch(sub.items)) {
            continue;
        }
        logger_config_1.default.info(`[NS REST] ${label} hydrate "${key}" → GET ${href}`);
        try {
            const data = await nsRestOAuthGetAbsolute(href);
            // If the response looks like a NetSuite collection (paged items)
            if (looksLikeNetSuitePagedItemsWrapper(data)) {
                const allRows = await collectSublistRowsAfterFirstPage(data, `${label} ${key}`, {
                    kind: "salesOrder",
                    rootId: record.id,
                    requests: 0,
                    maxRequests: 1000,
                    cappedLogged: false
                });
                logger_config_1.default.info(`[NS REST] ${label} hydrate "${key}" → collection, count=${allRows.length}`);
                record[key] = {
                    ...sub,
                    ...data,
                    items: allRows,
                    hasMore: false,
                    count: allRows.length,
                };
            }
            else {
                logger_config_1.default.info(`[NS REST] ${label} hydrate "${key}" → object, keys=[${Object.keys(data ?? {}).join(",")}]`);
                record[key] = { ...sub, ...data };
            }
            delete record[key].links;
        }
        catch (err) {
            logger_config_1.default.warn(`[NS REST] ${label} follow subresource "${key}" failed:`, err?.response?.data ?? err?.message ?? err);
            record[key] = {
                ...sub,
                _followLinkError: err?.response?.data
                    ? JSON.stringify(err.response.data)
                    : err?.message || "request_failed",
            };
        }
    }
    if (options.deepFollowKind) {
        await expandTransactionSublistLineRows(record, options.deepFollowKind);
        stripNetSuiteLinksUnderTransactionLineItems(record);
        await deepFollowSelfLinksOnRecord(record, options.deepFollowKind);
    }
    stripNetSuiteLinksDeep(record);
    return record;
}
/**
 * When GET /salesOrder/{id} returns `item` / `shippingAddress` / `billingAddress` as link shells only,
 * follow `rel: "self"` GET hrefs and merge bodies onto the record.
 */
async function hydrateSalesOrderFollowLinkSubresources(record) {
    return hydrateGenericRestRecordFollowLinkSubresources(record, "SO", process.env.NS_REST_SO_FOLLOW_LINK_KEYS, "item,shippingAddress,billingAddress", { deepFollowKind: "salesOrder" });
}
async function hydratePurchaseOrderFollowLinkSubresources(record) {
    return hydrateGenericRestRecordFollowLinkSubresources(record, "PO", process.env.NS_REST_PO_FOLLOW_LINK_KEYS, "item,shippingAddress,billingAddress", { deepFollowKind: "purchaseOrder" });
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
    const baseUrl = (0, exports.buildRestApiUrl)();
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
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
            Accept: "application/json"
        },
        timeout: 120000
    });
    return response.data;
};
exports.listSalesOrders = listSalesOrders;
async function getSalesOrderWithPath(id, expandSubResources, pathSegment) {
    const baseUrl = (0, exports.buildRestApiUrl)();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
            Accept: "application/json",
        },
        timeout: nsRestRecordGetTimeoutMs(),
    });
    return response.data;
}
/**
 * Run at most `NS_MAX_CONCURRENT` full-record fetches at a time.
 * Sub-requests inside {@link getSalesOrder} (line expand, deep follow) must not call {@link withConcurrency}
 * or they deadlock: every slot stays held by this outer job until the inner acquire times out (60s).
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
                    logger_config_1.default.error(`[NS REST] Failed to fetch SO ${id} (main GET or uncaught hydration):`, err?.code ?? "", `HTTP ${err?.response?.status ?? "?"}`, err?.response?.data ?? err?.message ?? err);
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
 * {@link getSalesOrder} already runs link follow, line expand, deep follow, and strip — no second pass.
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
    let data;
    try {
        data = await getSalesOrderWithPath(sid, expandSubResources, SALES_ORDER_RECORD_PATH);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn(`[NS REST] GET salesOrder/${sid} returned 404, retrying path salesorder`);
            data = await getSalesOrderWithPath(sid, expandSubResources, "salesorder");
        }
        else {
            throw err;
        }
    }
    try {
        return await hydrateSalesOrderFollowLinkSubresources(data);
    }
    catch (err) {
        logger_config_1.default.warn(`[NS REST] SO ${sid} link/line hydration threw (returning main GET body):`, err?.response?.status, err?.response?.data ?? err?.message ?? err);
        try {
            stripNetSuiteLinksDeep(data);
        }
        catch {
            /* ignore */
        }
        return {
            ...data,
            id: data?.id ?? sid,
            _hydrateError: err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "hydration_failed",
        };
    }
};
exports.getSalesOrder = getSalesOrder;
async function listPurchaseOrdersWithPath(options, pathSegment) {
    const baseUrl = (0, exports.buildRestApiUrl)();
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
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
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
    const baseUrl = (0, exports.buildRestApiUrl)();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
            Accept: "application/json",
        },
        timeout: nsRestRecordGetTimeoutMs(),
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
                    const safeErrStr = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
                    logger_config_1.default.error(`[NS REST] Failed to fetch PO ${id} (main GET or uncaught hydration): HTTP ${err?.response?.status ?? "?"} - ${safeErrStr}`);
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
 * {@link getPurchaseOrder} already runs full hydration — no second pass.
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
    let data;
    try {
        data = await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH_LOWER);
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404) {
            logger_config_1.default.warn(`[NS REST] GET purchaseorder/${sid} 404, retrying purchaseOrder`);
            data = await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH);
        }
        else {
            throw err;
        }
    }
    try {
        return await hydratePurchaseOrderFollowLinkSubresources(data);
    }
    catch (err) {
        logger_config_1.default.warn(`[NS REST] PO ${sid} link/line hydration threw (returning main GET body):`, err?.response?.status, err?.response?.data ?? err?.message ?? err);
        try {
            stripNetSuiteLinksDeep(data);
        }
        catch {
            /* ignore */
        }
        return {
            ...data,
            id: data?.id ?? sid,
            _hydrateError: err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "hydration_failed",
        };
    }
};
exports.getPurchaseOrder = getPurchaseOrder;
/**
 * Fetch sales orders with full details, up to a capped count.
 * Uses paged list + parallel detail GETs (bounded by shared NetSuite concurrency).
 */
const fetchAllSalesOrders = async (options) => {
    const untilExhausted = options.untilExhausted === true;
    const maxRecords = untilExhausted
        ? nsRestFetchUntilExhaustedCap()
        : Math.min(Math.max(1, options.maxRecords ?? exports.SALES_ORDER_FETCH_ALL_DEFAULT_MAX), exports.SALES_ORDER_FETCH_ALL_ABS_MAX);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? SALES_ORDER_FETCH_ALL_PAGE_SIZE), 1000);
    const allRecords = [];
    let offset = options.offset != null && Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
    logger_config_1.default.info(`[NS REST] fetchAllSalesOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
        (untilExhausted ? ", untilExhausted=true" : "") +
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
        if (untilExhausted) {
            if (data.hasMore === false)
                break;
            if (items.length < listLimit)
                break;
        }
        else {
            if (!data.hasMore)
                break;
            if (items.length < listLimit)
                break;
        }
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
    const untilExhausted = options.untilExhausted === true;
    const maxRecords = untilExhausted
        ? nsRestFetchUntilExhaustedCap()
        : Math.min(Math.max(1, options.maxRecords ?? exports.PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX), exports.PURCHASE_ORDER_FETCH_ALL_ABS_MAX);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE), 1000);
    const allRecords = [];
    let offset = 0;
    logger_config_1.default.info(`[NS REST] fetchAllPurchaseOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
        (untilExhausted ? ", untilExhausted=true" : "") +
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
        if (untilExhausted) {
            if (data.hasMore === false)
                break;
            if (items.length < listLimit)
                break;
        }
        else {
            if (!data.hasMore)
                break;
            if (items.length < listLimit)
                break;
        }
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
    const baseUrl = (0, exports.buildRestApiUrl)();
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
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
            Accept: "application/json",
        },
        timeout: 120000,
    });
    return response.data;
}
async function getRestRecordWithPath(id, expandSubResources, pathSegment) {
    const baseUrl = (0, exports.buildRestApiUrl)();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;
    logger_config_1.default.info(`[NS REST] GET ${url}`);
    const response = await axios_1.default.get(url, {
        headers: {
            Authorization: (0, exports.buildOAuthHeader)(url, "GET"),
            Accept: "application/json",
        },
        timeout: nsRestRecordGetTimeoutMs(),
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
    const untilExhausted = options.untilExhausted === true;
    const maxRecords = untilExhausted
        ? nsRestFetchUntilExhaustedCap()
        : Math.min(Math.max(1, options.maxRecords ?? options.defaultMax), options.absMax);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? options.pageSizeDefault), 1000);
    const allRecords = [];
    let offset = options.offset || 0;
    logger_config_1.default.info(`[NS REST] fetchAll${options.logLabel} start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
        (untilExhausted ? ", untilExhausted=true" : "") +
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
        if (options.onBatch && batch.length > 0) {
            try {
                await options.onBatch(batch);
            }
            catch (err) {
                logger_config_1.default.error(`[NS REST] fetchAll${options.logLabel} onBatch callback failed:`, err.message);
            }
        }
        logger_config_1.default.info(`[NS REST] fetchAll${options.logLabel} page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`);
        if (untilExhausted) {
            if (data.hasMore === false)
                break;
            if (items.length < listLimit)
                break;
        }
        else {
            if (!data.hasMore)
                break;
            if (items.length < listLimit)
                break;
        }
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
/**
 * After collecting all rows from a sublist collection, expand any link-shell rows
 * (rows that only have `links` but no real fields) by GETting their self-link href.
 */
async function expandSublistLinkShellRows(rows, label) {
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!isPlainRestObject(row))
            continue;
        // A link shell has no keys other than "links"
        const nonLinkKeys = Object.keys(row).filter((k) => k !== "links");
        if (nonLinkKeys.length > 0)
            continue; // Already has data
        const href = extractSelfLinkHref(row.links);
        if (!href)
            continue;
        try {
            const data = await nsRestOAuthGetAbsolute(href);
            Object.assign(row, data);
            delete row.links;
            logger_config_1.default.debug(`[NS REST] ${label} row[${i}] expanded OK`);
        }
        catch (err) {
            const status = err?.response?.status;
            logger_config_1.default.warn(`[NS REST] ${label} row[${i}] expand failed (${status}):`, err?.response?.data ?? err?.message);
            row._rowExpandError = err?.message || "request_failed";
        }
    }
}
/**
 * Fetches a known NetSuite sublist collection by constructing the URL directly,
 * then expands any link-shell rows via per-row GET.
 * e.g. GET .../inventoryItem/{id}/locations → expand each row
 */
async function fetchNsSublistByDirectUrl(recordPath, recordId, sublistName, label) {
    const baseUrl = (0, exports.buildRestApiUrl)();
    const url = `${baseUrl}/${recordPath}/${encodeURIComponent(recordId)}/${sublistName}`;
    logger_config_1.default.info(`[NS REST] ${label} fetching sublist "${sublistName}" → GET ${url}`);
    try {
        const data = await nsRestOAuthGetAbsolute(url);
        if (!data)
            return null;
        if (looksLikeNetSuitePagedItemsWrapper(data)) {
            const ctx = {
                kind: "salesOrder",
                rootId: recordId,
                requests: 0,
                maxRequests: 2000,
                cappedLogged: false,
            };
            const allRows = await collectSublistRowsAfterFirstPage(data, `${label} ${sublistName}`, ctx);
            // Expand each row that is just a link shell
            await expandSublistLinkShellRows(allRows, `${label} ${sublistName}`);
            logger_config_1.default.info(`[NS REST] ${label} sublist "${sublistName}" → ${allRows.length} rows (expanded)`);
            return allRows;
        }
        // Not a collection — return single item as array
        return [data];
    }
    catch (err) {
        const status = err?.response?.status;
        if (status === 404 || status === 403) {
            logger_config_1.default.debug(`[NS REST] ${label} sublist "${sublistName}" → ${status} (skipped)`);
        }
        else {
            logger_config_1.default.warn(`[NS REST] ${label} sublist "${sublistName}" fetch failed:`, err?.response?.data ?? err?.message);
        }
        return null;
    }
}
// Known sublists for inventory items that must be fetched separately
const INVENTORY_ITEM_SUBLISTS = [
    "locations",
    "price",
    "itemVendor",
    "subsidiary",
    "binNumber",
    "translations",
    "itemOptions",
    "custitem1",
];
async function hydrateInventoryItemFollowLinkSubresources(record) {
    if (!record || typeof record !== "object")
        return record;
    const id = String(record.id ?? "").trim();
    if (!id)
        return record;
    for (const sublist of INVENTORY_ITEM_SUBLISTS) {
        const rows = await fetchNsSublistByDirectUrl(INVENTORY_ITEM_PATH, id, sublist, "InventoryItem");
        if (rows !== null) {
            record[sublist] = { items: rows, count: rows.length };
        }
    }
    // Strip all remaining links from the record (reference fields already have id/refName)
    stripNetSuiteLinksDeep(record);
    return record;
}
const getInventoryItem = async (id, expandSubResources) => {
    const sid = String(id).trim();
    const data = await getRestRecordDualPath(sid, expandSubResources, INVENTORY_ITEM_PATH, INVENTORY_ITEM_PATH_LOWER);
    return hydrateInventoryItemFollowLinkSubresources(data);
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
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
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
    const sid = String(id).trim();
    // For Classifications, NetSuite requires expandSubResources=true to see subsidiary/translations
    const expand = expandSubResources || "true";
    const data = await getRestRecordWithPath(sid, expand, CLASSIFICATION_PATH);
    stripNetSuiteLinksDeep(data);
    return data;
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
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
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
exports.ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX = 10000;
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
// Known sublists for item fulfillments that must be fetched separately
const ITEM_FULFILLMENT_SUBLISTS = ["item"];
async function hydrateItemFulfillmentFollowLinkSubresources(record) {
    if (!record || typeof record !== "object")
        return record;
    const id = String(record.id ?? "").trim();
    if (!id)
        return record;
    for (const sublist of ITEM_FULFILLMENT_SUBLISTS) {
        const rows = await fetchNsSublistByDirectUrl(ITEM_FULFILLMENT_PATH, id, sublist, "ItemFulfillment");
        if (rows !== null) {
            record[sublist] = { items: rows, count: rows.length };
        }
    }
    stripNetSuiteLinksDeep(record);
    return record;
}
const getItemFulfillment = async (id, expandSubResources) => {
    const sid = String(id).trim();
    const data = await getRestRecordDualPath(sid, expandSubResources, ITEM_FULFILLMENT_PATH, ITEM_FULFILLMENT_PATH_LOWER);
    return hydrateItemFulfillmentFollowLinkSubresources(data);
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
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
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
// Known sublists for item receipts that must be fetched separately
const ITEM_RECEIPT_SUBLISTS = ["item"];
async function hydrateItemReceiptFollowLinkSubresources(record) {
    if (!record || typeof record !== "object")
        return record;
    const id = String(record.id ?? "").trim();
    if (!id)
        return record;
    for (const sublist of ITEM_RECEIPT_SUBLISTS) {
        const rows = await fetchNsSublistByDirectUrl(ITEM_RECEIPT_PATH, id, sublist, "ItemReceipt");
        if (rows !== null) {
            record[sublist] = { items: rows, count: rows.length };
        }
    }
    stripNetSuiteLinksDeep(record);
    return record;
}
const getItemReceipt = async (id, expandSubResources) => {
    const sid = String(id).trim();
    const data = await getRestRecordDualPath(sid, expandSubResources, ITEM_RECEIPT_PATH, ITEM_RECEIPT_PATH_LOWER);
    return hydrateItemReceiptFollowLinkSubresources(data);
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
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
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
// ─── Vendor Bill ──────────────────────────────────────────────────────────────
const listVendorBills = async (options) => {
    return listRestRecordWithPath("vendorBill", options);
};
exports.listVendorBills = listVendorBills;
function normalizeVendorBillListItems(data) {
    return normalizeRestRecordListItems(data);
}
function extractVendorBillIdFromListItem(item) {
    const VENDOR_BILL_LINK_RE = /\/(?:vendorBill|vendorbill)\/([^/?#]+)/i;
    return extractRestRecordIdFromListItem(item, VENDOR_BILL_LINK_RE);
}
