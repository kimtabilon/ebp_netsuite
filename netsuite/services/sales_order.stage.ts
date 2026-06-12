import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
const stagesCollection = "suite_sales_order";

// ── Interfaces ──────────────────────────────────────────────────────────────

interface SalesItem {
    item: string;
    quantity: number;
    amount: number;
}

interface SimplePOItem {
    sku: string;
    qty: string;
    cost: string;
}

interface SimplePO {
    po_number: number;
    po_vendor: number | null;
    order_items: SimplePOItem[];
}

interface ShippingAddress {
    addressee: string;      // recipient name
    company: string;        // company name
    addr1: string;          // street line 1
    addr2: string;          // street line 2
    city: string;
    state: string;          // state/region code
    zip: string;            // postal code
    country: string;        // 2-letter country code (US, CA, etc.)
}

interface SalesOrder {
    otherrefnum: string;                    // Order ID (unique key, maps to PO # in NetSuite)
    trandate: Date;                         // Order purchase date
    store_type: string;                     // drives Customer + Channel lookups in NetSuite
    order_source: string;                   // "amazon" | "newegg" | "walmart" | "tpx"
    order_status: string;
    fulfillment_channel: string;
    ship_date: string | null;
    items_shipped: number;
    items_unshipped: number;
    items: SalesItem[];
    // po: SimplePO[];
    shipping_address: ShippingAddress | null;
}

// ── Source Adapters ─────────────────────────────────────────────────────────

function buildAmazonOrders(
    amazonDocs: any[],
    tpxMap: Map<string, { store_type: string }>,
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of amazonDocs) {
        const orderId = order?.AmazonOrderId;
        if (!orderId) continue;

        const tpxData = tpxMap.get(orderId);
        const addr = order.ShippingAddress;

        // Determine trandate: if PurchaseDate is in 2025, use EarliestShipDate
        let trandate = new Date(order.PurchaseDate);
        if (!isNaN(trandate.getTime()) && trandate.getFullYear() === 2025 && order.EarliestShipDate) {
            const shipDate = new Date(order.EarliestShipDate);
            if (!isNaN(shipDate.getTime())) {
                trandate = shipDate;
            }
        }

        orders.push({
            otherrefnum:        orderId,
            trandate,
            store_type:         tpxData?.store_type || "amazon",
            order_source:       "amazon",
            order_status:       order.OrderStatus || "",
            fulfillment_channel: order.FulfillmentChannel || "",
            ship_date:          order.LatestShipDate || null,
            items_shipped:      Number(order.NumberOfItemsShipped || 0),
            items_unshipped:    Number(order.NumberOfItemsUnshipped || 0),
            items: (order.OrderItems || []).map((i: any) => ({
                item:     i?.SellerSKU,
                quantity: Number(i?.QuantityOrdered || 0),
                amount:   Number(i?.ItemPrice?.Amount || 0)
            })),
            // po: po_map.get(orderId) || [],
            shipping_address: addr ? {
                addressee: addr.Name || "",
                company:   addr.CompanyName || "",
                addr1:     addr.AddressLine1 || "",
                addr2:     addr.AddressLine2 || "",
                city:      addr.City || "",
                state:     addr.StateOrRegion || "",
                zip:       addr.PostalCode || "",
                country:   addr.CountryCode || "US",
            } : null,
        });
    }
    return orders;
}

function buildNeweggOrders(
    neweggDocs: any[],
    po_map: Map<string, SimplePO[]>,
    storeType: string // "newegg" or "newegg_business"
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of neweggDocs) {
        const orderId = order?.OrderNumber != null ? String(order.OrderNumber) : null;
        if (!orderId) continue;

        const itemList = Array.isArray(order.ItemInfoList) ? order.ItemInfoList : [];
        const orderQty = Number(order.OrderQty || itemList.length || 1);
        const orderAmount = Number(order.OrderItemAmount || order.OrderTotalAmount || 0);

        orders.push({
            otherrefnum:        orderId,
            trandate:           order.OrderDate ? new Date(order.OrderDate) : new Date(),
            store_type:         storeType,
            order_source:       storeType,
            order_status:       order.OrderStatusDescription || order.OrderStatus || "",
            fulfillment_channel: order.FulfillmentOption || "MFN",
            ship_date:          order.ShipDate || null,
            items_shipped:      Number(order.ItemsShipped || 0),
            items_unshipped:    Number(order.ItemsUnshipped || orderQty),
            items: itemList.length > 0
                ? itemList.map((i: any) => ({
                    item:     i?.SellerPartNumber || i?.MfrPartNumber || "",
                    quantity: Number(i?.Quantity || (itemList.length === 1 ? orderQty : 1)),
                    amount:   Number(i?.UnitPrice || (itemList.length === 1 ? orderAmount : 0)),
                }))
                : [],
            // po: po_map.get(orderId) || [],
            shipping_address: {
                addressee: [order.ShipToFirstName, order.ShipToLastName].filter(Boolean).join(" "),
                company:   order.ShipToCompany || "",
                addr1:     order.ShipToAddress1 || "",
                addr2:     order.ShipToAddress2 || "",
                city:      order.ShipToCityName || "",
                state:     order.ShipToStateCode || "",
                zip:       order.ShipToZipCode || "",
                country:   order.ShipToCountryCode || "US",
            },
        });
    }
    return orders;
}

