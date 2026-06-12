/**
 * NETSUITE RESTLET — Item Fulfillment Sync (EBP) v3
 * Fixed: Inventory detail field names for IF vs IR, proper serial/lot handling
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log", "N/query"], function (record, search, log, query) {
    var nsLog = log;

    var DROPSHIP_LOCATION_NAME = "Dropship";
    var FORM_NAME = "Ecom BP Fulfillment";

    var _locationCache = {};
    var _formCache = {};

    // ── Helpers ───────────────────────────────────────────────────────────────

    function findLocationByName(name) {
        if (_locationCache[name]) return _locationCache[name];
        var results = search.create({
            type: search.Type.LOCATION,
            filters: [["name", "is", name], "AND", ["isinactive", "is", "F"]],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });
        if (results.length === 0) return null;
        var id = parseInt(results[0].id, 10);
        _locationCache[name] = id;
        return id;
    }

    function findFormId(formName) {
        if (_formCache[formName]) return _formCache[formName];
        try {
            var results = search.create({
                type: "itemfulfillment",
                filters: [["mainline", "is", "T"]],
                columns: [search.createColumn({ name: "customform" })]
            }).run().getRange({ start: 0, end: 50 });
            for (var i = 0; i < results.length; i++) {
                var fName = results[i].getText("customform");
                var fId = results[i].getValue("customform");
                if (fName && fName.indexOf(formName) >= 0) {
                    _formCache[formName] = fId;
                    return fId;
                }
            }
        } catch (e) { log.debug("FORM_SEARCH_ERR", e.message); }
        return null;
    }

    function findSOByPOLinkage(poNumber) {
        if (!poNumber) return null;
        var poStr = String(poNumber).trim();
        var searchPatterns = [poStr, "PO" + poStr, "po" + poStr];
        
        try {
            var poResults = search.create({
                type: search.Type.PURCHASE_ORDER,
                filters: [
                    ["mainline", "is", "T"],
                    "AND",
                    [
                        ["tranid", "is", searchPatterns[0]],
                        "OR",
                        ["tranid", "is", searchPatterns[1]],
                        "OR",
                        ["tranid", "is", searchPatterns[2]]
                    ]
                ],
                columns: ["internalid", "tranid", "createdfrom"]
            }).run().getRange({ start: 0, end: 1 });
            
            if (poResults.length === 0) {
                log.audit("PO_LINKAGE", "No PO found for: " + poStr);
                return null;
            }
            
            var poId = parseInt(poResults[0].id, 10);
            var poTranId = poResults[0].getValue("tranid");
            var createdFromVal = poResults[0].getValue("createdfrom");
            var createdFromText = poResults[0].getText("createdfrom") || "";
            
            if (createdFromVal) {
                log.audit("PO_LINKAGE_SUCCESS", "Found SO ID: " + createdFromVal + " (Name: " + createdFromText + ") linked to PO " + poTranId);
                return { 
                    id: parseInt(createdFromVal, 10), 
                    tranid: createdFromText,
                    otherrefnum: "",
                    source: "po_linkage",
                    poId: poId
                };
            }
            
            log.audit("PO_LINKAGE", "No SO found linked to PO " + poTranId);
            return null;
            
        } catch (e) {
            log.debug("PO_LINKAGE_ERR", e.message);
            return null;
        }
    }

    function findInventoryNumberId(itemId, serialName) {
        if (!itemId || !serialName) return null;
        try {
            var sql = "SELECT id FROM inventorynumber WHERE item = ? AND inventorynumber = ?";
            var resultSet = query.runSuiteQL({ query: sql, params: [parseInt(itemId, 10), String(serialName).trim()] });
            var results = resultSet.asMappedResults();
            if (results.length > 0) {
                return parseInt(results[0].id, 10);
            }
        } catch (e) {
            log.debug("FIND_INV_NUM_ERR", "Item " + itemId + ", serial " + serialName + ": " + e.message);
        }
        return null;
    }

    function findSalesOrder(lookupVal) {
        if (!lookupVal) return null;
        var cleanRefNum = String(lookupVal).trim();
        
        if (!isNaN(cleanRefNum) && cleanRefNum.length <= 5) {
            log.audit("FIND_SO_SKIP", "Skipping short numeric key: " + cleanRefNum);
            return null;
        }

        log.audit("FIND_SO_START", "Searching Sales Order with identifier: '" + cleanRefNum + "'");
        
        try {
            var sql = "SELECT id, tranid, otherrefnum FROM transaction WHERE type = 'SalesOrd' AND (otherrefnum = ? OR tranid = ?) ORDER BY id DESC";
            var resultSet = query.runSuiteQL({ query: sql, params: [cleanRefNum, cleanRefNum] });
            var results = resultSet.asMappedResults();
            for (var i = 0; i < results.length; i++) {
                var row = results[i];
                var rowOtherRef = (row.otherrefnum || "").trim();
                var rowTranId = (row.tranid || "").trim();
                if (rowOtherRef === cleanRefNum || rowTranId === cleanRefNum) {
                    log.audit("FIND_SO_SQL_SUCCESS", "Matched SO ID: " + row.id + " (TranID: " + row.tranid + ", OtherRef: " + rowOtherRef + ")");
                    return { 
                        id: parseInt(row.id, 10), 
                        tranid: row.tranid,
                        otherrefnum: rowOtherRef,
                        source: "direct_lookup"
                    };
                }
            }
        } catch (e) {
            log.debug("FIND_SO_SUITEQL_ERR", e.message);
        }

        try {
            var results = search.create({
                type: search.Type.SALES_ORDER,
                filters: [
                    [["otherrefnum", "is", cleanRefNum], "OR", ["tranid", "is", cleanRefNum]],
                    "AND",
                    ["mainline", "is", "T"]
                ],
                columns: [
                    search.createColumn({ name: "internalid", sort: search.Sort.DESC }),
                    search.createColumn({ name: "tranid" }),
                    search.createColumn({ name: "otherrefnum" })
                ]
            }).run().getRange({ start: 0, end: 5 });
            
            for (var j = 0; j < results.length; j++) {
                var resOtherRef = (results[j].getValue("otherrefnum") || "").trim();
                var resTranId = (results[j].getValue("tranid") || "").trim();
                if (resOtherRef === cleanRefNum || resTranId === cleanRefNum) {
                    log.audit("FIND_SO_SEARCH_SUCCESS", "Matched SO ID: " + results[j].id);
                    return { 
                        id: parseInt(results[j].id, 10), 
                        tranid: resTranId,
                        otherrefnum: resOtherRef,
                        source: "direct_lookup"
                    };
                }
            }
        } catch (searchErr) {
            log.debug("FIND_SO_SEARCH_ERR", searchErr.message);
        }
        
        return null;
    }

    function findPurchaseOrder(poNumber) {
        if (!poNumber) return null;
        var poStr = String(poNumber).trim();
        var searchPatterns = [poStr, "PO" + poStr, "po" + poStr];
        
        try {
            var sql = "SELECT id, tranid FROM transaction WHERE type = 'PurchOrd' AND (tranid = ? OR tranid = ? OR tranid = ?) ORDER BY id DESC";
            var resultSet = query.runSuiteQL({ query: sql, params: [searchPatterns[0], searchPatterns[1], searchPatterns[2]] });
            var results = resultSet.asMappedResults();
            for (var i = 0; i < results.length; i++) {
                var row = results[i];
                var rowTranId = (row.tranid || "").trim().toUpperCase();
                if (rowTranId === searchPatterns[0].toUpperCase() || 
                    rowTranId === searchPatterns[1].toUpperCase() || 
                    rowTranId === searchPatterns[2].toUpperCase()) {
                    return { id: parseInt(row.id, 10), tranid: row.tranid };
                }
            }
        } catch (e) {
            log.debug("FIND_PO_SUITEQL_ERR", e.message);
        }

        try {
            var results = search.create({
                type: search.Type.PURCHASE_ORDER,
                filters: [
                    ["mainline", "is", "T"],
                    "AND",
                    [
                        ["tranid", "is", searchPatterns[0]],
                        "OR",
                        ["tranid", "is", searchPatterns[1]],
                        "OR",
                        ["tranid", "is", searchPatterns[2]]
                    ]
                ],
                columns: ["tranid"]
            }).run().getRange({ start: 0, end: 5 });
            
            for (var j = 0; j < results.length; j++) {
                var resTranId = (results[j].getValue("tranid") || "").trim().toUpperCase();
                if (resTranId === searchPatterns[0].toUpperCase() || 
                    resTranId === searchPatterns[1].toUpperCase() || 
                    resTranId === searchPatterns[2].toUpperCase()) {
                    return { id: parseInt(results[j].id, 10), tranid: resTranId };
                }
            }
        } catch (err) {
            log.debug("FIND_PO_SEARCH_ERR", err.message);
        }
        return null;
    }

    function findExistingReceipt(poId) {
        if (!poId) return null;
        var results = search.create({
            type: "itemreceipt",
            filters: [
                ["createdfrom", "anyof", poId],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [search.createColumn({ name: "internalid", sort: search.Sort.DESC })]
        }).run().getRange({ start: 0, end: 1 });
        return results.length > 0 ? parseInt(results[0].id, 10) : null;
    }

    function getPurchaseOrderStatus(poId) {
        if (!poId) return null;
        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [["internalid", "is", poId], "AND", ["mainline", "is", "T"]],
            columns: ["status"]
        }).run().getRange({ start: 0, end: 1 });
        return results.length > 0 ? results[0].getValue("status") : null;
    }

    function findExistingFulfillment(lookupVal) {
        if (!lookupVal) return null;
        var cleanVal = String(lookupVal).trim();
        try {
            var sql = "SELECT id, otherrefnum, tranid FROM transaction WHERE type = 'ItemShip' AND (otherrefnum = ? OR tranid = ?) ORDER BY id DESC";
            var resultSet = query.runSuiteQL({ query: sql, params: [cleanVal, cleanVal] });
            var results = resultSet.asMappedResults();
            for (var i = 0; i < results.length; i++) {
                var row = results[i];
                var rowOtherRef = (row.otherrefnum || "").trim();
                var rowTranId = (row.tranid || "").trim();
                if (rowOtherRef === cleanVal || rowTranId === cleanVal) {
                    return parseInt(row.id, 10);
                }
            }
        } catch (e) {
            log.debug("FIND_EXISTING_IF_SUITEQL_ERR", e.message);
        }
        try {
            var results = search.create({
                type: "itemfulfillment",
                filters: [
                    [["otherrefnum", "is", cleanVal], "OR", ["tranid", "is", cleanVal]],
                    "AND",
                    ["mainline", "is", "T"]
                ],
                columns: [
                    search.createColumn({ name: "internalid", sort: search.Sort.DESC }),
                    "otherrefnum",
                    "tranid"
                ]
            }).run().getRange({ start: 0, end: 5 });
            
            for (var j = 0; j < results.length; j++) {
                var resOtherRef = (results[j].getValue("otherrefnum") || "").trim();
                var resTranId = (results[j].getValue("tranid") || "").trim();
                if (resOtherRef === cleanVal || resTranId === cleanVal) {
                    return parseInt(results[j].id, 10);
                }
            }
        } catch (err) {
            log.debug("FIND_EXISTING_IF_SEARCH_ERR", err.message);
        }
        return null;
    }

    function findExistingFulfillmentBySO(soId) {
        var results = search.create({
            type: "itemfulfillment",
            filters: [
                ["createdfrom", "anyof", soId],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: [search.createColumn({ name: "internalid", sort: search.Sort.DESC })]
        }).run().getRange({ start: 0, end: 1 });
        return results.length > 0 ? parseInt(results[0].id, 10) : null;
    }

    // ── SO Validation ─────────────────────────────────────────────────────────

    function validateSOItems(soId, payloadItems) {
        try {
            var soRecord = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });
            
            var lineCount = soRecord.getLineCount({ sublistId: "item" });
            var soItemIds = [];
            var soItemDetails = [];
            
            for (var i = 0; i < lineCount; i++) {
                var itemId = soRecord.getSublistValue({ sublistId: "item", fieldId: "item", line: i });
                var itemDesc = soRecord.getSublistValue({ sublistId: "item", fieldId: "description", line: i }) || "";
                var itemQty = soRecord.getSublistValue({ sublistId: "item", fieldId: "quantity", line: i });
                
                if (itemId) {
                    soItemIds.push(itemId);
                    soItemDetails.push({
                        itemId: itemId,
                        description: itemDesc,
                        quantity: itemQty
                    });
                }
            }
            
            var itemDetailsMap = {};
            if (soItemIds.length > 0) {
                try {
                    var itemSql = "SELECT id, itemid, displayname, vendorname, mpn FROM item WHERE id IN (" + soItemIds.join(",") + ")";
                    var itemResultSet = query.runSuiteQL({ query: itemSql });
                    var itemResults = itemResultSet.asMappedResults();
                    for (var r = 0; r < itemResults.length; r++) {
                        var row = itemResults[r];
                        itemDetailsMap[row.id] = {
                            sku: (row.itemid || "").trim(),
                            displayName: (row.displayname || "").trim(),
                            vendorSku: (row.vendorname || "").trim(),
                            mpn: (row.mpn || "").trim()
                        };
                    }
                } catch (e) {
                    log.debug("VALIDATE_ITEM_SQL_ERR", e.message);
                }
            }
            
            var soIdentifiers = [];
            for (var d = 0; d < soItemDetails.length; d++) {
                var detail = itemDetailsMap[soItemDetails[d].itemId] || {};
                soIdentifiers.push({
                    itemId: soItemDetails[d].itemId,
                    sku: detail.sku || String(soItemDetails[d].itemId),
                    displayName: detail.displayName || "",
                    vendorSku: detail.vendorSku || "",
                    mpn: detail.mpn || "",
                    description: soItemDetails[d].description
                });
            }
            
            return {
                isValid: true,
                soItemCount: lineCount,
                soIdentifiers: soIdentifiers
            };
            
        } catch (e) {
            log.debug("VALIDATE_SO_ERR", "SO " + soId + ": " + e.message);
            return { isValid: false, error: e.message };
        }
    }

    // ── Main POST Handler ─────────────────────────────────────────────────────

    function post(payload) {
        var customLogs = [];
        var log = {
            audit: function(title, message) {
                var msgStr = typeof message === "object" ? JSON.stringify(message) : String(message);
                customLogs.push("[AUDIT] " + title + ": " + msgStr);
                nsLog.audit(title, message);
            },
            error: function(title, message) {
                var msgStr = typeof message === "object" ? JSON.stringify(message) : String(message);
                customLogs.push("[ERROR] " + title + ": " + msgStr);
                nsLog.error(title, message);
            },
            debug: function(title, message) {
                var msgStr = typeof message === "object" ? JSON.stringify(message) : String(message);
                customLogs.push("[DEBUG] " + title + ": " + msgStr);
                nsLog.debug(title, message);
            }
        };

        function executePost() {
            try {
                log.audit("IF_SYNC_START", JSON.stringify(payload));

            var websiteOrderNumber = payload.website_order_number;
            var poNumber           = payload.po_number;
            var shipDate           = payload.ship_date;
            var trackingNumber     = payload.tracking_number;
            var shipping           = payload.shipping_address || {};
            var items              = payload.items || [];
            var weightLbs          = parseFloat(payload.weight_lbs) || 1;
            var debugMode          = payload.debug === true;

            if (!websiteOrderNumber && !poNumber) {
                return { success: false, error: "Missing required lookup identifiers (website_order_number or po_number)" };
            }
            if (items.length === 0) {
                return { success: false, error: "No items provided" };
            }

            var payloadSkus = items.map(function(i) { return i.sku; });
            log.audit("PAYLOAD_ITEMS", "SKUs: [" + payloadSkus.join(", ") + "]");

            // ── SO Lookup Strategy ───────────────────────────────────────────
            var soMatch = null;
            var searchKey = null;
            var lookupMethod = null;

            if (poNumber) {
                log.audit("LOOKUP_STRATEGY", "Attempt 1: PO Linkage for po_number=" + poNumber);
                soMatch = findSOByPOLinkage(poNumber);
                if (soMatch) {
                    searchKey = poNumber;
                    lookupMethod = "po_linkage";
                }
            }

            if (!soMatch && websiteOrderNumber) {
                log.audit("LOOKUP_STRATEGY", "Attempt 2: Direct lookup for website_order_number=" + websiteOrderNumber);
                soMatch = findSalesOrder(websiteOrderNumber);
                if (soMatch) {
                    searchKey = websiteOrderNumber;
                    lookupMethod = "website_order_number";
                }
            }

            if (!soMatch && poNumber) {
                log.audit("LOOKUP_STRATEGY", "Attempt 3: Direct lookup for po_number=" + poNumber);
                soMatch = findSalesOrder(poNumber);
                if (soMatch) {
                    searchKey = poNumber;
                    lookupMethod = "po_number_direct";
                }
            }

            if (debugMode && soMatch) {
                var validation = validateSOItems(soMatch.id, items);
                return {
                    success: false,
                    debug: true,
                    lookupMethod: lookupMethod,
                    soMatch: soMatch,
                    soValidation: validation,
                    message: "DEBUG MODE: Found SO but not transforming.",
                    recommendation: validation.soIdentifiers ? 
                        "SO contains: " + JSON.stringify(validation.soIdentifiers.map(function(i) { 
                            return i.sku + " [Desc:" + i.description + "]"; 
                        })) : 
                        "Could not validate SO items"
                };
            }

            var isPoMode = false;
            var transformType = record.Type.ITEM_FULFILLMENT;
            var existingRecordId = null;
            var transactionId = null;
            var ifRecord;

            // ── Determine Mode and Transaction ID ────────────────────────────
            if (poNumber) {
                // Check if this PO is linked to a Sales Order (meaning it is a Dropship PO)
                var linkedSO = findSOByPOLinkage(poNumber);
                if (linkedSO) {
                    log.audit("DROPSHIP_MODE_START", "PO " + poNumber + " is linked to SO " + linkedSO.tranid + ". Processing via SO Fulfillment (SO Mode)...");
                    isPoMode = false;
                    transformType = record.Type.ITEM_FULFILLMENT;
                    soMatch = linkedSO;
                    transactionId = linkedSO.id;
                    searchKey = poNumber;
                } else {
                    var poMatch = findPurchaseOrder(poNumber);
                    if (poMatch) {
                        // log.audit("STOCKING_PO_MODE_START", "PO " + poNumber + " is a stocking PO. Processing via PO Receipt (PO Mode)...");
                        // isPoMode = true;
                        // transformType = record.Type.ITEM_RECEIPT;
                        // transactionId = poMatch.id;
                        // searchKey = poNumber;
                        
                        // DISABLED ITEM RECEIPT CREATION
                        return {
                            success: false,
                            error: "Purchase Order " + poNumber + " is a Stocking PO. Item Receipt creation is currently disabled.",
                            details: "ITEM_RECEIPT_DISABLED"
                        };
                    } else {
                        return {
                            success: false,
                            error: "Purchase Order not found for po_number=" + poNumber,
                            details: "PO_NOT_FOUND"
                        };
                    }
                }
            } else if (websiteOrderNumber) {
                var soDirect = findSalesOrder(websiteOrderNumber);
                if (soDirect) {
                    log.audit("SO_MODE_START", "Processing website_order_number=" + websiteOrderNumber + " via SO Fulfillment...");
                    isPoMode = false;
                    transformType = record.Type.ITEM_FULFILLMENT;
                    soMatch = soDirect;
                    transactionId = soDirect.id;
                    searchKey = websiteOrderNumber;
                } else {
                    return {
                        success: false,
                        error: "Sales Order not found for website_order_number=" + websiteOrderNumber,
                        details: "SO_NOT_FOUND"
                    };
                }
            } else {
                return {
                    success: false,
                    error: "Missing required lookup identifiers (website_order_number or po_number)"
                };
            }

            // ── Load or Transform Record ──────────────────────────────────────
            if (transformType === record.Type.ITEM_FULFILLMENT) {
                var validation = validateSOItems(transactionId, items);
                if (!validation.isValid) {
                    return {
                        success: false,
                        error: "Sales Order ID " + transactionId + " validation failed: " + validation.error
                    };
                }
                
                existingRecordId = findExistingFulfillment(searchKey);
                if (existingRecordId) {
                    log.audit("IF_UPDATE", "Loading existing Item Fulfillment ID: " + existingRecordId);
                    ifRecord = record.load({
                        type: record.Type.ITEM_FULFILLMENT,
                        id: existingRecordId,
                        isDynamic: true
                    });
                } else {
                    log.audit("IF_CREATE", "Transforming Sales Order ID: " + transactionId);
                    try {
                        ifRecord = record.transform({
                            fromType: record.Type.SALES_ORDER,
                            fromId: transactionId,
                            toType: record.Type.ITEM_FULFILLMENT,
                            isDynamic: true
                        });
                    } catch (transformErr) {
                        if (transformErr.name === "VALID_LINE_ITEM_REQD" || transformErr.name === "SSS_VALID_LINE_ITEM_REQD") {
                            log.audit("ALREADY_FULFILLED_CHECK", "SO " + transactionId + " has no fulfillable lines. Checking fallback...");
                            var fallbackId = findExistingFulfillment(searchKey) || findExistingFulfillmentBySO(transactionId);
                            if (fallbackId) {
                                return {
                                    success: true,
                                    action: "already_fulfilled",
                                    internalId: fallbackId,
                                    websiteOrderNumber: websiteOrderNumber,
                                    message: "Sales Order was already fulfilled (Found via fallback)."
                                };
                            }
                        }
                        throw transformErr;
                    }
                }
            /* 
                // ITEM_RECEIPT (DISABLED)
            } else { 
                existingRecordId = findExistingReceipt(transactionId);
                if (existingRecordId) {
                    log.audit("IR_UPDATE", "Loading existing Item Receipt ID: " + existingRecordId);
                    ifRecord = record.load({
                        type: record.Type.ITEM_RECEIPT,
                        id: existingRecordId,
                        isDynamic: true
                    });
                } else {
                    log.audit("IR_CREATE", "Transforming Purchase Order ID: " + transactionId);
                    try {
                        ifRecord = record.transform({
                            fromType: record.Type.PURCHASE_ORDER,
                            fromId: transactionId,
                            toType: record.Type.ITEM_RECEIPT,
                            isDynamic: true
                        });
                    } catch (poTransformErr) {
                        if (poTransformErr.name === "INVALID_INITIALIZE_REF" || poTransformErr.name === "SSS_INVALID_INITIALIZE_REF" || 
                            poTransformErr.name === "VALID_LINE_ITEM_REQD" || poTransformErr.name === "SSS_VALID_LINE_ITEM_REQD") {
                            
                            var poStatus = getPurchaseOrderStatus(transactionId);
                            return {
                                success: false,
                                error: "Fulfillment failed. Purchase Order ID " + transactionId + " cannot be received. Status: " + poStatus,
                                details: poTransformErr.message
                            };
                        }
                        throw poTransformErr;
                    }
                }
            */
            }

            // Set form
            if (transformType === record.Type.ITEM_FULFILLMENT) {
                var formId = findFormId(FORM_NAME);
                if (formId) {
                    try { ifRecord.setValue({ fieldId: "customform", value: parseInt(formId, 10) }); } catch (e) {}
                }
            }

            // Set ship status
            if (transformType === record.Type.ITEM_FULFILLMENT) {
                ifRecord.setValue({ fieldId: "shipstatus", value: "C" });
            }
            
            // Set reference fields
            if (websiteOrderNumber) {
                var poFieldIds = ["otherrefnum", "custbody_otherrefnumber_custom", "custbody_po_number", "custbody_nsc_market_place_order_id", "checknumber"];
                for (var f = 0; f < poFieldIds.length; f++) {
                    try { ifRecord.setValue({ fieldId: poFieldIds[f], value: websiteOrderNumber }); } catch (e) {}
                }
                var billRef = payload.bill_number || websiteOrderNumber;
                var memoStr = (payload.po_number ? "PO" + payload.po_number : "") + "-" + billRef;
                ifRecord.setValue({ fieldId: "memo", value: memoStr });
            }

            // Set ship date
            if (shipDate) {
                var d = new Date(shipDate);
                if (!isNaN(d.getTime())) ifRecord.setValue({ fieldId: "trandate", value: d });
            }

            // Set location
            var dropshipLocationId = findLocationByName(DROPSHIP_LOCATION_NAME);
            if (dropshipLocationId) {
                try { ifRecord.setValue({ fieldId: "location", value: dropshipLocationId }); } catch (e) {}
            }

            // Set shipping address
            if (transformType === record.Type.ITEM_FULFILLMENT && (shipping.addr1 || shipping.city)) {
                try {
                    var addr = ifRecord.getSubrecord({ fieldId: "shippingaddress" });
                    if (shipping.country) addr.setValue({ fieldId: "country", value: shipping.country || "US" });
                    if (shipping.addressee) addr.setValue({ fieldId: "addressee", value: shipping.addressee });
                    if (shipping.addr1) addr.setValue({ fieldId: "addr1", value: shipping.addr1 });
                    if (shipping.addr2) addr.setValue({ fieldId: "addr2", value: shipping.addr2 });
                    if (shipping.city) addr.setValue({ fieldId: "city", value: shipping.city });
                    if (shipping.state) addr.setValue({ fieldId: "state", value: shipping.state });
                    if (shipping.zip) addr.setValue({ fieldId: "zip", value: shipping.zip });
                } catch (addrErr) {
                    log.debug("SHIPPING_ADDR_ERR", addrErr.message);
                }
            }

            // ── Item Line Processing ──────────────────────────────────────────

            var lineCount = ifRecord.getLineCount({ sublistId: "item" });
            var lineItemIds = [];
            for (var li = 0; li < lineCount; li++) {
                try {
                    var itemId = ifRecord.getSublistValue({ sublistId: "item", fieldId: "item", line: li });
                    if (itemId && lineItemIds.indexOf(itemId) === -1) lineItemIds.push(itemId);
                } catch (e) {}
            }

            var itemDetailsMap = {};
            if (lineItemIds.length > 0) {
                try {
                    var itemSql = "SELECT id, itemid, displayname, vendorname, mpn, isserialitem FROM item WHERE id IN (" + lineItemIds.join(",") + ")";
                    var itemResultSet = query.runSuiteQL({ query: itemSql });
                    var itemResults = itemResultSet.asMappedResults();
                    for (var r = 0; r < itemResults.length; r++) {
                        var row = itemResults[r];
                        itemDetailsMap[row.id] = {
                            sku: row.itemid ? String(row.itemid).trim() : "",
                            displayName: row.displayname ? String(row.displayname).trim() : "",
                            vendorSku: row.vendorname ? String(row.vendorname).trim() : "",
                            mpn: row.mpn ? String(row.mpn).trim() : "",
                            isserialitem: row.isserialitem ? String(row.isserialitem).trim() : ""
                        };
                    }
                } catch (searchErr) {
                    log.error("ITEM_DETAILS_SUITEQL_MAP_ERR", searchErr.message);
                }
            }

            log.audit("PROCESSING_LINES", "Transaction Lines count: " + lineCount);
            var checkedCount = 0;
            var availableItems = [];
            var missingSerialItems = [];

            for (var li = 0; li < lineCount; li++) {
                try {
                    ifRecord.selectLine({ sublistId: "item", line: li });
                    var lineItemId = ifRecord.getCurrentSublistValue({ sublistId: "item", fieldId: "item" });
                    var lineDescription = (ifRecord.getCurrentSublistValue({ sublistId: "item", fieldId: "description" }) || "").toString().toUpperCase();
                    
                    var details = itemDetailsMap[lineItemId] || { sku: String(lineItemId), displayName: "", vendorSku: "", mpn: "" };
                    
                    var skuUpper = details.sku.toUpperCase();
                    var displayUpper = details.displayName.toUpperCase();
                    var vendorSkuUpper = details.vendorSku.toUpperCase();
                    var mpnUpper = details.mpn.toUpperCase();
                    
                    var visualTrackingLabel = details.sku + " [Desc: " + (lineDescription.length > 25 ? lineDescription.substring(0, 25) + "..." : lineDescription) + "]";
                    availableItems.push(visualTrackingLabel); 

                    var matchedPayloadItem = null;
                    for (var pj = 0; pj < items.length; pj++) {
                        var itemSkuUpper = items[pj].sku.trim().toUpperCase();
                        
                        if (skuUpper === itemSkuUpper || 
                            skuUpper.indexOf(itemSkuUpper) >= 0 ||
                            displayUpper === itemSkuUpper || 
                            displayUpper.indexOf(itemSkuUpper) >= 0 ||
                            vendorSkuUpper === itemSkuUpper ||
                            vendorSkuUpper.indexOf(itemSkuUpper) >= 0 ||
                            mpnUpper === itemSkuUpper ||
                            mpnUpper.indexOf(itemSkuUpper) >= 0 ||
                            lineDescription === itemSkuUpper ||
                            lineDescription.indexOf(itemSkuUpper) >= 0) {
                            
                            matchedPayloadItem = items[pj];
                            break;
                        }
                    }

                    if (!matchedPayloadItem) {
                        ifRecord.setCurrentSublistValue({ sublistId: "item", fieldId: "itemreceive", value: false });
                        ifRecord.commitLine({ sublistId: "item" });
                        continue;
                    }

                    ifRecord.setCurrentSublistValue({ sublistId: "item", fieldId: "itemreceive", value: true });
                    checkedCount++;

                    var payloadQty = parseInt(matchedPayloadItem.quantity || matchedPayloadItem.qty, 10);
                    if (payloadQty && !isNaN(payloadQty)) {
                        ifRecord.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: payloadQty });
                    }

                    if (dropshipLocationId) {
                        try { ifRecord.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: dropshipLocationId }); } catch (e) {}
                    }

                    // ── FIXED: Inventory Detail ────────────────────────────────
                    // CRITICAL FIX: Use correct field names based on transaction type
                    // Item Fulfillment (SO→IF): issueinventorynumber
                    // Item Receipt (PO→IR): receiptinventorynumber
                    
                    var lineSerials = matchedPayloadItem.serial_numbers || [];
                    var invDetail = null;
                    
                    try {
                        invDetail = ifRecord.getCurrentSublistSubrecord({ sublistId: "item", fieldId: "inventorydetail" });
                        log.error("INV_DETAIL_GET", "Line " + li + " (" + details.sku + "): subrecord retrieved successfully");
                    } catch (getErr) {
                        log.error("INV_DETAIL_GET_FAIL", "Line " + li + " (" + details.sku + "): " + getErr.message);
                    }

                    if (invDetail) {
                        try {
                            // Determine correct field name based on mode
                            var serialFieldId = isPoMode ? "receiptinventorynumber" : "issueinventorynumber";
                            
                            log.error("INV_DETAIL_MODE", "Mode: " + (isPoMode ? "ItemReceipt" : "ItemFulfillment") + ", default field: " + serialFieldId);
                            log.error("INV_DETAIL_SERIALS", "Payload serials for " + details.sku + ": " + JSON.stringify(lineSerials));

                            // Clear existing assignments
                            var existingCount = invDetail.getLineCount({ sublistId: "inventoryassignment" });
                            for (var ei = existingCount - 1; ei >= 0; ei--) {
                                invDetail.removeLine({ sublistId: "inventoryassignment", line: ei });
                            }

                            if (lineSerials.length === 0) {
                                // No serials provided — skip this line
                                missingSerialItems.push({
                                    lineIndex: li + 1,
                                    sku: details.sku,
                                    itemId: lineItemId,
                                    quantity: payloadQty || 1
                                });
                                
                                ifRecord.setCurrentSublistValue({ sublistId: "item", fieldId: "itemreceive", value: false });
                                ifRecord.commitLine({ sublistId: "item" });
                                checkedCount--;
                                continue;
                            }

                            // Write serial numbers using correct field with robust fallback
                            for (var si = 0; si < lineSerials.length; si++) {
                                invDetail.selectNewLine({ sublistId: "inventoryassignment" });
                                
                                var setSucceeded = false;
                                var setErrors = "";
                                
                                // Try setting receiptinventorynumber first (correct for Receipts & Dropship Fulfillments)
                                try {
                                    invDetail.setCurrentSublistValue({ 
                                        sublistId: "inventoryassignment", 
                                        fieldId: "receiptinventorynumber", 
                                        value: String(lineSerials[si]) 
                                    });
                                    setSucceeded = true;
                                    log.error("INV_DETAIL_SET_RECEIPT", "Successfully set receiptinventorynumber to " + lineSerials[si]);
                                } catch (eReceipt) {
                                    setErrors += "receiptFieldErr: " + eReceipt.message + "; ";
                                }
                                
                                // If that failed, try setting issueinventorynumber (correct for Standard Fulfillments)
                                if (!setSucceeded) {
                                    try {
                                        var serialId = findInventoryNumberId(lineItemId, lineSerials[si]);
                                        var valToSet = serialId ? serialId : String(lineSerials[si]);
                                        
                                        invDetail.setCurrentSublistValue({ 
                                            sublistId: "inventoryassignment", 
                                            fieldId: "issueinventorynumber", 
                                            value: valToSet 
                                        });
                                        setSucceeded = true;
                                        log.error("INV_DETAIL_SET_ISSUE", "Successfully set issueinventorynumber to " + valToSet + " (serial: " + lineSerials[si] + ")");
                                    } catch (eIssue) {
                                        setErrors += "issueFieldErr: " + eIssue.message;
                                    }
                                }
                                
                                if (!setSucceeded) {
                                    log.error("INV_DETAIL_SET_FATAL", "Failed setting serial on both fields for SKU " + details.sku + ". Errors: " + setErrors);
                                }

                                invDetail.setCurrentSublistValue({ 
                                    sublistId: "inventoryassignment", 
                                    fieldId: "quantity", 
                                    value: 1 
                                });
                                try { 
                                    invDetail.setCurrentSublistValue({ 
                                        sublistId: "inventoryassignment", 
                                        fieldId: "inventorystatus", 
                                        value: "1" 
                                    }); 
                                } catch (e) {}
                                invDetail.commitLine({ sublistId: "inventoryassignment" });
                            }
                            invDetail.commit();
                            log.error("INV_DETAIL_COMMIT", "Successfully committed inventory detail for " + details.sku);
                            
                        } catch (invDetailErr) {
                            log.error("INV_DETAIL_WRITE_ERR", "Error writing subrecord for " + details.sku + ": " + invDetailErr.message);
                            throw invDetailErr;
                        }
                    }

                    ifRecord.commitLine({ sublistId: "item" });
                } catch (lineErr) {
                    log.debug("LINE_PROC_ERR", "Line " + li + ": " + lineErr.message);
                    throw lineErr; 
                }
            }

            if (missingSerialItems.length > 0) {
                var missingSerialMsg = missingSerialItems.map(function(m) {
                    return m.sku + " (qty: " + m.quantity + ")";
                }).join(", ");
                
                return {
                    success: false,
                    error: "Serialized items require serial_numbers in payload: [" + missingSerialMsg + "]",
                    details: "Add serial_numbers array to each serialized item in the payload"
                };
            }

            if (checkedCount === 0) {
                var txTypeLabel = isPoMode ? "Purchase Order" : "Sales Order";
                var skuList = items.map(function(i) { return i.sku; });
                return {
                    success: false,
                    error: "Fulfillment failed: None of the payload items [" + skuList.join(", ") + "] matched active lines on " + txTypeLabel + " ID " + transactionId + ". Available items on record: [" + availableItems.join(" | ") + "].",
                    details: "DATA_MISMATCH: The " + txTypeLabel + " does not contain the expected items. Verify the website_order_number/po_number mapping."
                };
            }

            // ── Packages ───────────────────────────────────────────────────
            if (transformType === record.Type.ITEM_FULFILLMENT && trackingNumber) {
                try {
                    var pkgCount = ifRecord.getLineCount({ sublistId: "package" });
                    for (var ki = pkgCount - 1; ki >= 0; ki--) { ifRecord.removeLine({ sublistId: "package", line: ki }); }

                    ifRecord.selectNewLine({ sublistId: "package" });
                    ifRecord.setCurrentSublistValue({ sublistId: "package", fieldId: "packagetrackingnumber", value: String(trackingNumber) });
                    ifRecord.setCurrentSublistValue({ sublistId: "package", fieldId: "packageweight", value: weightLbs });
                    ifRecord.setCurrentSublistValue({ sublistId: "package", fieldId: "packageweightunit", value: "lb" });
                    ifRecord.commitLine({ sublistId: "package" });
                } catch (pkgErr) {
                    log.debug("PACKAGE_ERR", pkgErr.message);
                }
            }

            // ── Save ───────────────────────────────────────────────────────
            var savedRecordId = null;
            try {
                savedRecordId = ifRecord.save({ ignoreMandatoryFields: true });
            } catch (saveErr) {
                log.error("SAVE_FAILED", saveErr.message + " Stack: " + saveErr.stack);
                return {
                    success: false,
                    error: saveErr.message,
                    details: "SAVE_FAILED"
                };
            }
            
            var txTypeLabel = isPoMode ? "Purchase Order" : "Sales Order";
            log.audit("IF_SUCCESS", "Synced Record ID: " + savedRecordId + " (Mode: " + txTypeLabel + ")");

            return {
                success: true,
                action: existingRecordId ? "updated" : "created",
                internalId: savedRecordId,
                websiteOrderNumber: websiteOrderNumber,
                mode: isPoMode ? "item_receipt" : "item_fulfillment",
                linesFulfilled: checkedCount,
                lookupMethod: lookupMethod
            };

            } catch (e) {
                log.error("IF_SYNC_ERR", e.name + ": " + e.message + "\nStack: " + e.stack);
                return { success: false, error: e.message, details: e.name };
            }
        }

        var res = executePost();
        if (res) {
            res.customLogs = customLogs;
        }
        return res;
    }

    return { post: post };
});
 