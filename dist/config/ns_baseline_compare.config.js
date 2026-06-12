"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NS_BASELINE_COMPARE = void 0;
exports.NS_BASELINE_COMPARE = {
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
            { dbField: "po_number", kind: "number", restPath: "tranId", coerce: "digits_to_number" },
            { dbField: "website_order_number", kind: "string", restPath: "otherRefNum" },
            { dbField: "distributor", kind: "string", restPath: "entity.refName" },
            { dbField: "distributor_order_number", kind: "string", restPath: "" },
            { dbField: "status", kind: "string", restPath: "status.refName" },
            { dbField: "invoice", kind: "array", restPath: "" },
            { dbField: "vendor_id", kind: "number", restPath: "entity.id", coerce: "numeric_id" },
            { dbField: "tracking", kind: "string", restPath: "" },
            {
                dbField: "order_items",
                kind: "array",
                restPath: "item.items",
                arrayCompare: "purchase_order_lines",
            },
            { dbField: "po_type", kind: "string", restPath: "" },
            { dbField: "stocking_warehouse", kind: "string", restPath: "location.refName" },
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