function buildWalmartOrders(
    walmartDocs: any[],
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of walmartDocs) {
        const orderId = order?.orderNumber != null ? String(order.orderNumber) : null;
        if (!orderId) continue;

        // orderDate can be "0000-00-00 00:00:00" — fall back to createdAt
        let trandate = order.orderDate ? new Date(order.orderDate) : null;
        if (!trandate || isNaN(trandate.getTime()) || trandate.getFullYear() < 2000 || trandate.getFullYear() > 2030) {
            trandate = order.createdAt ? new Date(order.createdAt) : new Date();
        }

        // Extract line items from orderLines.orderLine[]
        const lineItems = Array.isArray(order.orderLines?.orderLine) ? order.orderLines.orderLine : [];
        const items: SalesItem[] = lineItems.map((line: any) => {
            const sku = line?.item?.sku || "";
            const qty = Number(line?.orderLineQuantity?.amount || 1);
            // Find PRODUCT charge for the item price
            const charges = Array.isArray(line?.charges?.charge) ? line.charges.charge : [];
            const productCharge = charges.find((c: any) => c.chargeType === "PRODUCT");
            const amount = Number(productCharge?.chargeAmount?.amount || 0);
            return { item: sku, quantity: qty, amount };
        });

        // Resolve top-level status from line statuses or top-level
        const topStatus = order.status || "";

        // Ship date from shippingInfo.estimatedShipDate (epoch ms)
        let shipDate: string | null = null;
        if (order.shippingInfo?.estimatedShipDate) {
            shipDate = new Date(order.shippingInfo.estimatedShipDate).toISOString();
        }

        // Shipping address from shippingInfo.postalAddress
        const addr = order.shippingInfo?.postalAddress;
        // Walmart uses "USA" (3-letter) — normalize to 2-letter
        let countryCode = addr?.country || "US";
        if (countryCode === "USA") countryCode = "US";
        if (countryCode === "CAN") countryCode = "CA";

        orders.push({
            otherrefnum:        orderId,
            trandate,
            store_type:         "walmart",
            order_source:       "walmart",
            order_status:       topStatus,
            fulfillment_channel: lineItems[0]?.fulfillment?.shipMethod || "MFN",
            ship_date:          shipDate,
            items_shipped:      topStatus === "Delivered" || topStatus === "Shipped" ? items.length : 0,
            items_unshipped:    topStatus === "Delivered" || topStatus === "Shipped" ? 0 : items.length,
            items,
            // po: po_map.get(orderId) || [],
            shipping_address: addr ? {
                addressee: addr.name || "",
                company:   "",
                addr1:     addr.address1 || "",
                addr2:     addr.address2 || "",
                city:      addr.city || "",
                state:     addr.state || "",
                zip:       addr.postalCode || "",
                country:   countryCode,
            } : null,
        });
    }
    return orders;
}

function buildTpxOrders(
    tpxDocs: any[],
    po_map: Map<string, SimplePO[]>
): SalesOrder[] {
    const orders: SalesOrder[] = [];
    for (const order of tpxDocs) {
        const orderId = order?.txn_id;
        if (!orderId) continue;

        // store_type comes directly from the document (shopify, ebay)
        const storeType = (order.store_type || "").toLowerCase();

        // Date: use order_details.PaymentDate or created_at as fallback
        let trandate = order.order_details?.PaymentDate ? new Date(order.order_details.PaymentDate) : null;
        if (!trandate || isNaN(trandate.getTime())) {
            trandate = order.created_at ? new Date(order.created_at) : new Date();
        }

        // Items from order_items[]
        const rawItems = Array.isArray(order.order_items) ? order.order_items : [];
        const items: SalesItem[] = rawItems.map((i: any) => ({
    item:     i?.SKU || i?.ItemSKU || i?.sku || i?.Name || "",  // check your actual TPX doc structure
    quantity: Number(i?.Quantity || 1),
    amount:   Number(i?.Amount || 0),
}));

        // Ship date from shipping_details.ShipDate
        const shipDate = order.shipping_details?.ShipDate || null;

        // Shipping address from "to" object
        const addr = order.to;

        orders.push({
            otherrefnum:        orderId,
            trandate,
            store_type:         storeType,
            order_source:       "tpx",
            order_status:       order.payment_status || "",
            fulfillment_channel: order.order_details?.ShipClass || "MFN",
            ship_date:          shipDate,
            items_shipped:      order.shipped ? items.length : 0,
            items_unshipped:    order.shipped ? 0 : items.length,
            items,
            // po: po_map.get(orderId) || [],
            shipping_address: addr ? {
                addressee: addr.Name || "",
                company:   addr.Company || "",
                addr1:     addr.Street || "",
                addr2:     addr.Street2 || "",
                city:      addr.City || "",
                state:     addr.State || "",
                zip:       addr.ZipCode || "",
                country:   addr.CountryCode || "US",
            } : null,
        });
    }
    return orders;
}




