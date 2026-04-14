/**
 * Compare live NetSuite REST payloads to operational Mongo documents.
 *
 * `kind` documents the baseline (DB) shape; comparison still uses `restPath` on the REST body.
 * Leave `restPath` as "" to skip that field until you map it to your account’s REST/custbody fields.
 */
export type BaselineValueKind = "string" | "number" | "object" | "array";

export type BaselineCompareCoerce =
    | "digits_to_number"
    /** entity.id (string/number) vs vendor_id */
    | "numeric_id"
    /** ISO or Date-like string vs Date in Mongo */
    | "date_loose"
    /** E.g. "Invoiced" vs "invoiced" */
    | "lowercase_string"
    /** SuiteTalk `entity.refName` often has a numeric index prefix vs plain distributor string in Mongo */
    | "netsuite_vendor_refname"
    /** `location.refName` (NetSuite) vs `stocking_warehouse` code (MW, W2G-IL, …); DropShip → "" */
    | "warehouse_from_location_refname";

/** Semantic line-list compare (not raw REST JSON vs staging). */
export type BaselineArrayCompareMode =
    | "sales_order_lines"
    | "purchase_order_lines"
    /** EBP `invoice` on suite_purchase_order vs no equivalent on SuiteTalk PO — REST treated as []. */
    | "purchase_order_invoice";

export type BaselineCompareFieldSpec = {
    /** Field on the baseline Mongo document (e.g. suite_sales_order) */
    dbField: string;
    kind: BaselineValueKind;
    /** Dot path on NetSuite REST JSON; empty string = skip compare for this field */
    restPath: string;
    coerce?: BaselineCompareCoerce;
    /**
     * For line sublists: read `item.items` or top-level `items`, normalize to staging shape, then compare.
     * Avoids diffing full REST line blobs (links, nested item refs) against `suite_*` line arrays.
     */
    arrayCompare?: BaselineArrayCompareMode;
};

export type BaselineCompareVariant =
    | "sales_order_staged"
    | "purchase_order_staged"
    | "inventory_item_full"
    | "classification_tree";

export const NS_BASELINE_COMPARE: Record<
    BaselineCompareVariant,
    {
        baselineCollection: string;
        logRecordType: string;
        compareFields: BaselineCompareFieldSpec[];
    }
> = {
    /**
     * REST paths aligned to SuiteTalk salesOrder payload (your dump: ns_rest_sales_order_detail_dump.payload).
     * - Lines: use GET with item sublist expanded → `item.items`; list-only payload may only have `item.links`.
     * - Structured ship addr: expand `shippingAddress` subrecord, or compare flat `shippingAddress_text` / `shipAddress` to staging (shape may still differ).
     */
    sales_order_staged: {
        baselineCollection: "suite_sales_order",
        logRecordType: "sales_order",
        compareFields: [
            { dbField: "order_source", kind: "string", restPath: "csegecomm_channel.refName" },
            { dbField: "otherrefnum", kind: "string", restPath: "otherRefNum" },
            { dbField: "fulfillment_channel", kind: "string", restPath: "custbody3" },
            {
                dbField: "items",
                kind: "array",
                restPath: "item.items",
                arrayCompare: "sales_order_lines",
            },
            { dbField: "items_shipped", kind: "number", restPath: "" },
            { dbField: "items_unshipped", kind: "number", restPath: "" },
            { dbField: "order_status", kind: "string", restPath: "orderStatus.refName" },
            { dbField: "ship_date", kind: "string", restPath: "shipDate" },
            {
                dbField: "shipping_address",
                kind: "object",
                restPath: "shippingAddress_text",
            },
            { dbField: "store_type", kind: "string", restPath: "entity.refName" },
            { dbField: "trandate", kind: "string", restPath: "tranDate", coerce: "date_loose" },
        ],
    },
    purchase_order_staged: {
        baselineCollection: "suite_purchase_order",
        logRecordType: "purchase_order",
        compareFields: [
            /** Sync sets `otherrefnum` = po_number — use before `tranId` (e.g. PO224305 vs internal-style tranId). */
            { dbField: "po_number", kind: "number", restPath: "otherRefNum", coerce: "digits_to_number" },
            /** Not written on the PO header by the EBP RESTlet today — no stable SuiteTalk path; skipped until mapped. */
            { dbField: "website_order_number", kind: "string", restPath: "" },
            {
                dbField: "distributor",
                kind: "string",
                restPath: "custbody_otherrefnumber_custom",
                coerce: "netsuite_vendor_refname",
            },
            { dbField: "distributor_order_number", kind: "string", restPath: "custbody2" },
            /** RESTlet stores EBP status in `custbody1`, not standard PO workflow status. */
            { dbField: "status", kind: "string", restPath: "custbody1", coerce: "lowercase_string" },
            {
                dbField: "invoice",
                kind: "array",
                restPath: "",
                arrayCompare: "purchase_order_invoice",
            },
            { dbField: "vendor_id", kind: "number", restPath: "entity.id", coerce: "numeric_id" },
            /** Not set by EBP PO RESTlet on the header — skip until you expose tracking on a body field. */
            { dbField: "tracking", kind: "string", restPath: "" },
            {
                dbField: "order_items",
                kind: "array",
                restPath: "item.items",
                arrayCompare: "purchase_order_lines",
            },
            /** Not persisted on the PO record by the RESTlet — skip. */
            { dbField: "po_type", kind: "string", restPath: "" },
            {
                dbField: "stocking_warehouse",
                kind: "string",
                restPath: "location.refName",
                coerce: "warehouse_from_location_refname",
            },
            { dbField: "created_at", kind: "string", restPath: "createdDate", coerce: "date_loose" },
            { dbField: "updated_at", kind: "string", restPath: "lastModifiedDate", coerce: "date_loose" },
        ],
    },
    inventory_item_full: {
        baselineCollection: "netsuite_items_full",
        logRecordType: "inventory_item",
        compareFields: [
            { dbField: "itemid", kind: "string", restPath: "itemId" },
            { dbField: "displayname", kind: "string", restPath: "displayName" },
            { dbField: "isinactive", kind: "string", restPath: "isInactive" },
        ],
    },
    classification_tree: {
        baselineCollection: "netsuite_classifications",
        logRecordType: "classification",
        compareFields: [
            { dbField: "name", kind: "string", restPath: "name" },
            { dbField: "fullname", kind: "string", restPath: "fullname" },
        ],
    },
};
