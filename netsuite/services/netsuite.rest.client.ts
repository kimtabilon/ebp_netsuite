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
const PURCHASE_ORDER_FETCH_ALL_PAGE_SIZE = 500;
/** Default page size for GET /purchaseOrder list (non-fetchAll) */
export const PURCHASE_ORDER_LIST_DEFAULT_LIMIT = 200;
/** Max `limit` query for GET /purchaseOrder list */
export const PURCHASE_ORDER_LIST_ABS_MAX = 1_000;

/**
 * Build NetSuite REST API base URL
 * e.g., 9511322_SB1 → 9511322-sb1.suitetalk.api.netsuite.com
 */
const buildRestApiUrl = (): string => {
    const accountId = process.env.NS_ACCOUNT_ID;
    if (!accountId) throw new Error("NS_ACCOUNT_ID is not set in .env");
    const accountUrl = accountId.toLowerCase().replace(/_/g, "-");
    return `https://${accountUrl}.suitetalk.api.netsuite.com/services/rest/record/v1`;
};

/**
 * Build OAuth 1.0a header for NetSuite REST API
 */
const buildOAuthHeader = (url: string, method: string): string => {
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
        timeout: 60000,
    });

    return response.data;
}

/**
 * Run at most `NS_MAX_CONCURRENT` detail fetches at a time so queued waiters do not hit the
 * 60s concurrency acquire timeout (Promise.all + N×withConcurrency queues all N at once).
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
                    log.error(`[NS REST] Failed to fetch SO ${id}:`, err.message);
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
    try {
        return await getSalesOrderWithPath(sid, expandSubResources, SALES_ORDER_RECORD_PATH);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn(`[NS REST] GET salesOrder/${sid} returned 404, retrying path salesorder`);
            return await getSalesOrderWithPath(sid, expandSubResources, "salesorder");
        }
        throw err;
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
        timeout: 60000,
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
                    log.error(`[NS REST] Failed to fetch PO ${id}:`, err.message);
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
    try {
        return await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH_LOWER);
    } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
            log.warn(`[NS REST] GET purchaseorder/${sid} 404, retrying purchaseOrder`);
            return await getPurchaseOrderWithPath(sid, expandSubResources, PURCHASE_ORDER_RECORD_PATH);
        }
        throw err;
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
}): Promise<any[]> => {
    const maxRecords = Math.min(
        Math.max(1, options.maxRecords ?? SALES_ORDER_FETCH_ALL_DEFAULT_MAX),
        SALES_ORDER_FETCH_ALL_ABS_MAX
    );
    const pageSize = Math.min(
        Math.max(1, options.pageSize ?? SALES_ORDER_FETCH_ALL_PAGE_SIZE),
        1_000
    );

    const allRecords: any[] = [];
    let offset = 0;

    log.info(
        `[NS REST] fetchAllSalesOrders start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
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

        if (!data.hasMore) break;
        if (items.length < listLimit) break;

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
}): Promise<any[]> => {
    const maxRecords = Math.min(
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

        if (!data.hasMore) break;
        if (items.length < listLimit) break;

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
        timeout: 60000,
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
}): Promise<any[]> {
    const maxRecords = Math.min(
        Math.max(1, options.maxRecords ?? options.defaultMax),
        options.absMax
    );
    const pageSize = Math.min(Math.max(1, options.pageSize ?? options.pageSizeDefault), 1_000);

    const allRecords: any[] = [];
    let offset = 0;

    log.info(
        `[NS REST] fetchAll${options.logLabel} start — maxRecords=${maxRecords}, pageSize=${pageSize}` +
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

        log.info(
            `[NS REST] fetchAll${options.logLabel} page: list=${items.length}, details=${batch.length}, total=${allRecords.length}/${maxRecords}`
        );

        if (!data.hasMore) break;
        if (items.length < listLimit) break;

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

export const getInventoryItem = async (id: string | number, expandSubResources?: string): Promise<any> => {
    return getRestRecordDualPath(String(id).trim(), expandSubResources, INVENTORY_ITEM_PATH, INVENTORY_ITEM_PATH_LOWER);
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
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
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
    return getRestRecordWithPath(String(id).trim(), expandSubResources, CLASSIFICATION_PATH);
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
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
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
export const ITEM_FULFILLMENT_FETCH_ALL_ABS_MAX = 5_000;
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

export const getItemFulfillment = async (id: string | number, expandSubResources?: string): Promise<any> => {
    return getRestRecordDualPath(String(id).trim(), expandSubResources, ITEM_FULFILLMENT_PATH, ITEM_FULFILLMENT_PATH_LOWER);
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
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
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

export const getItemReceipt = async (id: string | number, expandSubResources?: string): Promise<any> => {
    return getRestRecordDualPath(String(id).trim(), expandSubResources, ITEM_RECEIPT_PATH, ITEM_RECEIPT_PATH_LOWER);
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
}): Promise<any[]> => {
    return fetchAllRestRecordsWithDetails({
        q: options.q,
        expandSubResources: options.expandSubResources,
        maxRecords: options.maxRecords,
        pageSize: options.pageSize,
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