export const stageSalesOrders = async (): Promise<{
    processed: number;
    available: { amazon: number; newegg: number; newegg_business: number; walmart: number; tpx: number; total: number };
    staged:    { amazon: number; newegg: number; newegg_business: number; walmart: number; tpx: number; total: number };
    dropped:   { amazon: number; newegg: number; newegg_business: number; walmart: number; tpx: number; total: number };
}> => {

    log.info("[SO Stage Dummy] Starting...");

    const DATE_FILTER     = "2026-01-01T00:00:00Z";
    const DATE_FILTER_SQL = "2026-01-01 00:00:00";

    const SYNC_STATUSES = [/^Unshipped$/i, /^PartiallyShipped$/i, /^Shipped$/i, /^InvoiceUnconfirmed$/i];

    // ── Fetch all DB connections in parallel ────────────────────────────────
    log.info("[SO Stage Dummy] Fetching data sources in parallel...");

    const [ebp_db, tpx_db, ns_db, po_db, newegg_db, walmart_db] = await Promise.all([
        getDb("ebp_marketplace"),
        getDb("tpx_orders"),
        getDb("netsuite"),
        getDb("ebp_pomanager"),
        getDb("new_eggs"),
        getDb("walmarts"),
    ]);

    // ── Fetch all data sources concurrently ─────────────────────────────────
    // Sequential fetch
    const amazonDocs = await ebp_db.collection("amazon_orders_v3").find({
        EarliestShipDate: { $gt: DATE_FILTER },
        OrderStatus: { $in: SYNC_STATUSES }
    }).toArray();
    const tpxDocs = await tpx_db.collection("tpx_orders").find(
        {
            store_type: { $nin: [/^shopify$/i, /^ebay$/i] },
            $or: [{ created_at: { $gt: new Date(DATE_FILTER) } }, { created_at: null }]
        },
        { projection: { txn_id: 1, store_type: 1 } }
    ).toArray();

    const suiteDocs = await ns_db.collection("suite_list").find(
        {}, { projection: { vendorname: 1, vendor: 1 } }
    ).toArray();

    const poDocs = await po_db.collection("po_management").find({
        created_at: { $gt: DATE_FILTER_SQL }
    }).toArray();

    const neweggDocs = await newegg_db.collection("newegg_orders_v2").find({
        OrderDate: { $gt: new Date(DATE_FILTER) }
    }).toArray();

    const neweggBusinessDocs = await newegg_db.collection("newegg_bb_orders_v2").find({
        OrderDate: { $gt: new Date(DATE_FILTER) }
    }).toArray();

    const walmartDocs = await walmart_db.collection("walmart_orders_v2").find({
        createdAt: { $gt: new Date(DATE_FILTER) }
    }).toArray();

    const tpxOrderDocs = await tpx_db.collection("tpx_orders").find({
        store_type: { $in: [/^shopify$/i, /^ebay$/i] },
        $or: [{ created_at: { $gt: new Date(DATE_FILTER) } }, { created_at: null }]
    }).toArray();

    // ── Build shared lookup maps ────────────────────────────────────────────
    const tpxMap = new Map<string, { store_type: string }>();
    for (const tpx of tpxDocs) {
        if (tpx?.txn_id) tpxMap.set(tpx.txn_id, { store_type: tpx.store_type || "" });
    }
    log.info(`[SO Stage Dummy] TPX map: ${tpxMap.size} entries`);

    const skuVendorMap = new Map<string, number>();
    for (const item of suiteDocs) {
        if (item?.vendorname && item?.vendor)
            skuVendorMap.set(String(item.vendorname).trim().toUpperCase(), item.vendor);
    }
    log.info(`[SO Stage Dummy] SKU→vendor map: ${skuVendorMap.size} entries`);

    const po_map = new Map<string, SimplePO[]>();
    for (const po of poDocs) {
        const orderId = po.website_order_number;
        if (!orderId) continue;
        let poVendor: number | null = null;
        if (Array.isArray(po.order_items) && po.order_items.length > 0) {
            const firstSku = String(po.order_items[0]?.sku || "").trim().toUpperCase();
            poVendor = skuVendorMap.get(firstSku) || null;
        }
        if (!po_map.has(orderId)) po_map.set(orderId, []);
        po_map.get(orderId)!.push({ po_number: po.po_number, po_vendor: poVendor, order_items: po.order_items || [] });
    }

    log.info(`[SO Stage Dummy] Sources — Amazon: ${amazonDocs.length}, Newegg: ${neweggDocs.length}, Newegg Business: ${neweggBusinessDocs.length}, Walmart: ${walmartDocs.length}, TPX(Shopify/eBay): ${tpxOrderDocs.length}, PO map: ${po_map.size} order IDs`);

    // ── Build sales orders from all sources ─────────────────────────────────
    log.info("[SO Stage Dummy] Building sales orders from all sources...");

    const amazonOrders         = buildAmazonOrders(amazonDocs, tpxMap, po_map);
    const neweggOrders         = buildNeweggOrders(neweggDocs, po_map, "newegg");
    const neweggBusinessOrders = buildNeweggOrders(neweggBusinessDocs, po_map, "newegg_business");
    const walmartOrders        = buildWalmartOrders(walmartDocs, po_map);
    const tpxOrders            = buildTpxOrders(tpxOrderDocs, po_map);

    const sales_orders: SalesOrder[] = [
        ...amazonOrders,
        ...neweggOrders,
        ...neweggBusinessOrders,
        ...walmartOrders,
        ...tpxOrders,
    ];

    log.info(`[SO Stage Dummy] Built — Amazon: ${amazonOrders.length}, Newegg: ${neweggOrders.length}, Walmart: ${walmartOrders.length}, TPX: ${tpxOrders.length}, Total: ${sales_orders.length}`);

    // ── Stats: available (before item filter) ────────────────────────────────
    const available = {
        amazon:  amazonOrders.length,
        newegg:  neweggOrders.length,
        newegg_business: neweggBusinessOrders.length,
        walmart: walmartOrders.length,
        tpx:     tpxOrders.length,
        total:   sales_orders.length,
    };
// ] [SO Stage Dummy] BulkWrite result — upserted: 174, modified: 301, matched: 301
// ] [SO Stage Dummy] Done. Processed 17901 orders (475 updated/new, 17426 skipped).
    // ── Filter: only orders with at least 1 item ─────────────────────────────
    const amazonWithItems         = amazonOrders.filter(o => o.items && o.items.length > 0);
    const neweggWithItems         = neweggOrders.filter(o => o.items && o.items.length > 0);
    const neweggBusinessWithItems = neweggBusinessOrders.filter(o => o.items && o.items.length > 0);
    const walmartWithItems        = walmartOrders.filter(o => o.items && o.items.length > 0);
    const tpxWithItems            = tpxOrders.filter(o => o.items && o.items.length > 0);

    const sales_orders_with_items = [
        ...amazonWithItems,
        ...neweggWithItems,
        ...neweggBusinessWithItems,
        ...walmartWithItems,
        ...tpxWithItems,
    ];

    // ── Stats: staged (after item filter) ────────────────────────────────────
    const staged = {
        amazon:  amazonWithItems.length,
        newegg:  neweggWithItems.length,
        newegg_business: neweggBusinessWithItems.length,
        walmart: walmartWithItems.length,
        tpx:     tpxWithItems.length,
        total:   sales_orders_with_items.length,
    };

    // ── Stats: dropped (no items) ─────────────────────────────────────────────
    const dropped = {
        amazon:  available.amazon  - staged.amazon,
        newegg:  available.newegg  - staged.newegg,
        newegg_business: available.newegg_business - staged.newegg_business,
        walmart: available.walmart - staged.walmart,
        tpx:     available.tpx     - staged.tpx,
        total:   available.total   - staged.total,
    };

    log.info(
        `[SO Stage Dummy] Available → Amazon: ${available.amazon}, Newegg: ${available.newegg}, ` +
        `Walmart: ${available.walmart}, TPX: ${available.tpx}, Total: ${available.total}`
    );
    log.info(
        `[SO Stage Dummy] Staged (with items) → Amazon: ${staged.amazon}, Newegg: ${staged.newegg}, ` +
        `Walmart: ${staged.walmart}, TPX: ${staged.tpx}, Total: ${staged.total}`
    );
    log.info(
        `[SO Stage Dummy] Dropped (no items) → Amazon: ${dropped.amazon}, Newegg: ${dropped.newegg}, ` +
        `Walmart: ${dropped.walmart}, TPX: ${dropped.tpx}, Total: ${dropped.total}`
    );

    // ── Smart Upsert (Change Detection) ─────────────────────────────────────
    log.info(`[SO Stage Dummy] Checking for changes among ${staged.total} sales orders with items...`);
    
    // 1. Fetch existing records to compare against (from dummy collection)
    const existingCursor = ns_db.collection(stagesCollection).find({
        $or: sales_orders_with_items.map(o => ({ 
            otherrefnum: o.otherrefnum, 
            order_source: o.order_source 
        }))
    });
    
    const existingRecords = await existingCursor.toArray();
    const existingMap = new Map();
    for (const rec of existingRecords) {
        existingMap.set(`${rec.order_source}_${rec.otherrefnum}`, rec);
    }

    // 2. Fields to compare
    const SO_CONTENT_FIELDS: (keyof SalesOrder)[] = [
        "otherrefnum", "trandate", "store_type", "order_source", 
        "order_status", "fulfillment_channel", "ship_date", 
        "items_shipped", "items_unshipped", "items", "shipping_address"
    ];

    let actuallyUpdated = 0;
    let actuallySkipped = 0;
    const bulkOps: any[] = [];

    for (const order of sales_orders_with_items) {
        const key = `${order.order_source}_${order.otherrefnum}`;
        const existing = existingMap.get(key);

        let changed = true;
        if (existing) {
            // Compare fields
            let allMatch = true;
            for (const field of SO_CONTENT_FIELDS) {
                const aVal = JSON.stringify(order[field] ?? null);
                const bVal = JSON.stringify(existing[field] ?? null);
                if (aVal !== bVal) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) changed = false;
        }

        if (!changed) {
            actuallySkipped++;
            continue;
        }

        actuallyUpdated++;
        bulkOps.push({
            updateOne: {
                filter: { otherrefnum: order.otherrefnum, order_source: order.order_source },
                update: { 
                    $set: order,
                    // If content changed, we must unset sync flags so the sync script picks it up again
                    $unset: {
                        ns_synced: "",
                        ns_result: "",
                        ns_error: "",
                        ns_note: "",
                        ns_failed: "",
                        ns_retry_count: "",
                        ns_error_at: "",
                        ns_note_at: "",
                        ns_synced_at: ""
                    }
                },
                upsert: true
            }
        });
    }

    if (bulkOps.length > 0) {
        log.info(`[SO Stage Dummy] Upserting ${bulkOps.length} changed/new sales orders...`);
        const bulkResult = await ns_db.collection(stagesCollection).bulkWrite(bulkOps);
        log.info(
            `[SO Stage Dummy] BulkWrite result — upserted: ${bulkResult.upsertedCount}, ` +
            `modified: ${bulkResult.modifiedCount}, matched: ${bulkResult.matchedCount}`
        );
    } else {
        log.info(`[SO Stage Dummy] No content changes detected in any of the ${staged.total} orders. Skipping DB write.`);
    }

    log.info(`[SO Stage Dummy] Done. Processed ${staged.total} orders (${actuallyUpdated} updated/new, ${actuallySkipped} skipped).`);

    return {
        available,
        staged,
        dropped,
        processed: staged.total,
    };
};

