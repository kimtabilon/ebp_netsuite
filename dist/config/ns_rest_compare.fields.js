"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NS_REST_COMPARE_LOG_COLLECTION = exports.NS_REST_COMPARE_FIELD_PATHS = void 0;
/**
 * Dot-path fields on each REST `payload` compared against the last document in the matching dump collection.
 * Extend per your NetSuite schema (REST field names vary by record type / account).
 */
exports.NS_REST_COMPARE_FIELD_PATHS = {
    sales_order: [
        "tranId",
        "status",
        "orderStatus",
        "lastModifiedDate",
        "total",
        "entity.id",
        "dueDate",
        "shipDate",
    ],
    purchase_order: [
        "tranId",
        "status",
        "lastModifiedDate",
        "total",
        "entity.id",
        "dueDate",
    ],
    inventory_item: [
        "itemId",
        "displayName",
        "lastModifiedDate",
        "subsidiary",
        "isInactive",
    ],
    classification: ["name", "lastModifiedDate", "includeChildren"],
    item_fulfillment: ["tranId", "lastModifiedDate", "status", "shipStatus", "memo"],
    item_receipt: ["tranId", "lastModifiedDate", "status", "memo"],
};
exports.NS_REST_COMPARE_LOG_COLLECTION = "ns_rest_compare_diff_log";
