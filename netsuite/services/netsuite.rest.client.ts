import axios from "axios";
import crypto from "crypto";
import OAuth from "oauth-1.0a";
import log from "../config/logger.config";
import { withConcurrency } from "../config/concurrency.config";

/** Default max sales orders returned by fetchAll when `maxRecords` is omitted */
export const SALES_ORDER_FETCH_ALL_DEFAULT_MAX = 250;
/** Hard cap on fetchAll `maxRecords` (query cannot exceed this) */
export const SALES_ORDER_FETCH_ALL_ABS_MAX = 5_000;
/** Page size for list requests inside fetchAll (NetSuite list limit is typically ≤1000) */
const SALES_ORDER_FETCH_ALL_PAGE_SIZE = 500;

/** Default page size for GET /salesOrder list (non-fetchAll) */
export const SALES_ORDER_LIST_DEFAULT_LIMIT = 200;
/** Max `limit` query for GET /salesOrder list */
export const SALES_ORDER_LIST_ABS_MAX = 1_000;

/** Default max POs returned by fetchAll when `maxRecords` is omitted */
export const PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX = 250;
/** Hard cap on PO fetchAll `maxRecords` */
export const PURCHASE_ORDER_FETCH_ALL_ABS_MAX = 5_000;
const PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE = 100;
/** Default page size for GET /purchaseOrder list (non-fetchAll) */
export const PURCHASE_ORDER_LIST_DEFAULT_LIMIT = 200;
/** Max `limit` query for GET /purchaseOrder list */
export const PURCHASE_ORDER_LIST_ABS_MAX = 1_000;

/**
 * Max records when `fetchAll*` uses `untilExhausted: true` (pages until a short/empty list or `hasMore === false`).
 * Env `NS_REST_FETCH_UNTIL_EXHAUSTED_CAP` (default 10_000_000, hard max 50_000_000).
 */
export function nsRestFetchUntilExhaustedCap(): number {
    const raw = process.env.NS_REST_FETCH_UNTIL_EXHAUSTED_CAP;
    const n = raw != null && String(raw).trim() !== "" ? parseInt(String(raw), 10) : NaN;
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 50_000_000);
    return 10_000_000;
}

/**
 * Build NetSuite REST API base URL
 * e.g., 9511322_SB1 → 9511322-sb1.suitetalk.api.netsuite.com
 */
export const buildRestApiUrl = (): string => {
    const accountId = process.env.NS_ACCOUNT_ID;
    if (!accountId) throw new Error("NS_ACCOUNT_ID is not set in .env");
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    return `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/record/v1`;
};

/**
 * Build OAuth 1.0a header for NetSuite REST API
 */
export const buildOAuthHeader = (url: string, method: string): string => {
    const oauth = new OAuth({
        consumer: {
            key: process.env.NS_CONSUMER_KEY!,
            secret: process.env.NS_CONSUMER_SECRET!
        },
        signature_method: "HMAC-SHA256",
        hash_function(baseString: string, key: string) {
            return crypto.createHmac("sha256", key).update(baseString).digest("base64");
        },
        realm: process.env.NS_ACCOUNT_ID!
    });

    const token = {
        key: process.env.NS_TOKEN_ID!,
        secret: process.env.NS_TOKEN_SECRET!
    };

    const authData = oauth.authorize({ url, method, data: {} }, token);
    return oauth.toHeader(authData).Authorization;
};

/** Path segment for sales order record (try camelCase first; 404 → lowercase). */
const SALES_ORDER_RECORD_PATH = "salesOrder";

function nsDetailParallelism(): number {
    return Math.max(1, parseInt(process.env.NS_MAX_CONCURRENT || "4", 10));
}

/** Per-id GET /salesOrder/{id} (and PO); default 120s to match {@link nsRestOAuthGetAbsolute}. */
function nsRestRecordGetTimeoutMs(): number {
    const n = parseInt(process.env.NS_REST_RECORD_GET_TIMEOUT_MS || "120000", 10);
    if (!Number.isFinite(n) || n < 10_000) return 120_000;
    return Math.min(n, 600_000);
}

/** Same semantics as SO/PO routes: details on unless explicitly turned off. */
export function restListWantDetails(query: any): boolean {
    if (!query) return true;
    const d = query.details;
    if (d === false || d === 0) return false;
    if (typeof d === "string") {
        const s = d.trim().toLowerCase();
        if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    }
    return true;
}

/**
 * Turn NetSuite list payload (array, single row, or id→row map) into a row array.
 */
function flattenNetsuiteListPayload(raw: unknown): any[] {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== "object") return [];
    const vals = Object.values(raw as Record<string, unknown>);
    if (vals.length === 0) return [];
    const allPlainObjects = vals.every(
        (v) => v != null && typeof v === "object" && !Array.isArray(v)
    );
    if (allPlainObjects) return vals as any[];
    return [raw];
}

/**
 * Parse internal id from list row `links` (e.g. rel=self → .../purchaseorder/327000).
 * Prefers `rel: "self"` over other links.
 */