/**
 * Audit and reconcile Sales Orders between staging and NetSuite dump
 */
export const runSalesOrderReconciliation = async () => {
    log.info("=== Sales Order Reconciliation (Audit) ===");

    const ns_db = await getDb("netsuite");
    const dumpCollection = ns_db.collection("so_dump_test");
    const dummyCollection = ns_db.collection(stagesCollection);

    // 1. Fetch all NetSuite Dump records
    log.info("[SO Audit] Fetching NetSuite Dump records...");
    const dumpDocs = await dumpCollection.find({}, { projection: { "so.id": 1, "so.otherRefNum": 1, "so.tranid": 1 } }).toArray();
    
    // Map dump by otherRefNum (Amazon Order ID / Customer Ref)
    const dumpMap = new Map<string, any>();
    for (const doc of dumpDocs) {
        const ref = String(doc.so?.otherRefNum || "").trim();
        if (ref) dumpMap.set(ref, doc);
    }
    log.info(`[SO Audit] NetSuite Dump: ${dumpDocs.length} records (${dumpMap.size} unique references)`);

    // 2. Fetch all Staging Dummy records
    log.info("[SO Audit] Fetching Staging Dummy records...");
    const dummyDocs = await dummyCollection.find({}, { 
        projection: { otherrefnum: 1, ns_synced: 1, ns_failed: 1, ns_error: 1 } 
    }).toArray();
    
    log.info(`[SO Audit] Staging Dummy: ${dummyDocs.length} records`);

    // 3. Cross-reference
    let syncedInNs = 0;
    let missingInNs = 0;
    let ghostSynced = 0; // Exists in NS but marked false in Mongo

    const ghostOrders: string[] = [];
    const errorDistribution = new Map<string, number>();

    for (const doc of dummyDocs) {
        const ref = String(doc.otherrefnum || "").trim();
        const inDump = dumpMap.get(ref);

        if (inDump) {
            syncedInNs++;
            if (doc.ns_synced !== true) {
                ghostSynced++;
                ghostOrders.push(ref);

                // Collect error
                const errMsg = String(doc.ns_error || "NO_ERROR_MSG").split("\n")[0]; // Just take first line for grouping
                errorDistribution.set(errMsg, (errorDistribution.get(errMsg) || 0) + 1);
            }
        } else {
            missingInNs++;
        }
    }

    log.info("\n--- SUMMARY ---");
    log.info(`✅ Total Matched in NetSuite: ${syncedInNs}`);
    log.info(`❌ Total Missing in NetSuite: ${missingInNs}`);
    log.info(`⚠️  Ghost Synced (In NS but ns_synced=false): ${ghostSynced}`);

    if (errorDistribution.size > 0) {
        log.info("\n--- ERROR DISTRIBUTION (Ghost Synced Only) ---");
        const sortedErrors = [...errorDistribution.entries()].sort((a, b) => b[1] - a[1]);
        for (const [err, count] of sortedErrors) {
            log.info(`📊 ${count.toString().padEnd(6)} | ${err}`);
        }
    }

    if (ghostOrders.length > 0) {
        log.warn(`[SO Audit] Found ${ghostOrders.length} Ghost Synced records. Example: ${ghostOrders.slice(0, 5).join(", ")}`);
    }

    log.info("=== RECONCILIATION DONE ===");
    return {
        dumpCount: dumpDocs.length,
        dummyCount: dummyDocs.length,
        syncedInNs,
        missingInNs,
        ghostSynced
    };
};


