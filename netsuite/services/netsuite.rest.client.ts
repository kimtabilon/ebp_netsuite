import axios from "axios";
import crypto from "crypto";
import OAuth from "oauth-1.0a";
import log from "../config/logger.config";

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
    if (options.limit) params.append("limit", String(options.limit));
    if (options.offset) params.append("offset", String(options.offset));
    if (options.expandSubResources) params.append("expandSubResources", options.expandSubResources);

    const queryString = params.toString();
    const url = `${baseUrl}/salesOrder${queryString ? `?${queryString}` : ""}`;

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

/**
 * Get single Sales Order by ID
 * GET /services/rest/record/v1/salesOrder/{id}
 */
export const getSalesOrder = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources ? `?expandSubResources=${expandSubResources}` : "";
    const url = `${baseUrl}/salesOrder/${id}${params}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json"
        },
        timeout: 60000
    });

    return response.data;
};

/**
 * List Purchase Orders from NetSuite
 * GET /services/rest/record/v1/purchaseOrder
 */
export const listPurchaseOrders = async (options: {
    q?: string;
    limit?: number;
    offset?: number;
    expandSubResources?: string;
}): Promise<any> => {
    const baseUrl = buildRestApiUrl();
    const params = new URLSearchParams();
    
    if (options.q) params.append("q", options.q);
    if (options.limit) params.append("limit", String(options.limit));
    if (options.offset) params.append("offset", String(options.offset));
    if (options.expandSubResources) params.append("expandSubResources", options.expandSubResources);

    const queryString = params.toString();
    const url = `${baseUrl}/purchaseOrder${queryString ? `?${queryString}` : ""}`;

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

/**
 * Get single Purchase Order by ID
 * GET /services/rest/record/v1/purchaseOrder/{id}
 */
export const getPurchaseOrder = async (id: string | number, expandSubResources?: string): Promise<any> => {
    const baseUrl = buildRestApiUrl();
    const params = expandSubResources ? `?expandSubResources=${expandSubResources}` : "";
    const url = `${baseUrl}/purchaseOrder/${id}${params}`;

    log.info(`[NS REST] GET ${url}`);

    const response = await axios.get(url, {
        headers: {
            Authorization: buildOAuthHeader(url, "GET"),
            Accept: "application/json"
        },
        timeout: 60000
    });

    return response.data;
};

/**
 * Fetch all Sales Orders with full details
 * Iterates through all pages and fetches individual record data
 */
export const fetchAllSalesOrders = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
}): Promise<any[]> => {
    const allRecords: any[] = [];
    let offset = 0;
    const limit = 1000;
    const maxRecords = options.maxRecords || Infinity;

    log.info(`[NS REST] Starting fetchAllSalesOrders`);

    while (allRecords.length < maxRecords) {
        const data = await listSalesOrders({
            q: options.q,
            limit,
            offset,
            expandSubResources: undefined // Don't expand on list, fetch individually
        });

        const items = data.items || [];
        if (items.length === 0) break;

        log.info(`[NS REST] Page fetched: ${items.length} items, fetching details...`);

        // Fetch full details for each record
        for (const item of items) {
            if (allRecords.length >= maxRecords) break;

            const id = item.id;
            if (!id) continue;

            try {
                const fullRecord = await getSalesOrder(id, options.expandSubResources);
                allRecords.push(fullRecord);
            } catch (err: any) {
                log.error(`[NS REST] Failed to fetch SO ${id}:`, err.message);
                // Push basic data if full fetch fails
                allRecords.push(item);
            }
        }

        log.info(`[NS REST] Total records so far: ${allRecords.length}`);

        // Check if there are more pages
        if (!data.hasMore) break;
        
        offset += limit;
    }

    log.info(`[NS REST] Completed fetchAllSalesOrders: ${allRecords.length} total records`);
    return allRecords;
};

/**
 * Fetch all Purchase Orders with full details
 * Iterates through all pages and fetches individual record data
 */
export const fetchAllPurchaseOrders = async (options: {
    q?: string;
    expandSubResources?: string;
    maxRecords?: number;
}): Promise<any[]> => {
    const allRecords: any[] = [];
    let offset = 0;
    const limit = 1000;
    const maxRecords = options.maxRecords || Infinity;

    log.info(`[NS REST] Starting fetchAllPurchaseOrders`);

    while (allRecords.length < maxRecords) {
        const data = await listPurchaseOrders({
            q: options.q,
            limit,
            offset,
            expandSubResources: undefined
        });

        const items = data.items || [];
        if (items.length === 0) break;

        log.info(`[NS REST] Page fetched: ${items.length} items, fetching details...`);

        // Fetch full details for each record
        for (const item of items) {
            if (allRecords.length >= maxRecords) break;

            const id = item.id;
            if (!id) continue;

            try {
                const fullRecord = await getPurchaseOrder(id, options.expandSubResources);
                allRecords.push(fullRecord);
            } catch (err: any) {
                log.error(`[NS REST] Failed to fetch PO ${id}:`, err.message);
                allRecords.push(item);
            }
        }

        log.info(`[NS REST] Total records so far: ${allRecords.length}`);

        if (!data.hasMore) break;
        offset += limit;
    }

    log.info(`[NS REST] Completed fetchAllPurchaseOrders: ${allRecords.length} total records`);
    return allRecords;
};