function extractIdFromNetSuiteRecordLinks(links: any, recordPathRegex: RegExp): string | null {
    if (!Array.isArray(links)) return null;

    const tryHref = (href: string): string | null => {
        const m1 = href.match(recordPathRegex);
        if (m1?.[1]) return decodeURIComponent(m1[1]);
        const m2 = href.match(/\/record\/v1\/[^/]+\/([^/?#]+)/i);
        if (m2?.[1]) return decodeURIComponent(m2[1]);
        return null;
    };

    for (const L of links) {
        if (String(L?.rel || "").toLowerCase() !== "self") continue;
        const href = L?.href;
        if (typeof href !== "string") continue;
        const id = tryHref(href);
        if (id) return id;
    }
    for (const L of links) {
        const href = L?.href;
        if (typeof href !== "string") continue;
        const id = tryHref(href);
        if (id) return id;
    }
    return null;
}

/** NetSuite list response shape varies; normalize to an array of row objects (shared by all record types). */
function normalizeNetsuiteRecordListResponse(data: any): any[] {
    if (data == null) return [];
    if (Array.isArray(data)) return data;
    const raw =
        data.items ??
        data.Items ??
        data.item ??
        data.records ??
        data.Records ??
        data.results ??
        data.Results;
    if (raw === undefined || raw === null) return [];
    return flattenNetsuiteListPayload(raw);
}

/** Alias for generic REST record routes (same normalization as SO/PO lists). */
export function normalizeRestRecordListItems(data: any): any[] {
    return normalizeNetsuiteRecordListResponse(data);
}

/**
 * NetSuite list response shape varies; normalize to an array of row objects.
 */
export function normalizeSalesOrderListItems(data: any): any[] {
    return normalizeNetsuiteRecordListResponse(data);
}

/** OAuth GET for a full SuiteTalk URL (e.g. `links[].href` on a subresource). */
async function nsRestOAuthGetAbsolute(url: string, timeoutMs = 120_000): Promise<any> {
    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: timeoutMs,
    });
    return response.data;
}

function extractSelfLinkHref(links: unknown): string | null {
    if (!Array.isArray(links)) return null;
    for (const L of links) {
        if (String(L?.rel || "").toLowerCase() !== "self") continue;
        const method = String(L?.method || "GET").toUpperCase();
        if (method !== "GET") continue;
        const href = L?.href;
        if (typeof href === "string" && href.trim() !== "") return href.trim();
    }
    return null;
}

/** Sublist/collection subresources reject `limit`/`offset`; page via `rel: "next"` on the response. */
function extractNextLinkHref(links: unknown): string | null {
    if (!Array.isArray(links)) return null;
    for (const L of links) {
        if (String(L?.rel || "").toLowerCase() !== "next") continue;
        const method = String(L?.method || "GET").toUpperCase();
        if (method !== "GET") continue;
        const href = L?.href;
        if (typeof href === "string" && href.trim() !== "") return href.trim();
    }
    return null;
}

const STRIP_NS_LINKS_MAX_DEPTH = 120;

/**
 * Remove every `links` array from a NetSuite REST JSON tree (root, nested refs, line rows).
 * Mutates plain objects in place. Pagination still uses `links` on raw fetch responses before merge.
 */
function stripNetSuiteLinksDeep(value: unknown, depth = 0): void {
    if (value == null || typeof value !== "object") return;
    if (depth > STRIP_NS_LINKS_MAX_DEPTH) return;

    if (Array.isArray(value)) {
        for (const el of value) {
            stripNetSuiteLinksDeep(el, depth + 1);
        }
        return;
    }

    const obj = value as Record<string, unknown>;
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

function parseFollowSubresourceKeys(envVal: string | undefined, fallback: string): string[] {
    const raw = envVal != null && String(envVal).trim() !== "" ? String(envVal) : fallback;
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function isPlainRestObject(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

/** True when at least one line row is only a link shell (e.g. `{ links: [...] }`) and needs a full sublist GET. */
function lineItemsNeedSublistRefetch(items: unknown): boolean {
    if (!Array.isArray(items) || items.length === 0) return false;
    return items.some((row) => {
        if (!isPlainRestObject(row)) return true;
        const keys = Object.keys(row).filter((k) => k !== "links");
        return keys.length === 0;
    });
}

type DeepFollowRecordKind = "salesOrder" | "purchaseOrder";

/** `.../salesorder/123/item/456` (line row) — not the sublist collection `.../item`. */
function isTransactionLineItemSelfHref(href: string, kind: DeepFollowRecordKind): boolean {
    try {
        const path = new URL(href).pathname;
        if (kind === "salesOrder") {
            return /\/(?:salesOrder|salesorder)\/\d+\/item\/[^/]+$/i.test(path);
        }
        return /\/(?:purchaseOrder|purchaseorder)\/\d+\/item\/[^/]+$/i.test(path);
    } catch {
        return false;
    }
}

/**
 * Each `item.items[]` row often returns as a link shell. This runs **before** generic deep follow so
 * `NS_REST_DEEP_FOLLOW_MAX_REQUESTS` is not exhausted on currency/entity/etc. before lines are expanded.
 */
async function expandTransactionSublistLineRows(record: any, kind: DeepFollowRecordKind): Promise<void> {
    const items = record?.item?.items;
    if (!Array.isArray(items) || items.length === 0) return;
    const rid = record?.id != null ? String(record.id) : "?";
    if (items.length > 10_000) {
        log.warn(`[NS REST] ${kind} ${rid}: item.items length ${items.length} exceeds cap 10k — truncating line expand`);
    }
    const slice = items.length > 10_000 ? items.slice(0, 10_000) : items;

    /** Sequential: must not use `withConcurrency` here — list hydrate already holds one global slot per SO. */
    for (let i = 0; i < slice.length; i++) {
        const row = slice[i];
        if (!isPlainRestObject(row)) continue;
        const href = extractSelfLinkHref(row.links);
        if (!href || !isTransactionLineItemSelfHref(href, kind)) continue;
        try {
            const data = await nsRestOAuthGetAbsolute(href);
            Object.assign(row, data);
            delete row.links;
        } catch (err: any) {
            log.warn(
                `[NS REST] ${kind} ${rid} item.items[${i}] line GET:`,
                err?.response?.data ?? err?.message ?? err
            );
            (row as any)._lineExpandError =
                err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "request_failed";
        }
    }
}

/**
 * Line GET responses include nested refs (e.g. `item` → inventory) with `links` to full records.
 * We only fetch each line row’s own `.../item/{lineId}` URL in {@link expandTransactionSublistLineRows};
 * strip nested `links` under each row so optional deep follow never GETs full product/inventory payloads.
 */
function stripNetSuiteLinksUnderTransactionLineItems(record: any): void {
    const items = record?.item?.items;
    if (!Array.isArray(items)) return;
    for (const row of items) {
        stripNetSuiteLinksDeep(row);
    }
}

type DeepFollowCtx = {
    kind: DeepFollowRecordKind;
    rootId: string | null;
    requests: number;
    maxRequests: number;
    cappedLogged: boolean;
};

function deepFollowMaxRequestsPerRecord(): number {
    const n = parseInt(process.env.NS_REST_DEEP_FOLLOW_MAX_REQUESTS || "250", 10);
    if (!Number.isFinite(n) || n < 1) return 250;
    return Math.min(n, 5_000);
}

/**
 * Recursive GET of every nested `rel:self` link (custom lists, refs, etc.). Off by default — those URLs
 * often 404 (stale IDs), 403 (role permissions), or 500 (NetSuite). SO/PO still expand item sublist,
 * addresses, and line rows without this flag.
 */
function isDeepFollowSelfLinksEnabled(): boolean {
    return process.env.NS_REST_DEEP_FOLLOW_SELF_LINKS === "true";
}

/** When false (default), 401/403/404/429 deep-follow failures log at debug to reduce noise. */
function deepFollowLogAllClientErrors(): boolean {
    return process.env.NS_REST_DEEP_FOLLOW_LOG_CLIENT_ERRORS === "true";
}

function logDeepFollowFailure(label: string, err: any): void {
    const status = err?.response?.status;
    const quietClient =
        status != null && [401, 403, 404, 429].includes(Number(status)) && !deepFollowLogAllClientErrors();
    const detail = err?.response?.data ?? err?.message ?? err;
    if (quietClient) {
        log.debug(`[NS REST] deep follow skipped (client error) ${label}:`, detail);
    } else {
        log.warn(`[NS REST] deep follow failed ${label}:`, detail);
    }
}

/** Skip redundant GET of the transaction root (same body as the full record GET). */
function isTransactionalRootSelfHref(href: string, rootId: string | null, kind: DeepFollowRecordKind): boolean {
    if (!rootId || !href) return false;
    try {
        const path = new URL(href).pathname.replace(/\/+$/, "");
        const rid = rootId.trim();
        if (!rid) return false;
        if (kind === "salesOrder") {
            return /\/(?:salesOrder|salesorder)\/[^/]+$/i.test(path) && path.endsWith(`/${rid}`);
        }
        return /\/(?:purchaseOrder|purchaseorder)\/[^/]+$/i.test(path) && path.endsWith(`/${rid}`);
    } catch {
        return false;
    }
}

function looksLikeNetSuitePagedItemsWrapper(data: any): boolean {
    return data != null && typeof data === "object" && Array.isArray(data.items);
}

/** Paginate a sublist starting from an already-fetched first page (no duplicate GET of `href`). */
async function collectSublistRowsAfterFirstPage(
    firstPage: any,
    label: string,
    ctx: DeepFollowCtx
): Promise<any[]> {
    const allRows: any[] = [...normalizeNetsuiteRecordListResponse(firstPage)];
    let pageUrl: string | null =
        firstPage?.hasMore === true ? extractNextLinkHref(firstPage.links) : null;
    let pages = 1;
    while (pageUrl) {
        if (ctx.requests >= ctx.maxRequests) {
            if (!ctx.cappedLogged) {
                ctx.cappedLogged = true;
                log.warn(
                    `[NS REST] deep follow: cap NS_REST_DEEP_FOLLOW_MAX_REQUESTS=${ctx.maxRequests} mid-sublist (${label})`
                );
            }
            break;
        }
        pages++;
        if (pages > 10_000) {
            log.warn(`[NS REST] ${label}: sublist page cap 10k`);
            break;
        }
        ctx.requests++;
        const data = await nsRestOAuthGetAbsolute(pageUrl!);
        allRows.push(...normalizeNetsuiteRecordListResponse(data));
        if (allRows.length > 500_000) {
            log.warn(`[NS REST] ${label}: sublist row cap 500k`);
            break;
        }
        if (data?.hasMore !== true) break;
        const nextHref = extractNextLinkHref(data.links);
        if (!nextHref) {
            if (allRows.length > 0) {
                log.warn(`[NS REST] ${label}: hasMore without rel=next`);
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
async function deepFollowSelfLinksInValue(value: unknown, ctx: DeepFollowCtx, depth: number): Promise<void> {
    if (value == null || depth > 100) return;

    if (Array.isArray(value)) {
        /** Sequential walk: avoids nested `withConcurrency` deadlock with SO/PO list workers. */
        for (const el of value) {
            await deepFollowSelfLinksInValue(el, ctx, depth + 1);
        }
        return;
    }

    if (!isPlainRestObject(value)) return;

    const node = value as Record<string, any>;
    if (node._hydrateError != null) return;

    const href = extractSelfLinkHref(node.links);
    if (
        href &&
        !isTransactionalRootSelfHref(href, ctx.rootId, ctx.kind) &&
        !node._deepFollowError
    ) {
        if (ctx.requests >= ctx.maxRequests) {
            if (!ctx.cappedLogged) {
                ctx.cappedLogged = true;
                log.warn(
                    `[NS REST] deep follow: cap NS_REST_DEEP_FOLLOW_MAX_REQUESTS=${ctx.maxRequests} reached for ${ctx.kind} ${ctx.rootId ?? "?"}`
                );
            }
        } else {
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
                } else {
                    Object.assign(node, data);
                }
                delete node.links;
            } catch (err: any) {
                logDeepFollowFailure(label, err);
                node._deepFollowError =
                    err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "request_failed";
            }
        }
    }

    for (const k of Object.keys(node)) {
        const v = node[k];
        if (v != null && typeof v === "object") await deepFollowSelfLinksInValue(v, ctx, depth + 1);
    }
}

async function deepFollowSelfLinksOnRecord(record: any, kind: DeepFollowRecordKind): Promise<void> {
    if (record == null || typeof record !== "object") return;
    if (process.env.NS_REST_FOLLOW_SUBRESOURCE_LINKS === "false") return;
    if (!isDeepFollowSelfLinksEnabled()) return;

    const rootId =
        record.id != null && String(record.id).trim() !== "" ? String(record.id).trim() : null;
    const ctx: DeepFollowCtx = {
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
async function hydrateGenericRestRecordFollowLinkSubresources(
    record: any,
    label: string,
    envKey: string | undefined,
    defaultKeys: string,
    options: {
        deepFollowKind?: DeepFollowRecordKind;
    } = {}
): Promise<any> {
    if (record == null || typeof record !== "object") return record;
    if (process.env.NS_REST_FOLLOW_SUBRESOURCE_LINKS === "false") {
        stripNetSuiteLinksDeep(record);
        return record;
    }

    const keys = parseFollowSubresourceKeys(envKey, defaultKeys);

    for (const key of keys) {
        const sub = record[key];
        if (sub == null || typeof sub !== "object" || Array.isArray(sub)) {
            log.debug(`[NS REST] ${label} hydrate skip "${key}": null/non-object/array`);
            continue;
        }

        const href = extractSelfLinkHref(sub.links);
        if (!href) {
            const hasLinks = Array.isArray(sub.links);
            log.debug(
                `[NS REST] ${label} hydrate skip "${key}": no self-link href. hasLinks=${hasLinks}, links=${JSON.stringify(sub.links ?? null).slice(0, 200)}`
            );
            continue;
        }

        if (
            key === "item" &&
            Array.isArray(sub.items) &&
            sub.items.length > 0 &&
            !lineItemsNeedSublistRefetch(sub.items)
        ) {
            continue;
        }

        log.info(`[NS REST] ${label} hydrate "${key}" → GET ${href}`);

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
                log.info(`[NS REST] ${label} hydrate "${key}" → collection, count=${allRows.length}`);
                record[key] = {
                    ...sub,
                    ...data,
                    items: allRows,
                    hasMore: false,
                    count: allRows.length,
                };
            } else {
                log.info(`[NS REST] ${label} hydrate "${key}" → object, keys=[${Object.keys(data ?? {}).join(",")}]`);
                record[key] = { ...sub, ...data };
            }
            delete record[key].links;
        } catch (err: any) {
            log.warn(
                `[NS REST] ${label} follow subresource "${key}" failed:`,
                err?.response?.data ?? err?.message ?? err
            );
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
async function hydrateSalesOrderFollowLinkSubresources(record: any): Promise<any> {
    return hydrateGenericRestRecordFollowLinkSubresources(
        record,
        "SO",
        process.env.NS_REST_SO_FOLLOW_LINK_KEYS,
        "item,shippingAddress,billingAddress",
        { deepFollowKind: "salesOrder" }
    );
}

async function hydratePurchaseOrderFollowLinkSubresources(record: any): Promise<any> {
    return hydrateGenericRestRecordFollowLinkSubresources(
        record,
        "PO",
        process.env.NS_REST_PO_FOLLOW_LINK_KEYS,
        "item,shippingAddress,billingAddress",
        { deepFollowKind: "purchaseOrder" }
    );
}

/**
 * NetSuite list row: use top-level `id` when present (e.g. "327000"), else `links` (prefer rel=self href).
 */
export function extractSalesOrderIdFromListItem(item: any): string | null {
    if (!item || typeof item !== "object") return null;
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();

    return extractIdFromNetSuiteRecordLinks(
        item.links,
        /\/(?:salesOrder|salesorder)\/([^/?#]+)/i
    );
}

/** CamelCase path (fallback if lowercase list/get returns 404). */
const PURCHASE_ORDER_RECORD_PATH = "purchaseOrder";
/** NetSuite often returns self hrefs with lowercase `purchaseorder` — use first for list + detail GET. */
const PURCHASE_ORDER_RECORD_PATH_LOWER = "purchaseorder";

/**
 * NetSuite PO list response shape varies; normalize to an array of row objects.
 */
export function normalizePurchaseOrderListItems(data: any): any[] {
    return normalizeNetsuiteRecordListResponse(data);
}

/**
 * PO list row: top-level `id` (string/number) first, e.g. `"id": "327000"`;
 * if missing, parse `links` (prefer rel=self → .../purchaseorder/327000).
 */
export function extractPurchaseOrderIdFromListItem(item: any): string | null {
    if (!item || typeof item !== "object") return null;
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();

    return extractIdFromNetSuiteRecordLinks(
        item.links,
        /\/(?:purchaseOrder|purchaseorder)\/([^/?#]+)/i
    );
}

/**
 * List Sales Orders from NetSuite
 * GET /services/rest/record/v1/salesOrder
 */
export const listSalesOrders = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();

    if (options.q) params.append("q", options.q);
    const lim = options.limit != null ? Math.max(1, options.limit) : undefined;
    if (lim != null) params.append("limit", String(lim));
    const off = options.offset != null ? Math.max(0, options.offset) : 0;
    params.append("offset", String(off));
    if (options.expandSubResources) params.append("expandSubResources", options.expandSubResources);

    const queryString = params.toString();
    const url = `${baseUrl}/${SALES_ORDER_RECORD_PATH}${queryString ? `?${queryString}` : ""}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json"
        },
        timeout: 120000
    });

    return response.data;
};

async function getSalesOrderWithPath(
    id: string,
    expandSubResources: string | undefined,
    pathSegment: string
): Promise<any> {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
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
async function hydrateSalesOrdersWithWorkerPool(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    if (!listItems.length) return [];

    log.info(
        `[NS REST] SO hydrate: ${listItems.length} list row(s) → per-id GET (workers≤${nsDetailParallelism()})`
    );

    const results: any[] = new Array(listItems.length);
    const pool = Math.min(nsDetailParallelism(), listItems.length);
    let next = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const i = next++;
            if (i >= listItems.length) return;
            const item = listItems[i];
            const idForLabel = extractSalesOrderIdFromListItem(item) || "?";

            results[i] = await withConcurrency(async () => {
                const id = extractSalesOrderIdFromListItem(item);
                if (!id) {
                    return { _hydrateError: "missing_id", listItem: item };
                }
                try {
                    return await getSalesOrder(id, expandSubResources);
                } catch (err: any) {
                    log.error(
                        `[NS REST] Failed to fetch SO ${id} (main GET or uncaught hydration):`,
                        err?.code ?? "",
                        `HTTP ${err?.response?.status ?? "?"}`,
                        err?.response?.data ?? err?.message ?? err
                    );
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
export async function hydrateSalesOrdersFromListRows(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    return hydrateSalesOrdersWithWorkerPool(listItems, expandSubResources);
}

/**
 * Get single Sales Order by ID
 * GET /services/rest/record/v1/salesOrder/{id}
 */
export const getSalesOrder = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const sid = String(id).trim();
    let data: any;
    try {
        data = await getSalesOrderWithPath(sid, expandSubResources, SALES_ORDER_RECORD_PATH);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn(`[NS REST] GET salesOrder/${sid} returned 404, retrying path salesorder`);
            data = await getSalesOrderWithPath(sid, expandSubResources, "salesorder");
        } else {
            throw err;
        }
    }
    try {
        return await hydrateSalesOrderFollowLinkSubresources(data);
    } catch (err: any) {
        log.warn(
            `[NS REST] SO ${sid} link/line hydration threw (returning main GET body):`,
            err?.response?.status,
            err?.response?.data ?? err?.message ?? err
        );
        try {
            stripNetSuiteLinksDeep(data);
        } catch {
            /* ignore */
        }
        return {
            ...data,
            id: data?.id ?? sid,
            _hydrateError:
                err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "hydration_failed",
        };
    }
};

async function listPurchaseOrdersWithPath(
    options: {
        q?: string;
        limit?: number;
        offset?: number;
        expandSubResources?: string;
    },
    pathSegment: string
): Promise<any> {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();

    if (options.q) params.append("q", options.q);
    const lim = options.limit != null ? Math.max(1, options.limit) : undefined;
    if (lim != null) params.append("limit", String(lim));
    const off = options.offset != null ? Math.max(0, options.offset) : 0;
    params.append("offset", String(off));
    if (options.expandSubResources) params.append("expandSubResources", options.expandSubResources);

    const queryString = params.toString();
    const url = `${baseUrl}/${pathSegment}${queryString ? `?${queryString}` : ""}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
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
export const listPurchaseOrders = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    try {
        return await listPurchaseOrdersWithPath(options, PURCHASE_ORDER_RECORD_PATH_LOWER);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn("[NS REST] list purchaseorder 404, retrying purchaseOrder");
            return await listPurchaseOrdersWithPath(options, PURCHASE_ORDER_RECORD_PATH);
        }
        throw err;
    }
};

async function getPurchaseOrderWithPath(
    id: string,
    expandSubResources: string | undefined,
    pathSegment: string
): Promise<any> {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: nsRestRecordGetTimeoutMs(),
    });

    return response.data;
}

async function hydratePurchaseOrdersWithWorkerPool(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    if (!listItems.length) return [];

    log.info(
        `[NS REST] PO hydrate: ${listItems.length} list row(s) → per-id GET (workers≤${nsDetailParallelism()})`
    );

    const results: any[] = new Array(listItems.length);
    const pool = Math.min(nsDetailParallelism(), listItems.length);
    let next = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const i = next++;
            if (i >= listItems.length) return;
            const item = listItems[i];
            const idForLabel = extractPurchaseOrderIdFromListItem(item) || "?";

            results[i] = await withConcurrency(async () => {
                const id = extractPurchaseOrderIdFromListItem(item);
                if (!id) {
                    return { _hydrateError: "missing_id", listItem: item };
                }
                try {
                    return await getPurchaseOrder(id, expandSubResources);
                } catch (err: any) {
                    const safeErrStr = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
                    log.error(`[NS REST] Failed to fetch PO ${id} (main GET or uncaught hydration): HTTP ${err?.response?.status ?? "?"} - ${safeErrStr}`);
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
export async function hydratePurchaseOrdersFromListRows(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    return hydratePurchaseOrdersWithWorkerPool(listItems, expandSubResources);
}

/**
 * Get single Purchase Order by ID
 * GET /services/rest/record/v1/purchaseOrder/{id}
 */
export const getPurchaseOrder = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const sid = String(id).trim();
    let data: any;
    try {
        data = await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH_LOWER);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn(`[NS REST] GET purchaseorder/${sid} 404, retrying purchaseOrder`);
            data = await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH);
        } else {
            throw err;
        }
    }
    try {
        return await hydratePurchaseOrderFollowLinkSubresources(data);
    } catch (err: any) {
        log.warn(
            `[NS REST] PO ${sid} link/line hydration threw (returning main GET body):`,
            err?.response?.status,
            err?.response?.data ?? err?.message ?? err
        );
        try {
            stripNetSuiteLinksDeep(data);
        } catch {
            /* ignore */
        }
        return {
            ...data,
            id: data?.id ?? sid,
            _hydrateError:
                err?.response?.data != null ? JSON.stringify(err.response.data) : err?.message || "hydration_failed",
        };
    }
};

/**
 * Fetch sales orders with full details, up to a capped count.
 * Uses paged list + parallel detail GETs (bounded by shared NetSuite concurrency).
 */
export const fetchAllSalesOrders = async (options: {
    q?: string;
    expandSubResources?: string;
    /** Max sales orders to return; defaults to SALES_ORDER_FETCH_ALL_DEFAULT_MAX, capped at SALES_ORDER_FETCH_ALL_ABS_MAX */
    maxRecords?: number;
    /** List page size (1–1000); default SALES_ORDER_FETCH_ALL_PAGE_SIZE */
    pageSize?: number;
    /** Page until NetSuite has no more rows, up to {@link nsRestFetchUntilExhaustedCap} */
    untilExhausted?: boolean;
    /** Optional starting offset */
    offset?: number;
}): Promise<any[]> => {
    const untilExhausted = options.untilExhausted === true;
    const maxRecords = untilExhausted
        ? nsRestFetchUntilExhaustedCap()
        : Math.min(
              Math.max(1, options.maxRecords ?? SALES_ORDER_FETCH_ALL_DEFAULT_MAX),
              SALES_ORDER_FETCH_ALL_ABS_MAX
          );
    const pageSize = Math.min(
        Math.max(1, options.pageSize ?? SALES_ORDER_FETCH_ALL_PAGE_SIZE),
        1_000
    );

    const allRecords: any[] = [];
    let offset = options.offset != null && Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;

    log.info(
        `[NS REST] fetchAllSalesOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
            (untilExhausted ? ", untilExhausted=true" : "") +
            (options.q ? `, q=present` : "")
    );

    while (allRecords.length < maxRecords) {
        const remaining = maxRecords - allRecords.length;
        const listLimit = Math.min(pageSize, remaining);

        const data = await listSalesOrders({
            q: options.q,
            limit: listLimit,
            offset,
            expandSubResources: undefined,
        });

        const items = normalizeSalesOrderListItems(data);
        if (items.length === 0) break;

        const slice = items.slice(0, remaining);

        const hydrated = await hydrateSalesOrdersWithWorkerPool(slice, options.expandSubResources);
        const batch = hydrated
            .map((r) => {
                if (!r || typeof r !== "object") return null;
                if ("_hydrateError" in r) {
                    if ((r as any)._hydrateError === "missing_id") return null;
                    return (r as any).listItem ?? null;
                }
                return r;
            })
            .filter((r) => r != null) as any[];
        allRecords.push(...batch);

        log.info(
            `[NS REST] fetchAll page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`
        );

        if (untilExhausted) {
            if (data.hasMore === false) break;
            if (items.length < listLimit) break;
        } else {
            if (!data.hasMore) break;
            if (items.length < listLimit) break;
        }

        offset += items.length;
    }

    log.info(`[NS REST] fetchAllSalesOrders done — ${allRecords.length} records`);
    return allRecords;
};

/**
 * Fetch purchase orders with full details, up to a capped count (paged list + worker-pool detail GETs).
 */
export const fetchAllPurchaseOrders = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
    pageSize?: number;
    untilExhausted?: boolean;
    offset?: number;
    onBatch?: (batch: any[]) => Promise<void>;
}): Promise<any[]> => {
    const untilExhausted = options.untilExhausted === true;
    const maxRecords = untilExhausted
        ? nsRestFetchUntilExhaustedCap()
        : Math.min(
              Math.max(1, options.maxRecords ?? PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX),
              PURCHASE_ORDER_FETCH_ALL_ABS_MAX
          );
    const pageSize = Math.min(
        Math.max(1, options.pageSize ?? PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE),
        1_000
    );

    const allRecords: any[] = [];
    let offset = 0;

    log.info(
        `[NS REST] fetchAllPurchaseOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
            (untilExhausted ? ", untilExhausted=true" : "") +
            (options.q ? `, q=present` : "")
    );

    while (allRecords.length < maxRecords) {
        const remaining = maxRecords - allRecords.length;
        const listLimit = Math.min(pageSize, remaining);

        const data = await listPurchaseOrders({
            q: options.q,
            limit: listLimit,
            offset,
            expandSubResources: undefined,
        });

        const items = normalizePurchaseOrderListItems(data);
        if (items.length === 0) break;

        const slice = items.slice(0, remaining);

        const hydrated = await hydratePurchaseOrdersWithWorkerPool(slice, options.expandSubResources);
        const batch = hydrated
            .map((r) => {
                if (!r || typeof r !== "object") return null;
                if ("_hydrateError" in r) {
                    if ((r as any)._hydrateError === "missing_id") return null;
                    return (r as any).listItem ?? null;
                }
                return r;
            })
            .filter((r) => r != null) as any[];
        allRecords.push(...batch);

        log.info(
            `[NS REST] fetchAll PO page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`
        );

        if (untilExhausted) {
            if (data.hasMore === false) break;
            if (items.length < listLimit) break;
        } else {
            if (!data.hasMore) break;
            if (items.length < listLimit) break;
        }

        offset += items.length;
    }

    log.info(`[NS REST] fetchAllPurchaseOrders done — ${allRecords.length} records`);
    return allRecords;
};

// ═══════════════════════════════════════════════════════════════════════════════
// Generic list / GET / hydrate / fetchAll (inventory item, classification, IF, IR)
// ═══════════════════════════════════════════════════════════════════════════════

async function listRestRecordWithPath(
    pathSegment: string,
    options: {
        q?: string;
        limit?: number;
        offset?: number;
        expandSubResources?: string;
    }
): Promise<any> {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();

    if (options.q) params.append("q", options.q);
    const lim = options.limit != null ? Math.max(1, options.limit) : undefined;
    if (lim != null) params.append("limit", String(lim));
    const off = options.offset != null ? Math.max(0, options.offset) : 0;
    params.append("offset", String(off));
    if (options.expandSubResources) params.append("expandSubResources", options.expandSubResources);

    const queryString = params.toString();
    const url = `${baseUrl}/${pathSegment}${queryString ? `?${queryString}` : ""}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: 120000,
    });

    return response.data;
}

async function getRestRecordWithPath(
    id: string,
    expandSubResources: string | undefined,
    pathSegment: string
): Promise<any> {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources
        ? `?expandSubResources=${encodeURIComponent(expandSubResources)}`
        : "";
    const url = `${baseUrl}/${pathSegment}/${encodeURIComponent(id)}${params}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json",
        },
        timeout: nsRestRecordGetTimeoutMs(),
    });

    return response.data;
}

function extractRestRecordIdFromListItem(item: any, linkPathRegex: RegExp): string | null {
    if (!item || typeof item !== "object") return null;
    const direct = item.id ?? item.internalId ?? item.internalid;
    if (direct != null && String(direct).trim() !== "") return String(direct).trim();
    return extractIdFromNetSuiteRecordLinks(item.links, linkPathRegex);
}

async function hydrateRestRecordsFromListRows(
    listItems: any[],
    expandSubResources: string | undefined,
    extractId: (item: any) => string | null,
    getRecord: (id: string, expand?: string) => Promise<any>,
    logPrefix: string
): Promise<any[]> {
    if (!listItems.length) return [];

    log.info(
        `[NS REST] ${logPrefix} hydrate: ${listItems.length} list row(s) → per-id GET (workers≤${nsDetailParallelism()})`
    );

    const results: any[] = new Array(listItems.length);
    const pool = Math.min(nsDetailParallelism(), listItems.length);
    let next = 0;

    async function worker(): Promise<void> {
        for (;;) {
            const i = next++;
            if (i >= listItems.length) return;
            const item = listItems[i];
            const idForLabel = extractId(item) || "?";

            results[i] = await withConcurrency(async () => {
                const id = extractId(item);
                if (!id) {
                    return { _hydrateError: "missing_id", listItem: item };
                }
                try {
                    return await getRecord(id, expandSubResources);
                } catch (err: any) {
                    log.error(`[NS REST] ${logPrefix} Failed to fetch ${id}:`, err.message);
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

async function fetchAllRestRecordsWithDetails(options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
    pageSize?: number;
    untilExhausted?: boolean;
    defaultMax: number;
    absMax: number;
    pageSizeDefault: number;
    listFn: (opts: {
        q?: string;
        limit: number;
        offset: number;
        expandSubResources?: string;
    }) => Promise<any>;
    normalizeItems: (data: any) => any[];
    extractId: (item: any) => string | null;
    getRecord: (id: string, expand?: string) => Promise<any>;
    logLabel: string;
    onBatch?: (batch: any[]) => Promise<void>;
    offset?: number;
}): Promise<any[]> {
    const untilExhausted = options.untilExhausted === true;
    const maxRecords = untilExhausted
        ? nsRestFetchUntilExhaustedCap()
        : Math.min(Math.max(1, options.maxRecords ?? options.defaultMax), options.absMax);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? options.pageSizeDefault), 1_000);

    const allRecords: any[] = [];
    let offset = options.offset || 0;

    log.info(
        `[NS REST] fetchAll${options.logLabel} start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
            (untilExhausted ? ", untilExhausted=true" : "") +
            (options.q ? `, q=present` : "")
    );

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
        if (items.length === 0) break;

        const slice = items.slice(0, remaining);

        const hydrated = await hydrateRestRecordsFromListRows(
            slice,
            options.expandSubResources,
            options.extractId,
            options.getRecord,
            options.logLabel
        );
        const batch = hydrated
            .map((r) => {
                if (!r || typeof r !== "object") return null;
                if ("_hydrateError" in r) {
                    if ((r as any)._hydrateError === "missing_id") return null;
                    return (r as any).listItem ?? null;
                }
                return r;
            })
            .filter((r) => r != null) as any[];
        allRecords.push(...batch);
        
        if (options.onBatch && batch.length > 0) {
            try {
                await options.onBatch(batch);
            } catch (err: any) {
                log.error(`[NS REST] fetchAll${options.logLabel} onBatch callback failed:`, err.message);
            }
        }

        log.info(
            `[NS REST] fetchAll${options.logLabel} page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`
        );

        if (untilExhausted) {
            if (data.hasMore === false) break;
            if (items.length < listLimit) break;
        } else {
            if (!data.hasMore) break;
            if (items.length < listLimit) break;
        }

        offset += items.length;
    }

    log.info(`[NS REST] fetchAll${options.logLabel} done — ${allRecords.length} records`);
    return allRecords;
}

async function listRestRecordDualPath(
    primaryPath: string,
    altPath: string,
    options: {
        q?: string;
        limit?: number;
        offset?: number;
        expandSubResources?: string;
    }
): Promise<any> {
    try {
        return await listRestRecordWithPath(primaryPath, options);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn(`[NS REST] list ${primaryPath} 404, retrying ${altPath}`);
            return await listRestRecordWithPath(altPath, options);
        }
        throw err;
    }
}

async function getRestRecordDualPath(
    id: string,
    expandSubResources: string | undefined,
    primaryPath: string,
    altPath: string
): Promise<any> {
    const sid = String(id).trim();
    try {
        return await getRestRecordWithPath(sid, expandSubResources, primaryPath);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn(`[NS REST] GET ${primaryPath}/${sid} 404, retrying ${altPath}`);
            return await getRestRecordWithPath(sid, expandSubResources, altPath);
        }
        throw err;
    }
}

// ─── Inventory Item (REST “items” for sellable stock) ─────────────────────────

export const INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX = 250;
export const INVENTORY_ITEM_FETCH_ALL_ABS_MAX = 5_000;
const INVENTORY_ITEM_FETCH_ALL_PAGE_SIZE = 500;
export const INVENTORY_ITEM_LIST_DEFAULT_LIMIT = 200;
export const INVENTORY_ITEM_LIST_ABS_MAX = 1_000;

const INVENTORY_ITEM_PATH = "inventoryItem";
const INVENTORY_ITEM_PATH_LOWER = "inventoryitem";
const INVENTORY_ITEM_LINK_RE = /\/(?:inventoryItem|inventoryitem)\/([^/?#]+)/i;

/**
 * NetSuite list rows often use `id` / `links[].href`.
 * Self links may be `.../inventoryItem/{id}`, `.../item/{id}`, or relative paths without `/record/v1/`.
 */
export function extractInventoryItemIdFromListItem(item: any): string | null {
    const fromStandard = extractRestRecordIdFromListItem(item, INVENTORY_ITEM_LINK_RE);
    if (fromStandard) return fromStandard;

    if (!item?.links || !Array.isArray(item.links)) return null;

    const tryHref = (href: string): string | null => {
        const decoded = decodeURIComponent(href);
        const mInv =
            decoded.match(/\/(?:inventoryItem|inventoryitem)\/([^/?#]+)/i) ||
            decoded.match(/(?:^|\/)(?:inventoryItem|inventoryitem)\/([^/?#]+)/i);
        if (mInv?.[1]) return String(mInv[1]).trim();
        const mItem = decoded.match(/\/(?:item)\/([^/?#]+)/i);
        if (mItem?.[1]) return String(mItem[1]).trim();
        const mGen = decoded.match(/\/record\/v1\/[^/]+\/([^/?#]+)/i);
        if (mGen?.[1]) return String(mGen[1]).trim();
        return null;
    };

    for (const L of item.links) {
        if (String(L?.rel || "").toLowerCase() === "self") {
            const href = L?.href;
            if (typeof href === "string") {
                const id = tryHref(href);
                if (id) return id;
            }
        }
    }
    for (const L of item.links) {
        const href = L?.href;
        if (typeof href === "string") {
            const id = tryHref(href);
            if (id) return id;
        }
    }
    return null;
}

export const listInventoryItems = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    return listRestRecordDualPath(INVENTORY_ITEM_PATH, INVENTORY_ITEM_PATH_LOWER, options);
};

/**
 * After collecting all rows from a sublist collection, expand any link-shell rows
 * (rows that only have `links` but no real fields) by GETting their self-link href.
 */
async function expandSublistLinkShellRows(rows: any[], label: string): Promise<void> {
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!isPlainRestObject(row)) continue;

        // A link shell has no keys other than "links"
        const nonLinkKeys = Object.keys(row).filter((k) => k !== "links");
        if (nonLinkKeys.length > 0) continue; // Already has data

        const href = extractSelfLinkHref(row.links);
        if (!href) continue;

        try {
            const data = await nsRestOAuthGetAbsolute(href);
            Object.assign(row, data);
            delete row.links;
            log.debug(`[NS REST] ${label} row[${i}] expanded OK`);
        } catch (err: any) {
            const status = err?.response?.status;
            log.warn(`[NS REST] ${label} row[${i}] expand failed (${status}):`, err?.response?.data ?? err?.message);
            (row as any)._rowExpandError = err?.message || "request_failed";
        }
    }
}

/**
 * Fetches a known NetSuite sublist collection by constructing the URL directly,
 * then expands any link-shell rows via per-row GET.
 * e.g. GET .../inventoryItem/{id}/locations → expand each row
 */
async function fetchNsSublistByDirectUrl(
    recordPath: string,
    recordId: string,
    sublistName: string,
    label: string
): Promise<any[] | null> {
    const baseUrl = buildRestApiUrl();
    const url = `${baseUrl}/${recordPath}/${encodeURIComponent(recordId)}/${sublistName}`;
    log.info(`[NS REST] ${label} fetching sublist "${sublistName}" → GET ${url}`);
    try {
        const data = await nsRestOAuthGetAbsolute(url);
        if (!data) return null;
        if (looksLikeNetSuitePagedItemsWrapper(data)) {
            const ctx: DeepFollowCtx = {
                kind: "salesOrder",
                rootId: recordId,
                requests: 0,
                maxRequests: 2000,
                cappedLogged: false,
            };
            const allRows = await collectSublistRowsAfterFirstPage(data, `${label} ${sublistName}`, ctx);
            // Expand each row that is just a link shell
            await expandSublistLinkShellRows(allRows, `${label} ${sublistName}`);
            log.info(`[NS REST] ${label} sublist "${sublistName}" → ${allRows.length} rows (expanded)`);
            return allRows;
        }
        // Not a collection — return single item as array
        return [data];
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404 || status === 403) {
            log.debug(`[NS REST] ${label} sublist "${sublistName}" → ${status} (skipped)`);
        } else {
            log.warn(`[NS REST] ${label} sublist "${sublistName}" fetch failed:`, err?.response?.data ?? err?.message);
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
] as const;

async function hydrateInventoryItemFollowLinkSubresources(record: any): Promise<any> {
    if (!record || typeof record !== "object") return record;
    const id = String(record.id ?? "").trim();
    if (!id) return record;

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


export const getInventoryItem = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const sid = String(id).trim();
    const data = await getRestRecordDualPath(sid, expandSubResources, INVENTORY_ITEM_PATH, INVENTORY_ITEM_PATH_LOWER);
    return hydrateInventoryItemFollowLinkSubresources(data);
};

export async function hydrateInventoryItemsFromListRows(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    return hydrateRestRecordsFromListRows(
        listItems,
        expandSubResources,
        extractInventoryItemIdFromListItem,
        getInventoryItem,
        "InventoryItem"
    );
}

export const fetchAllInventoryItems = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
    pageSize?: number;
    untilExhausted?: boolean;
    onBatch?: (batch: any[]) => Promise<void>;
    offset?: number;
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
        defaultMax: INVENTORY_ITEM_FETCH_ALL_DEFAULT_MAX,
        absMax: INVENTORY_ITEM_FETCH_ALL_ABS_MAX,
        pageSizeDefault: INVENTORY_ITEM_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => listInventoryItems(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractInventoryItemIdFromListItem,
        getRecord: getInventoryItem,
        logLabel: "InventoryItems",
    });
};

// ─── Classification (NetSuite “Class”) ──────────────────────────────────────

export const CLASSIFICATION_FETCH_ALL_DEFAULT_MAX = 250;
export const CLASSIFICATION_FETCH_ALL_ABS_MAX = 5_000;
const CLASSIFICATION_FETCH_ALL_PAGE_SIZE = 500;
export const CLASSIFICATION_LIST_DEFAULT_LIMIT = 200;
export const CLASSIFICATION_LIST_ABS_MAX = 1_000;

const CLASSIFICATION_PATH = "classification";
const CLASSIFICATION_PATH_LOWER = "classification";
const CLASSIFICATION_LINK_RE = /\/(?:classification)\/([^/?#]+)/i;

export function extractClassificationIdFromListItem(item: any): string | null {
    return extractRestRecordIdFromListItem(item, CLASSIFICATION_LINK_RE);
}

export const listClassifications = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    return listRestRecordWithPath(CLASSIFICATION_PATH, options);
};


export const getClassification = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const sid = String(id).trim();
    // For Classifications, NetSuite requires expandSubResources=true to see subsidiary/translations
    const expand = expandSubResources || "true";
    const data = await getRestRecordWithPath(sid, expand, CLASSIFICATION_PATH);
    stripNetSuiteLinksDeep(data);
    return data;
};

export async function hydrateClassificationsFromListRows(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    return hydrateRestRecordsFromListRows(
        listItems,
        expandSubResources,
        extractClassificationIdFromListItem,
        getClassification,
        "Classification"
    );
}

export const fetchAllClassifications = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
    pageSize?: number;
    untilExhausted?: boolean;
    onBatch?: (batch: any[]) => Promise<void>;
    offset?: number;
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
        defaultMax: CLASSIFICATION_FETCH_ALL_DEFAULT_MAX,
        absMax: CLASSIFICATION_FETCH_ALL_ABS_MAX,
        pageSizeDefault: CLASSIFICATION_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => listClassifications(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractClassificationIdFromListItem,
        getRecord: getClassification,
        logLabel: "Classifications",
    });
};

// ─── Item Fulfillment ───────────────────────────────────────────────────────

export const ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX = 250;
export const ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX = 10_000;
const ITEM_FULFILLMENT_FETCH_ALL_PAGE_SIZE = 500;
export const ITEM_FULFILLMENT_LIST_DEFAULT_LIMIT = 200;
export const ITEM_FULFILLMENT_LIST_ABS_MAX = 1_000;

const ITEM_FULFILLMENT_PATH = "itemFulfillment";
const ITEM_FULFILLMENT_PATH_LOWER = "itemfulfillment";
const ITEM_FULFILLMENT_LINK_RE = /\/(?:itemFulfillment|itemfulfillment)\/([^/?#]+)/i;

export function extractItemFulfillmentIdFromListItem(item: any): string | null {
    return extractRestRecordIdFromListItem(item, ITEM_FULFILLMENT_LINK_RE);
}

export const listItemFulfillments = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    return listRestRecordDualPath(ITEM_FULFILLMENT_PATH, ITEM_FULFILLMENT_PATH_LOWER, options);
};

// Known sublists for item fulfillments that must be fetched separately
const ITEM_FULFILLMENT_SUBLISTS = ["item"] as const;

async function hydrateItemFulfillmentFollowLinkSubresources(record: any): Promise<any> {
    if (!record || typeof record !== "object") return record;
    const id = String(record.id ?? "").trim();
    if (!id) return record;

    for (const sublist of ITEM_FULFILLMENT_SUBLISTS) {
        const rows = await fetchNsSublistByDirectUrl(ITEM_FULFILLMENT_PATH, id, sublist, "ItemFulfillment");
        if (rows !== null) {
            record[sublist] = { items: rows, count: rows.length };
        }
    }

    stripNetSuiteLinksDeep(record);
    return record;
}

export const getItemFulfillment = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const sid = String(id).trim();
    const data = await getRestRecordDualPath(sid, expandSubResources, ITEM_FULFILLMENT_PATH, ITEM_FULFILLMENT_PATH_LOWER);
    return hydrateItemFulfillmentFollowLinkSubresources(data);
};

export async function hydrateItemFulfillmentsFromListRows(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    return hydrateRestRecordsFromListRows(
        listItems,
        expandSubResources,
        extractItemFulfillmentIdFromListItem,
        getItemFulfillment,
        "ItemFulfillment"
    );
}

export const fetchAllItemFulfillments = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
    pageSize?: number;
    untilExhausted?: boolean;
    onBatch?: (batch: any[]) => Promise<void>;
    offset?: number;
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
        defaultMax: ITEM_FULFILLMENT_FETCH_ALL_DEFAULT_MAX,
        absMax: ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX,
        pageSizeDefault: ITEM_FULFILLMENT_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => listItemFulfillments(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractItemFulfillmentIdFromListItem,
        getRecord: getItemFulfillment,
        logLabel: "ItemFulfillments",
    });
};

// ─── Item Receipt ─────────────────────────────────────────────────────────────

export const ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX = 250;
export const ITEM_RECEIPT_FETCH_ALL_ABS_MAX = 5_000;
const ITEM_RECEIPT_FETCH_ALL_PAGE_SIZE = 500;
export const ITEM_RECEIPT_LIST_DEFAULT_LIMIT = 200;
export const ITEM_RECEIPT_LIST_ABS_MAX = 1_000;

const ITEM_RECEIPT_PATH = "itemReceipt";
const ITEM_RECEIPT_PATH_LOWER = "itemreceipt";
const ITEM_RECEIPT_LINK_RE = /\/(?:itemReceipt|itemreceipt)\/([^/?#]+)/i;

export function extractItemReceiptIdFromListItem(item: any): string | null {
    return extractRestRecordIdFromListItem(item, ITEM_RECEIPT_LINK_RE);
}

export const listItemReceipts = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    return listRestRecordDualPath(ITEM_RECEIPT_PATH, ITEM_RECEIPT_PATH_LOWER, options);
};

// Known sublists for item receipts that must be fetched separately
const ITEM_RECEIPT_SUBLISTS = ["item"] as const;

async function hydrateItemReceiptFollowLinkSubresources(record: any): Promise<any> {
    if (!record || typeof record !== "object") return record;
    const id = String(record.id ?? "").trim();
    if (!id) return record;

    for (const sublist of ITEM_RECEIPT_SUBLISTS) {
        const rows = await fetchNsSublistByDirectUrl(ITEM_RECEIPT_PATH, id, sublist, "ItemReceipt");
        if (rows !== null) {
            record[sublist] = { items: rows, count: rows.length };
        }
    }

    stripNetSuiteLinksDeep(record);
    return record;
}

export const getItemReceipt = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const sid = String(id).trim();
    const data = await getRestRecordDualPath(sid, expandSubResources, ITEM_RECEIPT_PATH, ITEM_RECEIPT_PATH_LOWER);
    return hydrateItemReceiptFollowLinkSubresources(data);
};

export async function hydrateItemReceiptsFromListRows(
    listItems: any[],
    expandSubResources?: string
): Promise<any[]> {
    return hydrateRestRecordsFromListRows(
        listItems,
        expandSubResources,
        extractItemReceiptIdFromListItem,
        getItemReceipt,
        "ItemReceipt"
    );
}

export const fetchAllItemReceipts = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
    pageSize?: number;
    untilExhausted?: boolean;
    onBatch?: (batch: any[]) => Promise<void>;
    offset?: number;
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
        untilExhausted: options.untilExhausted,
        onBatch: options.onBatch,
        offset: options.offset,
        defaultMax: ITEM_RECEIPT_FETCH_ALL_DEFAULT_MAX,
        absMax: ITEM_RECEIPT_FETCH_ALL_ABS_MAX,
        pageSizeDefault: ITEM_RECEIPT_FETCH_ALL_PAGE_SIZE,
        listFn: (opts) => listItemReceipts(opts),
        normalizeItems: normalizeRestRecordListItems,
        extractId: extractItemReceiptIdFromListItem,
        getRecord: getItemReceipt,
        logLabel: "ItemReceipts",
    });
};
// ─── Vendor Bill ──────────────────────────────────────────────────────────────
export const listVendorBills = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    return listRestRecordWithPath("vendorBill", options);
};

export function normalizeVendorBillListItems(data: any): any[] {
    return normalizeRestRecordListItems(data);
}

export function extractVendorBillIdFromListItem(item: any): string | null {
    const VENDOR_BILL_LINK_RE = /\/(?:vendorBill|vendorbill)\/([^/?#]+)/i;
    return extractRestRecordIdFromListItem(item, VENDOR_BILL_LINK_RE);
}