// ── Main Staging Function ───────────────────────────────────────────────────

// export const stageSalesOrders = async (): Promise<{
//     processed: number;
//     available: { amazon: number; newegg: number; walmart: number; tpx: number; total: number };
//     staged:    { amazon: number; newegg: number; walmart: number; tpx: number; total: number };
//     dropped:   { amazon: number; newegg: number; walmart: number; tpx: number; total: number };
// }> => {

//     log.info("[SO Stage] Starting...");

//     const DATE_FILTER     = "2026-01-01T00:00:00Z";
//     const DATE_FILTER_SQL = "2026-01-01 00:00:00";

//     const SYNC_STATUSES = [/^Unshipped$/i, /^PartiallyShipped$/i, /^Shipped$/i, /^InvoiceUnconfirmed$/i];

//     // ── Fetch all DB connections in parallel ────────────────────────────────
//     log.info("[SO Stage] Fetching data sources in parallel...");

//     const [ebp_db, tpx_db, ns_db, po_db, newegg_db, walmart_db] = await Promise.all([
//         getDb("ebp_marketplace"),
//         getDb("tpx_orders"),
//         getDb("netsuite"),
//         getDb("ebp_pomanager"),
//         getDb("new_eggs"),
//         getDb("walmarts"),
//     ]);

