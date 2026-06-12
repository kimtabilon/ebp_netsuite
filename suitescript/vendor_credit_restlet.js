/**
 * NETSUITE RESTLET — Vendor Credit Sync
 * Version: 3.0-SERIAL-LOT-SUPPORT
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/query", "N/log"], function (record, search, query, log) {

    var WAREHOUSE_MAP = {
        "MW":     "California - Chatsworth",
        "W2G-PA": "Ware2Go - PA (Fairless Hills)",
        "W2G-IL": "Ware2Go - IL (Aurora)",
        "W2G-KY": "Ware2Go - KY (Hebron)",
        "W2G-TX": "Ware2Go - TX (Dallas)"
    };

    function findLocationByName(locationName) {
        var results = search.create({
            type: "location",
            filters: [["name", "is", locationName], "AND", ["isinactive", "is", "F"]],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });
        return results.length > 0 ? parseInt(results[0].id, 10) : null;
    }

    function resolveLocation(poType, stockingWarehouse) {
        if (poType === "Dropship") return findLocationByName("Dropship");
        if (poType === "Stocking" && stockingWarehouse) {
            var locationName = WAREHOUSE_MAP[stockingWarehouse];
            return locationName ? findLocationByName(locationName) : null;
        }
        return null;
    }

    function findInventoryAccount() {
        var accountSearch = search.create({
            type: search.Type.ACCOUNT,
            filters: [
                ["isinactive", "is", "F"],
                "AND",
                ["issummary", "is", "F"],
                "AND",
                [
                    ["name", "contains", "inventory"],
                    "OR",
                    ["name", "contains", "cost of goods"]
                ]
            ],
            columns: ["internalid"]
        }).run().getRange({ start: 0, end: 1 });
        return accountSearch.length > 0 ? parseInt(accountSearch[0].id, 10) : null;
    }

    function findPurchaseOrder(poNumber) {
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
                columns: ["internalid", "tranid"]
            }).run().getRange({ start: 0, end: 1 });
            return poResults.length > 0 ? { id: parseInt(poResults[0].id, 10), tranid: poResults[0].getValue("tranid") } : null;
        } catch (e) {
            log.debug("FIND_PO_ERR", e.message);
            return null;
        }
    }

    function findVendorBill(poId, poTranId, vendorId) {
        if (!poId) return null;
        
        log.emergency("FIND_BILL_START", "poId:" + poId + " poTranId:" + poTranId + " vendorId:" + vendorId);
        
        try {
            var billResults = search.create({
                type: search.Type.VENDOR_BILL,
                filters: [
                    ["mainline", "is", "T"],
                    "AND",
                    ["createdfrom", "anyof", poId]
                ],
                columns: ["internalid", "tranid", "memo", "entity"]
            }).run().getRange({ start: 0, end: 5 });
            
            log.emergency("FIND_BILL_M1", "Results: " + billResults.length);
            for (var i = 0; i < billResults.length; i++) {
                log.emergency("FIND_BILL_M1_DETAIL", "id:" + billResults[i].id + " tranid:" + billResults[i].getValue("tranid"));
            }
            
            if (billResults.length > 0) {
                return parseInt(billResults[0].id, 10);
            }
        } catch (e) {
            log.emergency("FIND_BILL_M1_ERR", e.message);
        }
        
        if (poTranId) {
            try {
                var searchVal = String(poTranId).replace(/^PO/i, "");
                var billResults2 = search.create({
                    type: search.Type.VENDOR_BILL,
                    filters: [
                        ["mainline", "is", "T"],
                        "AND",
                        [
                            ["memo", "contains", poTranId],
                            "OR",
                            ["memo", "contains", searchVal],
                            "OR",
                            ["memo", "contains", "PO" + searchVal],
                            "OR",
                            ["tranid", "contains", poTranId],
                            "OR",
                            ["tranid", "contains", searchVal],
                            "OR",
                            ["tranid", "contains", "PO" + searchVal]
                        ]
                    ],
                    columns: ["internalid", "tranid", "memo", "createdfrom", "entity"]
                }).run().getRange({ start: 0, end: 10 });
                
                log.emergency("FIND_BILL_M2", "Results: " + billResults2.length);
                for (var j = 0; j < billResults2.length; j++) {
                    var bId = billResults2[j].id;
                    var bTranId = billResults2[j].getValue("tranid");
                    var bMemo = billResults2[j].getValue("memo");
                    var bCreatedFrom = billResults2[j].getValue("createdfrom");
                    var bEntity = billResults2[j].getValue("entity");
                    log.emergency("FIND_BILL_M2_DETAIL", "id:" + bId + " tranid:" + bTranId + " memo:" + bMemo + " createdfrom:" + bCreatedFrom + " entity:" + bEntity);
                    
                    if (!vendorId || parseInt(bEntity, 10) === parseInt(vendorId, 10)) {
                        return parseInt(bId, 10);
                    }
                }
            } catch (e2) {
                log.emergency("FIND_BILL_M2_ERR", e2.message);
            }
        }
        
        if (vendorId) {
            try {
                var billResults3 = search.create({
                    type: search.Type.VENDOR_BILL,
                    filters: [
                        ["mainline", "is", "T"],
                        "AND",
                        ["entity", "anyof", vendorId]
                    ],
                    columns: [
                        search.createColumn({ name: "internalid", sort: search.Sort.DESC }),
                        "tranid", "memo", "createdfrom", "total"
                    ]
                }).run().getRange({ start: 0, end: 20 });
                
                log.emergency("FIND_BILL_M3", "Results: " + billResults3.length);
                for (var k = 0; k < billResults3.length; k++) {
                    var bId3 = billResults3[k].id;
                    var bTranId3 = billResults3[k].getValue("tranid");
                    var bMemo3 = billResults3[k].getValue("memo");
                    var bTotal3 = billResults3[k].getValue("total");
                    var bCreatedFrom3 = billResults3[k].getValue("createdfrom");
                    log.emergency("FIND_BILL_M3_DETAIL", "id:" + bId3 + " tranid:" + bTranId3 + " memo:" + bMemo3 + " total:" + bTotal3 + " createdfrom:" + bCreatedFrom3);
                    
                    if (poTranId && (String(bTranId3).indexOf(poTranId.replace(/^PO/i, "")) !== -1 || 
                        (bMemo3 && String(bMemo3).indexOf(poTranId) !== -1))) {
                        log.emergency("FIND_BILL_M3_MATCH", "Matched by PO reference: " + bId3);
                        return parseInt(bId3, 10);
                    }
                }
            } catch (e3) {
                log.emergency("FIND_BILL_M3_ERR", e3.message);
            }
        }
        
        log.emergency("FIND_BILL_FAIL", "No bill found for PO: " + poId);
        return null;
    }

    /**
     * Resolves the NetSuite Internal ID of the SKU array to the actual SKU text string
     * so that the script can match payload lines (which use string SKUs) against the 
     * NetSuite Sublist lines (which use internal IDs).
     */
    function lookupSkusByIds(itemIds) {
        if (itemIds.length === 0) return {};
        var idToSku = {};
        var filters = [["internalid", "anyof", itemIds]];
        var cols = [
            search.createColumn({ name: "internalid" }),
            search.createColumn({ name: "itemid" })
        ];
        var results = search.create({
            type: search.Type.ITEM,
            filters: filters,
            columns: cols
        }).run().getRange({ start: 0, end: 200 });
        for (var ri = 0; ri < results.length; ri++) {
            var iid = String(results[ri].getValue({ name: "internalid" }));
            var rawSku = String(results[ri].getValue({ name: "itemid" }) || "");
            var parts = rawSku.split(" : ");
            idToSku[iid] = parts[parts.length - 1].trim();
        }
        return idToSku;
    }

    /**
     * Attempts to dynamically populate the 'inventorydetail' subrecord required for Serial/Lot tracked items.
     * 
     * ACCOUNTING NOTE / DROPSHIP BLOCK:
     * If the item is a Dropship, it never physically enters NetSuite inventory (Quantity On Hand = 0).
     * NetSuite strictly forbids issuing out a serial number that does not exist in inventory.
     * Therefore, for Dropships, this function will mathematically fail when calling `commitLine()`, 
     * causing the script to intentionally throw away the Items tab and fall back to the Expense Tab.
     * 
     * @param {Record} recordObj - The NetSuite Vendor Credit record object
     * @param {number} newQty - The quantity to assign
     * @param {string} serialNumber - The serial number from the payload (e.g., "5BS16126")
     * @param {string} lotNumber - The lot number from the payload (if applicable)
     * @param {string} inventoryStatus - The internal ID of the inventory status
     * @returns {boolean} True if successful, false if inventory detail fails (triggering Expense fallback)
     */
    function fixInventoryDetail(recordObj, newQty, serialNumber, lotNumber, inventoryStatus) {
        try {
            log.emergency("FIX_INV_DETAIL", "Starting fixInventoryDetail");
            log.emergency("FIX_INV_DETAIL_INPUTS", "qty:" + newQty + " serial:" + serialNumber + " lot:" + lotNumber + " status:" + inventoryStatus);
            
            var invDetail;
            try {
                invDetail = recordObj.getCurrentSublistSubrecord({
                    sublistId: "item",
                    fieldId: "inventorydetail"
                });
            } catch (getErr) {
                log.emergency("FIX_INV_DETAIL", "getCurrentSublistSubrecord failed: " + getErr.message);
                return true; // No subrecord needed
            }
            
            if (!invDetail) {
                log.emergency("FIX_INV_DETAIL", "No inventory detail subrecord — skipping");
                return true;
            }
            
            var assignCount = invDetail.getLineCount({ sublistId: "inventoryassignment" });
            log.emergency("FIX_INV_DETAIL", "Assignment line count: " + assignCount);
            
            // Log all fields for debugging
            if (assignCount > 0) {
                var fieldsToCheck = ["issueinventorynumber", "inventorystatus", "binnumber", "expirationdate", "quantity", "receiptinventorynumber"];
                for (var fi = 0; fi < fieldsToCheck.length; fi++) {
                    try {
                        var val = invDetail.getSublistValue({
                            sublistId: "inventoryassignment",
                            fieldId: fieldsToCheck[fi],
                            line: 0
                        });
                        log.emergency("FIX_INV_DETAIL_FIELD", fieldsToCheck[fi] + ": " + val);
                    } catch (fe) {
                        log.emergency("FIX_INV_DETAIL_FIELD_ERR", fieldsToCheck[fi] + ": " + fe.message);
                    }
                }
            }
            
            // ----- CASE 1: No assignment lines — create new with provided serial/lot -----
            if (assignCount === 0) {
                log.emergency("FIX_INV_DETAIL", "No assignment lines — creating new assignment");
                
                invDetail.selectNewLine({ sublistId: "inventoryassignment" });
                
                // Set quantity (always required)
                invDetail.setCurrentSublistValue({
                    sublistId: "inventoryassignment",
                    fieldId: "quantity",
                    value: newQty
                });
                
                // CRITICAL: Set Serial/Lot Number from payload
                // For Vendor Credits, we use issueinventorynumber (not receiptinventorynumber)
                var lotSerialValue = serialNumber || lotNumber;
                if (lotSerialValue) {
                    var serialSuccess = false;
                    
                    try {
                        invDetail.setCurrentSublistValue({
                            sublistId: "inventoryassignment",
                            fieldId: "receiptinventorynumber",
                            value: lotSerialValue
                        });
                        log.emergency("FIX_INV_DETAIL_SET", "Set receiptinventorynumber to: " + lotSerialValue);
                        serialSuccess = true;
                    } catch (e1) {
                        log.emergency("FIX_INV_DETAIL_SET_ERR", "receiptinventorynumber failed: " + e1.message);
                    }

                    if (!serialSuccess) {
                        try {
                            invDetail.setCurrentSublistText({
                                sublistId: "inventoryassignment",
                                fieldId: "issueinventorynumber",
                                text: lotSerialValue
                            });
                            log.emergency("FIX_INV_DETAIL_SET", "Set issueinventorynumber via TEXT to: " + lotSerialValue);
                            serialSuccess = true;
                        } catch (e2) {
                            log.emergency("FIX_INV_DETAIL_SET_ERR", "issue TEXT failed: " + e2.message);
                        }
                    }

                    if (!serialSuccess) {
                        try {
                            invDetail.setCurrentSublistValue({
                                sublistId: "inventoryassignment",
                                fieldId: "issueinventorynumber",
                                value: lotSerialValue
                            });
                            log.emergency("FIX_INV_DETAIL_SET", "Set issueinventorynumber via VALUE to: " + lotSerialValue);
                            serialSuccess = true;
                        } catch (e3) {
                            log.emergency("FIX_INV_DETAIL_SET_ERR", "issue VALUE failed: " + e3.message);
                            throw new Error("Could not set serial/lot: " + e3.message);
                        }
                    }
                }
                
                // CRITICAL: Set Inventory Status from payload
                // Status is required and must be a valid internal ID (e.g., "1" for "Good")
                if (inventoryStatus) {
                    try {
                        invDetail.setCurrentSublistValue({
                            sublistId: "inventoryassignment",
                            fieldId: "inventorystatus",
                            value: inventoryStatus
                        });
                        log.emergency("FIX_INV_DETAIL_SET", "Set inventorystatus via VALUE to: " + inventoryStatus);
                    } catch (statErr1) {
                        try {
                            invDetail.setCurrentSublistText({
                                sublistId: "inventoryassignment",
                                fieldId: "inventorystatus",
                                text: inventoryStatus
                            });
                            log.emergency("FIX_INV_DETAIL_SET", "Set inventorystatus via TEXT to: " + inventoryStatus);
                        } catch (statErr2) {
                            log.emergency("FIX_INV_DETAIL_SET_ERR", "Failed to set inventorystatus: " + statErr2.message);
                        }
                    }
                }
                
                // Try to commit — if it fails due to missing lot/serial, we'll catch it
                try {
                    invDetail.commitLine({ sublistId: "inventoryassignment" });
                    log.emergency("FIX_INV_DETAIL", "Created new assignment successfully");
                    return true;
                } catch (commitErr) {
                    log.emergency("FIX_INV_DETAIL_COMMIT_ERR", "Failed to commit new assignment: " + commitErr.message);
                    // Try to cancel the partial line
                    try {
                        invDetail.cancelLine({ sublistId: "inventoryassignment" });
                    } catch (ce) {}
                    return false; // Signal that inventory detail is required but unavailable
                }
            }

            // ----- CASE 2: Assignment lines exist — update quantity and preserve values -----
            var originalLot = invDetail.getSublistValue({
                sublistId: "inventoryassignment",
                fieldId: "issueinventorynumber",
                line: 0
            }) || "";
            var originalStatus = invDetail.getSublistValue({
                sublistId: "inventoryassignment",
                fieldId: "inventorystatus",
                line: 0
            }) || "";
            var originalBin = invDetail.getSublistValue({
                sublistId: "inventoryassignment",
                fieldId: "binnumber",
                line: 0
            }) || "";
            var originalExpDate = invDetail.getSublistValue({
                sublistId: "inventoryassignment",
                fieldId: "expirationdate",
                line: 0
            }) || "";

            log.emergency("FIX_INV_DETAIL_VALUES", "lot:[" + originalLot + "] status:[" + originalStatus + "] bin:[" + originalBin + "]");

            // If lot/serial is required but not available anywhere, signal failure
            if (!originalLot && !originalStatus && !serialNumber && !lotNumber && !inventoryStatus) {
                log.emergency("FIX_INV_DETAIL", "No lot/serial or status available — cannot populate inventory detail");
                return false;
            }

            // Remove extra lines
            for (var ad = assignCount - 1; ad >= 1; ad--) {
                invDetail.removeLine({ sublistId: "inventoryassignment", line: ad });
            }

            // Update first line
            invDetail.selectLine({ sublistId: "inventoryassignment", line: 0 });
            
            invDetail.setCurrentSublistValue({
                sublistId: "inventoryassignment",
                fieldId: "quantity",
                value: newQty
            });
            
            // Use payload value if provided, otherwise preserve original
            var lotSerialValue = serialNumber || lotNumber || originalLot;
            if (lotSerialValue) {
                var serialSuccess = false;
                
                try {
                    invDetail.setCurrentSublistValue({
                        sublistId: "inventoryassignment",
                        fieldId: "receiptinventorynumber",
                        value: lotSerialValue
                    });
                    log.emergency("FIX_INV_DETAIL_SET", "Set receiptinventorynumber to: " + lotSerialValue);
                    serialSuccess = true;
                } catch (e1) {
                    log.emergency("FIX_INV_DETAIL_SET_ERR", "receiptinventorynumber failed: " + e1.message);
                }

                if (!serialSuccess) {
                    try {
                        invDetail.setCurrentSublistText({
                            sublistId: "inventoryassignment",
                            fieldId: "issueinventorynumber",
                            text: lotSerialValue
                        });
                        log.emergency("FIX_INV_DETAIL_SET", "Set issueinventorynumber via TEXT to: " + lotSerialValue);
                        serialSuccess = true;
                    } catch (e2) {
                        log.emergency("FIX_INV_DETAIL_SET_ERR", "issue TEXT failed: " + e2.message);
                    }
                }

                if (!serialSuccess) {
                    try {
                        invDetail.setCurrentSublistValue({
                            sublistId: "inventoryassignment",
                            fieldId: "issueinventorynumber",
                            value: lotSerialValue
                        });
                        log.emergency("FIX_INV_DETAIL_SET", "Set issueinventorynumber via VALUE to: " + lotSerialValue);
                        serialSuccess = true;
                    } catch (e3) {
                        log.emergency("FIX_INV_DETAIL_SET_ERR", "issue VALUE failed: " + e3.message);
                        throw new Error("Could not set serial/lot: " + e3.message);
                    }
                }
            }
            
            // Use payload status if provided, otherwise preserve original
            var statusValue = inventoryStatus || originalStatus;
            if (statusValue) {
                try {
                    invDetail.setCurrentSublistValue({
                        sublistId: "inventoryassignment",
                        fieldId: "inventorystatus",
                        value: statusValue
                    });
                    log.emergency("FIX_INV_DETAIL_SET", "Set inventorystatus via VALUE to: " + statusValue);
                } catch (statErr1) {
                    try {
                        invDetail.setCurrentSublistText({
                            sublistId: "inventoryassignment",
                            fieldId: "inventorystatus",
                            text: statusValue
                        });
                        log.emergency("FIX_INV_DETAIL_SET", "Set inventorystatus via TEXT to: " + statusValue);
                    } catch (statErr2) {
                        log.emergency("FIX_INV_DETAIL_SET_ERR", "Failed to set inventorystatus: " + statErr2.message);
                    }
                }
            }
            
            if (originalBin) {
                invDetail.setCurrentSublistValue({
                    sublistId: "inventoryassignment",
                    fieldId: "binnumber",
                    value: originalBin
                });
            }
            
            if (originalExpDate) {
                invDetail.setCurrentSublistValue({
                    sublistId: "inventoryassignment",
                    fieldId: "expirationdate",
                    value: originalExpDate
                });
            }

            try {
                invDetail.commitLine({ sublistId: "inventoryassignment" });
                log.emergency("FIX_INV_DETAIL", "Updated assignment successfully");
                return true;
            } catch (commitErr2) {
                log.emergency("FIX_INV_DETAIL_COMMIT_ERR2", "Failed to commit update: " + commitErr2.message);
                try {
                    invDetail.cancelLine({ sublistId: "inventoryassignment" });
                } catch (ce2) {}
                return false;
            }
            
        } catch (invErr) {
            var errMsg = invErr.message || "";
            log.emergency("FIX_INV_DETAIL_ERR", "Unexpected error: " + errMsg);
            
            if (errMsg.indexOf("subrecord") !== -1 || 
                errMsg.indexOf("does not exist") !== -1 || 
                errMsg.indexOf("INVALID_SUBLIST_OPERATION") !== -1 ||
                errMsg.indexOf("field inventorydetail") !== -1) {
                log.emergency("FIX_INV_DETAIL", "No inventory detail for this item — skipping");
                return true;
            }
            return false;
        }
    }

    function findExistingCredit(referenceNumber) {
        var sql = "SELECT id FROM transaction WHERE type = 'VendCred' AND (tranid = ? OR otherrefnum = ?) ORDER BY id DESC";
        var resultSet = query.runSuiteQL({ query: sql, params: [String(referenceNumber), String(referenceNumber)] });
        var rows = resultSet.asMappedResults();
        return rows.length > 0 ? rows[0].id : null;
    }

    function post(payload) {
        log.emergency("SCRIPT_ENTRY", "RESTLET EXECUTED - Version: 3.0-SERIAL-LOT-SUPPORT");
        log.emergency("PAYLOAD", JSON.stringify(payload));
        
        try {
            var reference_number = payload.reference_number || payload.invoice_number;
            var po_number = payload.po_number;
            var trandate = payload.invoice_date;
            var line_items = payload.line_items || [];
            var vendor_id = payload.vendor_id;
            var po_type = payload.po_type || "";
            var stocking_warehouse = payload.stocking_warehouse || "";

            log.emergency("INPUTS", "ref:" + reference_number + " po:" + po_number + " vendor:" + vendor_id + " type:" + po_type);

            var totalAmount = 0;
            for (var i = 0; i < line_items.length; i++) {
                var qty = Math.abs(parseFloat(line_items[i].qty)) || 1;
                var rate = parseFloat(line_items[i].rate || line_items[i].price) || 0;
                totalAmount += (qty * rate);
            }

            if (!reference_number) {
                log.emergency("VALIDATION_FAIL", "Missing reference_number");
                return { success: false, error: "Missing reference_number" };
            }

            var existingId = findExistingCredit(reference_number);
            log.emergency("EXISTING_CHECK", "existingId: " + existingId);
            
            var credit;
            var actionTaken;
            var useItems = false;
            var billId = null;

            if (existingId) {
                log.emergency("MODE", "UPDATING existing credit: " + existingId);
                credit = record.load({ type: record.Type.VENDOR_CREDIT, id: existingId, isDynamic: true });
                actionTaken = "updated";
                
                var expenseCount = credit.getLineCount({ sublistId: "expense" });
                for (var r = expenseCount - 1; r >= 0; r--) {
                    credit.removeLine({ sublistId: "expense", line: r });
                }
                var itemCount = credit.getLineCount({ sublistId: "item" });
                for (var r = itemCount - 1; r >= 0; r--) {
                    credit.removeLine({ sublistId: "item", line: r });
                }
            } else {
                var poMatch = null;
                if (po_number) {
                    poMatch = findPurchaseOrder(po_number);
                    log.emergency("PO_LOOKUP", "poMatch: " + JSON.stringify(poMatch));
                    if (poMatch) {
                        billId = findVendorBill(poMatch.id, poMatch.tranid, vendor_id);
                        log.emergency("BILL_LOOKUP", "billId: " + billId);
                    }
                }

                if (billId) {
                    log.emergency("TRANSFORM_ATTEMPT", "Transforming billId: " + billId);
                    try {
                        credit = record.transform({
                            fromType: record.Type.VENDOR_BILL,
                            fromId: billId,
                            toType: record.Type.VENDOR_CREDIT,
                            isDynamic: true
                        });
                        log.emergency("TRANSFORM_SUCCESS", "Credit transformed from bill");
                        actionTaken = "created";

                        var origLineCount = credit.getLineCount({ sublistId: "item" });
                        log.emergency("BILL_LINES", "Original item line count: " + origLineCount);
                        
                        // 1. Build a map of SKUs from the JSON Payload so we can inject quantities and serials
                        var invoiceSkuMap = {};
                        var lineItemDataMap = {}; // Maps lowercase SKU to the full payload object
                        for (var si = 0; si < line_items.length; si++) {
                            var li = line_items[si];
                            if (li.sku) {
                                var skuKey = String(li.sku).trim().toLowerCase();
                                invoiceSkuMap[skuKey] = {
                                    qty: Math.abs(parseFloat(li.qty)) || 1,
                                    rate: parseFloat(li.rate || li.price) || 0
                                };
                                lineItemDataMap[skuKey] = li; // Store full object for serial/lot lookup
                            }
                        }
                        log.emergency("INVOICE_SKUS", JSON.stringify(invoiceSkuMap));

                        var linesToRemove = [];
                        var linesUpdated = 0;
                        var inventoryDetailFailed = false;
                        
                        var transformItemIds = [];
                        for (var tli = 0; tli < origLineCount; tli++) {
                            transformItemIds.push(String(credit.getSublistValue({ sublistId: "item", fieldId: "item", line: tli })));
                        }
                        log.emergency("BILL_ITEM_IDS", JSON.stringify(transformItemIds));
                        
                        var idToSku = lookupSkusByIds(transformItemIds);
                        log.emergency("ID_TO_SKU", JSON.stringify(idToSku));

                        for (var ui = 0; ui < origLineCount; ui++) {
                            try {
                                credit.selectLine({ sublistId: "item", line: ui });
                                var lineItemId = transformItemIds[ui];
                                var lineSku = idToSku[lineItemId] || "";
                                log.emergency("LINE_CHECK", "line:" + ui + " itemId:" + lineItemId + " sku:" + lineSku);

                                var invoiceMatch = invoiceSkuMap[lineSku.toLowerCase()];
                                if (!invoiceMatch && line_items.length === 1 && origLineCount === 1) {
                                    invoiceMatch = { 
                                        qty: Math.abs(parseFloat(line_items[0].qty)) || 1, 
                                        rate: parseFloat(line_items[0].rate || line_items[0].price) || 0 
                                    };
                                    log.emergency("FALLBACK_MATCH", "Using single line fallback match");
                                }

                                if (invoiceMatch) {
                                    log.emergency("MATCH_FOUND", "Setting qty:" + invoiceMatch.qty + " rate:" + invoiceMatch.rate);
                                    credit.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: invoiceMatch.qty });
                                    credit.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: invoiceMatch.rate });
                                    
                                    // 2. Extract specific serial, lot, and status from the matching payload item
                                    var lineData = lineItemDataMap[lineSku.toLowerCase()] || 
                                                  (line_items.length === 1 ? line_items[0] : {});
                                    var serialNum = lineData.serial_number || null;
                                    var lotNum = lineData.lot_number || null;
                                    var invStatus = lineData.inventory_status || null;
                                    
                                    log.emergency("LINE_SERIAL_INFO", "sku:" + lineSku + " serial:" + serialNum + " lot:" + lotNum + " status:" + invStatus);
                                    
                                    // 3. Attempt to set the Serial Number natively in NetSuite's subrecord
                                    var invDetailOk = fixInventoryDetail(credit, invoiceMatch.qty, serialNum, lotNum, invStatus);
                                    
                                    if (invDetailOk) {
                                        // If Serial Number successfully attached, commit the item line
                                        credit.commitLine({ sublistId: "item" });
                                        linesUpdated++;
                                        log.emergency("LINE_COMMITTED", "Line " + ui + " updated successfully");
                                    } else {
                                        // IF THIS IS A DROPSHIP: The Serial Number will fail to attach because the
                                        // item never physically entered NetSuite inventory.
                                        // When this happens, we catch the failure, mark the line for deletion, 
                                        // and intentionally fail over to the Expense Tab to preserve accounting integrity.
                                        log.emergency("LINE_INV_DETAIL_FAIL", "Line " + ui + " inventory detail unavailable — marking for removal (Expense Fallback Triggered)");
                                        linesToRemove.push(ui);
                                        inventoryDetailFailed = true;
                                        try {
                                            credit.cancelLine({ sublistId: "item" });
                                        } catch (ce) {
                                            try {
                                                credit.commitLine({ sublistId: "item" });
                                            } catch (ce2) {}
                                        }
                                    }
                                } else {
                                    // If the item isn't in our payload, mark it for removal
                                    linesToRemove.push(ui);
                                    credit.commitLine({ sublistId: "item" });
                                    log.emergency("LINE_REMOVE", "Line " + ui + " marked for removal");
                                }
                            } catch (lineErr) {
                                log.emergency("LINE_ERR", "Error processing line " + ui + ": " + lineErr.message);
                                linesToRemove.push(ui);
                                inventoryDetailFailed = true;
                                try {
                                    credit.cancelLine({ sublistId: "item" });
                                } catch (ce) {
                                    try {
                                        credit.commitLine({ sublistId: "item" });
                                    } catch (ce2) {}
                                }
                            }
                        }

                        log.emergency("MAPPING_RESULT", "linesUpdated:" + linesUpdated + " linesToRemove:" + JSON.stringify(linesToRemove) + " invDetailFailed:" + inventoryDetailFailed);

                        if (linesUpdated > 0 && !inventoryDetailFailed) {
                            for (var ri = linesToRemove.length - 1; ri >= 0; ri--) {
                                credit.removeLine({ sublistId: "item", line: linesToRemove[ri] });
                                log.emergency("REMOVED_LINE", "Removed line " + linesToRemove[ri]);
                            }
                            var expenseCount = credit.getLineCount({ sublistId: "expense" });
                            for (var r = expenseCount - 1; r >= 0; r--) {
                                credit.removeLine({ sublistId: "expense", line: r });
                            }
                            useItems = true;
                            log.emergency("USE_ITEMS", "TRUE — Keeping Item tab");
                        } else {
                            log.emergency("USE_ITEMS", "FALSE — Clearing all items" + (inventoryDetailFailed ? " (inventory detail failed)" : ""));
                            var itemCount = credit.getLineCount({ sublistId: "item" });
                            for (var r = itemCount - 1; r >= 0; r--) {
                                credit.removeLine({ sublistId: "item", line: r });
                            }
                            var expenseCount = credit.getLineCount({ sublistId: "expense" });
                            for (var r = expenseCount - 1; r >= 0; r--) {
                                credit.removeLine({ sublistId: "expense", line: r });
                            }
                        }
                    } catch (transformErr) {
                        log.emergency("TRANSFORM_ERR_CATCH", transformErr.message);
                        log.error("CREDIT_TRANSFORM_ERR", "Failed to map items on transformed Vendor Bill " + billId + ": " + transformErr.message + ". Falling back.");
                        billId = null;
                        useItems = false;
                    }
                }

                if (!billId && !useItems) {
                    log.emergency("STANDALONE_MODE", "Creating standalone expense credit");
                    credit = record.create({ type: record.Type.VENDOR_CREDIT, isDynamic: true });
                    actionTaken = "created";
                    
                    if (vendor_id) {
                        credit.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                    } else {
                        return { success: false, error: "Missing vendor_id. Standalone credits require a vendor_id." };
                    }
                }
            }

            credit.setValue({ fieldId: "tranid", value: String(reference_number) });
            if (po_number) credit.setValue({ fieldId: "memo", value: "Ref PO: " + po_number });
            if (trandate) {
                var d = new Date(trandate);
                if (!isNaN(d.getTime())) credit.setValue({ fieldId: "trandate", value: d });
            }
            var locationId = resolveLocation(po_type, stocking_warehouse) || payload.location_id;
            if (locationId) credit.setValue({ fieldId: "location", value: locationId });
            var departmentId = payload.department_id;
            var classId = payload.class_id;

            // ==============================================================================
            // EXPENSE TAB FALLBACK LOGIC
            // ==============================================================================
            // If the Vendor Credit failed to map the Items (e.g. because it was a Dropship
            // and the serial number couldn't be issued out of empty inventory), we build
            // the credit entirely using the Expense tab. This accurately credits the COGS
            // account without triggering strict NetSuite inventory blocks.
            if (!useItems) {
                log.emergency("EXPENSE_PATH", "Building expense line to bypass strict Inventory constraints");
                var accountId = findInventoryAccount();
                if (!accountId) return { success: false, error: "Could not find a valid Inventory or COGS account in NetSuite." };

                var totalAmount = 0;
                var lineMemos = [];
                for (var i = 0; i < line_items.length; i++) {
                    var qty = Math.abs(parseFloat(line_items[i].qty)) || 1;
                    var rate = parseFloat(line_items[i].rate || line_items[i].price) || 0;
                    totalAmount += (qty * rate);
                    lineMemos.push(line_items[i].sku + " (qty " + qty + ")");
                }

                credit.selectNewLine({ sublistId: "expense" });
                credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "account", value: accountId });
                credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "amount", value: totalAmount.toFixed(2) });
                credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "memo", value: lineMemos.join(", ") });
                if (locationId) credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "location", value: locationId });
                if (departmentId) credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "department", value: departmentId });
                if (classId) credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "class", value: classId });
                credit.commitLine({ sublistId: "expense" });
                log.emergency("EXPENSE_CREATED", "Expense line committed");
            } else {
                log.emergency("ITEM_PATH", "Keeping item lines, skipping expense creation");
            }

            if (billId) {
                try {
                    var applyCount = credit.getLineCount({ sublistId: "apply" });
                    log.emergency("APPLY_COUNT", "Apply sublist lines: " + applyCount);
                    for (var j = 0; j < applyCount; j++) {
                        var lineDocId = credit.getSublistValue({ sublistId: "apply", fieldId: "doc", line: j });
                        // log.emergency("APPLY_CHECK", "line:" + j + " doc:" + lineDocId + " vs billId:" + billId);
                        if (parseInt(lineDocId, 10) === parseInt(billId, 10)) {
                            credit.selectLine({ sublistId: "apply", line: j });
                            credit.setCurrentSublistValue({ sublistId: "apply", fieldId: "apply", value: true });
                            credit.setCurrentSublistValue({ sublistId: "apply", fieldId: "amount", value: totalAmount.toFixed(2) });
                            credit.commitLine({ sublistId: "apply" });
                            log.emergency("APPLY_SUCCESS", "Linked to bill at line " + j);
                            break;
                        }
                    }
                } catch (applyErr) {
                    log.emergency("APPLY_ERR", applyErr.message);
                }
            }

            var creditId;
            try {
                log.emergency("SAVE_ATTEMPT", "Saving credit...");
                creditId = credit.save({ ignoreMandatoryFields: true });
                log.emergency("SAVE_SUCCESS", "Saved ID: " + creditId + " useItems:" + useItems);
            } catch (saveErr) {
                log.emergency("SAVE_ERR", saveErr.message);
                if (useItems && actionTaken === "created" && billId) {
                    log.emergency("FALLBACK_TRIGGERED", "Falling back to expense tab");
                    
                    credit = record.transform({
                        fromType: record.Type.VENDOR_BILL,
                        fromId: billId,
                        toType: record.Type.VENDOR_CREDIT,
                        isDynamic: true
                    });
                    
                    var itemCount = credit.getLineCount({ sublistId: "item" });
                    for (var r = itemCount - 1; r >= 0; r--) {
                        credit.removeLine({ sublistId: "item", line: r });
                    }
                    var expenseCount = credit.getLineCount({ sublistId: "expense" });
                    for (var r = expenseCount - 1; r >= 0; r--) {
                        credit.removeLine({ sublistId: "expense", line: r });
                    }

                    credit.setValue({ fieldId: "tranid", value: String(reference_number) });
                    if (po_number) credit.setValue({ fieldId: "memo", value: "Ref PO: " + po_number });
                    if (trandate) {
                        var d = new Date(trandate);
                        if (!isNaN(d.getTime())) credit.setValue({ fieldId: "trandate", value: d });
                    }
                    if (locationId) credit.setValue({ fieldId: "location", value: locationId });

                    var accountId = findInventoryAccount();
                    if (!accountId) return { success: false, error: "Fallback failed: Could not find Inventory/COGS account." };

                    var totalAmount = 0;
                    var lineMemos = [];
                    for (var i = 0; i < line_items.length; i++) {
                        var qty = Math.abs(parseFloat(line_items[i].qty)) || 1;
                        var rate = parseFloat(line_items[i].rate || line_items[i].price) || 0;
                        totalAmount += (qty * rate);
                        lineMemos.push(line_items[i].sku + " (qty " + qty + ")");
                    }

                    credit.selectNewLine({ sublistId: "expense" });
                    credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "account", value: accountId });
                    credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "amount", value: totalAmount.toFixed(2) });
                    credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "memo", value: lineMemos.join(", ") });
                    if (locationId) credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "location", value: locationId });
                    if (departmentId) credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "department", value: departmentId });
                    if (classId) credit.setCurrentSublistValue({ sublistId: "expense", fieldId: "class", value: classId });
                    credit.commitLine({ sublistId: "expense" });

                    if (billId) {
                        try {
                            var applyCount = credit.getLineCount({ sublistId: "apply" });
                            for (var j = 0; j < applyCount; j++) {
                                var lineDocId = credit.getSublistValue({ sublistId: "apply", fieldId: "doc", line: j });
                                if (parseInt(lineDocId, 10) === parseInt(billId, 10)) {
                                    credit.selectLine({ sublistId: "apply", line: j });
                                    credit.setCurrentSublistValue({ sublistId: "apply", fieldId: "apply", value: true });
                                    credit.setCurrentSublistValue({ sublistId: "apply", fieldId: "amount", value: totalAmount.toFixed(2) });
                                    credit.commitLine({ sublistId: "apply" });
                                    break;
                                }
                            }
                        } catch (applyErr) {}
                    }

                    creditId = credit.save({ ignoreMandatoryFields: true });
                    log.emergency("SAVE_SUCCESS", "Saved ID: " + creditId + " via Expense Tab Fallback");
                } else {
                    throw saveErr;
                }
            }

            log.emergency("RETURN", JSON.stringify({ success: true, action: actionTaken, internalId: creditId, useItems: useItems }));
            return { success: true, action: actionTaken, internalId: creditId };

        } catch (e) {
            log.emergency("FATAL_ERR", e.message);
            return { success: false, error: e.message };
        }
    }

    return { post: post };
});