//     // ── Fetch all data sources concurrently ─────────────────────────────────
//     const [amazonDocs, tpxDocs, suiteDocs, poDocs, neweggDocs, neweggBusinessDocs, walmartDocs, tpxOrderDocs] = await Promise.all([
//         // 1. Amazon orders
//         ebp_db.collection("amazon_orders_v3").find({
//         EarliestShipDate: { $gt: DATE_FILTER },
//         OrderStatus: { $in: SYNC_STATUSES }
//         }).toArray(),

//         // 2. TPX orders (store_type lookup — excludes shopify/ebay which have their own adapter)
//         tpx_db.collection("tpx_orders").find(
//         {
//             store_type: { $nin: [/^shopify$/i, /^ebay$/i] },
//             $or: [{ created_at: { $gt: new Date(DATE_FILTER) } }, { created_at: null }]
//         },
//         { projection: { txn_id: 1, store_type: 1 } }
//         ).toArray(),

//         // 3. SKU → vendor map
//         ns_db.collection("suite_list").find(
//         {}, { projection: { vendorname: 1, vendor: 1 } }
//         ).toArray(),

//         // 4. PO management
//         po_db.collection("po_management").find({
//         created_at: { $gt: DATE_FILTER_SQL }
//         }).toArray(),

//         // 5. Newegg orders (regular)
//         newegg_db.collection("newegg_orders_v2").find({
//         OrderDate: { $gt: new Date(DATE_FILTER) }
//         }).toArray(),

//         // 6. Newegg BB orders (business)
//         newegg_db.collection("newegg_bb_orders_v2").find({
//         OrderDate: { $gt: new Date(DATE_FILTER) }
//         }).toArray(),

//         // 7. Walmart orders
//         walmart_db.collection("walmart_orders_v2").find({
//         createdAt: { $gt: new Date(DATE_FILTER) }
//         }).toArray(),

//         // 8. TPX orders for Shopify/eBay (full documents, not just store_type lookup)
//         tpx_db.collection("tpx_orders").find({
//         store_type: { $in: [/^shopify$/i, /^ebay$/i] },
//         $or: [{ created_at: { $gt: new Date(DATE_FILTER) } }, { created_at: null }]
//         }).toArray(),
//     ]);

//     // ── Build shared lookup maps ────────────────────────────────────────────
//     const tpxMap = new Map<string, { store_type: string }>();
//     for (const tpx of tpxDocs) {
//         if (tpx?.txn_id) tpxMap.set(tpx.txn_id, { store_type: tpx.store_type || "" });
//     }
//     log.info(`[SO Stage] TPX map: ${tpxMap.size} entries`);

//     const skuVendorMap = new Map<string, number>();
//     for (const item of suiteDocs) {
//         if (item?.vendorname && item?.vendor)
//             skuVendorMap.set(String(item.vendorname).trim().toUpperCase(), item.vendor);
//     }
//     log.info(`[SO Stage] SKU→vendor map: ${skuVendorMap.size} entries`);

//     const po_map = new Map<string, SimplePO[]>();
//     for (const po of poDocs) {
//         const orderId = po.website_order_number;
//         if (!orderId) continue;
//         let poVendor: number | null = null;
//         if (Array.isArray(po.order_items) && po.order_items.length > 0) {
//             const firstSku = String(po.order_items[0]?.sku || "").trim().toUpperCase();
//             poVendor = skuVendorMap.get(firstSku) || null;
//         }
//         if (!po_map.has(orderId)) po_map.set(orderId, []);
//         po_map.get(orderId)!.push({ po_number: po.po_number, po_vendor: poVendor, order_items: po.order_items || [] });
//     }


//     log.info(`[SO Stage] Sources — Amazon: ${amazonDocs.length}, Newegg: ${neweggDocs.length}, Newegg Business: ${neweggBusinessDocs.length}, Walmart: ${walmartDocs.length}, TPX(Shopify/eBay): ${tpxOrderDocs.length}, PO map: ${po_map.size} order IDs`);

//     // ── Build sales orders from all sources ─────────────────────────────────
//     log.info("[SO Stage] Building sales orders from all sources...");

//     const amazonOrders         = buildAmazonOrders(amazonDocs, tpxMap, po_map);
//     const neweggOrders         = buildNeweggOrders(neweggDocs, po_map, "newegg");
//     const neweggBusinessOrders = buildNeweggOrders(neweggBusinessDocs, po_map, "newegg_business");
//     const walmartOrders        = buildWalmartOrders(walmartDocs, po_map);
//     const tpxOrders            = buildTpxOrders(tpxOrderDocs, po_map);

//     const sales_orders: SalesOrder[] = [
//         ...amazonOrders,
//         ...neweggOrders,
//         ...neweggBusinessOrders,
//         ...walmartOrders,
//         ...tpxOrders,
//     ];

//     log.info(`[SO Stage] Built — Amazon: ${amazonOrders.length}, Newegg: ${neweggOrders.length}, Newegg Business: ${neweggBusinessOrders.length}, Walmart: ${walmartOrders.length}, TPX: ${tpxOrders.length}, Total: ${sales_orders.length}`);

//     // ── Stats: available (before item filter) ────────────────────────────────
//     const available = {
//         amazon:  amazonOrders.length,
//         newegg:  neweggOrders.length,
//         newegg_business: neweggBusinessOrders.length,
//         walmart: walmartOrders.length,
//         tpx:     tpxOrders.length,
//         total:   sales_orders.length,
//     };

//     // ── Filter: only orders with at least 1 item ─────────────────────────────

//     const amazonWithItems         = amazonOrders.filter(o => o.items && o.items.length > 0);
//     const neweggWithItems         = neweggOrders.filter(o => o.items && o.items.length > 0);
//     const neweggBusinessWithItems = neweggBusinessOrders.filter(o => o.items && o.items.length > 0);
//     const walmartWithItems        = walmartOrders.filter(o => o.items && o.items.length > 0);
//     const tpxWithItems            = tpxOrders.filter(o => o.items && o.items.length > 0);

//     const sales_orders_with_items = [
//         ...amazonWithItems,
//         ...neweggWithItems,
//         ...neweggBusinessWithItems,
//         ...walmartWithItems,
//         ...tpxWithItems,
//     ];

//     // ── Stats: staged (after item filter) ────────────────────────────────────
//     const staged = {
//         amazon:  amazonWithItems.length,
//         newegg:  neweggWithItems.length,
//         newegg_business: neweggBusinessWithItems.length,
//         walmart: walmartWithItems.length,
//         tpx:     tpxWithItems.length,
//         total:   sales_orders_with_items.length,
//     };

//     // ── Stats: dropped (no items) ─────────────────────────────────────────────
//     const dropped = {
//         amazon:  available.amazon  - staged.amazon,
//         newegg:  available.newegg  - staged.newegg,
//         newegg_business: available.newegg_business - staged.newegg_business,
//         walmart: available.walmart - staged.walmart,
//         tpx:     available.tpx     - staged.tpx,
//         total:   available.total   - staged.total,
//     };

//     log.info(
//         `[SO Stage] Available → Amazon: ${available.amazon}, Newegg: ${available.newegg}, ` +
//         `Walmart: ${available.walmart}, TPX: ${available.tpx}, Total: ${available.total}`
//     );
//     log.info(
//         `[SO Stage] Staged (with items) → Amazon: ${staged.amazon}, Newegg: ${staged.newegg}, ` +
//         `Walmart: ${staged.walmart}, TPX: ${staged.tpx}, Total: ${staged.total}`
//     );
//     log.info(
//         `[SO Stage] Dropped (no items) → Amazon: ${dropped.amazon}, Newegg: ${dropped.newegg}, ` +
//         `Walmart: ${dropped.walmart}, TPX: ${dropped.tpx}, Total: ${dropped.total}`
//     );

//     // ── Smart Upsert (Change Detection) ─────────────────────────────────────
//     log.info(`[SO Stage] Checking for changes among ${staged.total} sales orders with items...`);
    
//     // 1. Fetch existing records to compare against
//     const existingCursor = ns_db.collection(stagesCollection).find({
//         $or: sales_orders_with_items.map(o => ({ 
//             otherrefnum: o.otherrefnum, 
//             order_source: o.order_source 
//         }))
//     });
    
//     const existingRecords = await existingCursor.toArray();
//     const existingMap = new Map();
//     for (const rec of existingRecords) {
//         existingMap.set(`${rec.order_source}_${rec.otherrefnum}`, rec);
//     }

//     // 2. Fields to compare
//     const SO_CONTENT_FIELDS: (keyof SalesOrder)[] = [
//         "otherrefnum", "trandate", "store_type", "order_source", 
//         "order_status", "fulfillment_channel", "ship_date", 
//         "items_shipped", "items_unshipped", "items", "shipping_address"
//     ];

//     let actuallyUpdated = 0;
//     let actuallySkipped = 0;
//     const bulkOps: any[] = [];

//     for (const order of sales_orders_with_items) {
//         const key = `${order.order_source}_${order.otherrefnum}`;
//         const existing = existingMap.get(key);

//         let changed = true;
//         if (existing) {
//             // Compare fields
//             let allMatch = true;
//             for (const field of SO_CONTENT_FIELDS) {
//                 const aVal = JSON.stringify(order[field] ?? null);
//                 const bVal = JSON.stringify(existing[field] ?? null);
//                 if (aVal !== bVal) {
//                     allMatch = false;
//                     break;
//                 }
//             }
//             if (allMatch) changed = false;
//         }

//         if (!changed) {
//             actuallySkipped++;
//             continue;
//         }

//         actuallyUpdated++;
//         bulkOps.push({
//             updateOne: {
//                 filter: { otherrefnum: order.otherrefnum, order_source: order.order_source },
//                 update: { 
//                     $set: order,
//                     // If content changed, we must unset sync flags so the sync script picks it up again
//                     $unset: {
//                         ns_synced: "",
//                         ns_result: "",
//                         ns_error: "",
//                         ns_note: "",
//                         ns_failed: "",
//                         ns_retry_count: "",
//                         ns_error_at: "",
//                         ns_note_at: "",
//                         ns_synced_at: ""
//                     }
//                 },
//                 upsert: true
//             }
//         });
//     }

//     if (bulkOps.length > 0) {
//         log.info(`[SO Stage] Upserting ${bulkOps.length} changed/new sales orders...`);
//         const bulkResult = await ns_db.collection(stagesCollection).bulkWrite(bulkOps);
//         log.info(
//             `[SO Stage] BulkWrite result — upserted: ${bulkResult.upsertedCount}, ` +
//             `modified: ${bulkResult.modifiedCount}, matched: ${bulkResult.matchedCount}`
//         );
//     } else {
//         log.info(`[SO Stage] No content changes detected in any of the ${staged.total} orders. Skipping DB write.`);
//     }

//     log.info(`[SO Stage] Done. Processed ${staged.total} orders (${actuallyUpdated} updated/new, ${actuallySkipped} skipped).`);

//     return {
//         available,
//         staged,
//         dropped,
//         processed: staged.total,
//     };
// };