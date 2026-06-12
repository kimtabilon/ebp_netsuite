/**
 * NETSUITE RESTLET - Purchase Order Sync (COMPLETE FIXED VERSION WITH SUITEQL)
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
 
define(["N/record", "N/search", "N/log", "N/runtime" , "N/query"], function (record, search, log, runtime, query) {

    var _formCache = {};
    var _locationCache = {};
    var _itemCache = {};

    var WAREHOUSE_MAP = {
        "MW": "California - Chatsworth",
        "W2G-PA": "Ware2Go - PA (Fairless Hills)",
        "W2G-IL": "Ware2Go - IL (Aurora)",
        "W2G-KY": "Ware2Go - KY (Hebron)",
        "W2G-TX": "Ware2Go - TX (Dallas)"
    };

    var WAREHOUSE_ADDRESS_MAP = {
        "MW": {
            addressee: "California - Chatsworth",
            addr1: "21540 Prairie Street",
            addr2: "Suite F",
            city: "Chatsworth",
            state: "CA",
            zip: "91311",
            country: "US"
        },
        "W2G-PA": {
            addressee: "Ware2Go - PA (Fairless Hills)",
            addr1: "1 Kresge Road",
            addr2: "",
            city: "Fairless Hills",
            state: "PA",
            zip: "19030",
            country: "US"
        },
        "W2G-IL": {
            addressee: "Ware2Go - IL (Aurora)",
            addr1: "1206 NAGEL BLVD",
            addr2: "",
            city: "Batavia",
            state: "IL",
            zip: "60510",
            country: "US"
        },
        "W2G-KY": {
            addressee: "Ware2Go - KY (Hebron)",
            addr1: "2525 Litton Lane",
            addr2: "",
            city: "Hebron",
            state: "KY",
            zip: "41048",
            country: "US"
        },
        "W2G-TX": {
            addressee: "Ware2Go - TX (Dallas)",
            addr1: "2450 Esters Blvd",
            addr2: "#100",
            city: "Grapevine",
            state: "TX",
            zip: "76051",
            country: "US"
        }
    };

    function getItemSkuById(itemInternalId) {
        if (!itemInternalId) return null;
        var cacheKey = String(itemInternalId);
        if (_itemCache[cacheKey]) return _itemCache[cacheKey];

        try {
            var itemRec = record.load({ type: record.Type.INVENTORY_ITEM, id: parseInt(itemInternalId, 10), isDynamic: false });
            var sku = itemRec.getValue({ fieldId: "itemid" });
            _itemCache[cacheKey] = sku;
            return sku;
        } catch (e1) {
            try {
                var serItem = record.load({ type: "serializedinventoryitem", id: parseInt(itemInternalId, 10), isDynamic: false });
                var serSku = serItem.getValue({ fieldId: "itemid" });
                _itemCache[cacheKey] = serSku;
                return serSku;
            } catch (e2) {
                try {
                    var sCol = search.createColumn({ name: "itemid" });
                    var sResults = search.create({
                        type: search.Type.ITEM,
                        filters: [["internalid", "is", parseInt(itemInternalId, 10)]],
                        columns: [sCol]
                    }).run().getRange({ start: 0, end: 1 });
                    if (sResults && sResults.length > 0) {
                        var foundSku = sResults[0].getValue(sCol);
                        _itemCache[cacheKey] = foundSku;
                        return foundSku;
                    }
                } catch (e3) { }
                return null;
            }
        }
    }

    function snapshotPO(poRecord) {
        var snap = { header: {}, lines: [] };
        var headerFields = [
            "customform", "entity", "subsidiary", "otherrefnum",
            "trandate", "currency", "custbody1", "custbody2",
            "custbody_otherrefnumber_custom", "createdfrom", "custbody_linkedsalesorder"
        ];
        for (var hi = 0; hi < headerFields.length; hi++) {
            try {
                snap.header[headerFields[hi]] = poRecord.getValue({ fieldId: headerFields[hi] });
            } catch (e) { }
        }
        var lineCount = poRecord.getLineCount({ sublistId: "item" });
        snap.header.lineCount = lineCount;

        var lineFields = ["item", "quantity", "rate", "amount", "location", "description"];
        for (var li = 0; li < lineCount; li++) {
            var line = { line: li };
            for (var lf = 0; lf < lineFields.length; lf++) {
                try {
                    line[lineFields[lf]] = poRecord.getSublistValue({
                        sublistId: "item", fieldId: lineFields[lf], line: li
                    });
                } catch (e) { }
            }
            snap.lines.push(line);
        }
        return snap;
    }

    function diffSnapshots(before, after) {
        var changes = { header: {}, lines: {} };
        for (var key in after.header) {
            if (String(before.header[key]) !== String(after.header[key])) {
                changes.header[key] = { from: before.header[key], to: after.header[key] };
            }
        }
        if (before.header.lineCount !== after.header.lineCount) {
            changes.lines.countChange = {
                from: before.header.lineCount,
                to: after.header.lineCount
            };
        }
        return changes;
    }

    function findFormId(formName) {
        if (_formCache[formName]) return _formCache[formName];

        try {
            var tempPo = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
            var formField = tempPo.getField({ fieldId: "customform" });
            if (formField) {
                var options = formField.getSelectOptions();
                for (var oi = 0; oi < options.length; oi++) {
                    if (options[oi].text && options[oi].text.indexOf(formName) >= 0) {
                        _formCache[formName] = options[oi].value;
                        log.debug("FORM_FOUND", formName + " -> ID " + options[oi].value + " (from getSelectOptions)");
                        return options[oi].value;
                    }
                }
            }
        } catch (e) {
            log.debug("FORM_OPTIONS_ERROR", e.message);
        }

        var formCol = search.createColumn({ name: "customform" });
        var results = search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [["mainline", "is", "T"]],
            columns: [formCol]
        }).run().getRange({ start: 0, end: 200 });

        for (var i = 0; i < results.length; i++) {
            var text = results[i].getText(formCol);
            if (text && text.indexOf(formName) >= 0) {
                var id = results[i].getValue(formCol);
                _formCache[formName] = id;
                log.debug("FORM_FOUND", formName + " -> ID " + id + " (from search)");
                return id;
            }
        }

        log.debug("FORM_NOT_FOUND", "Could not find form: " + formName);
        return null;
    }

    function findLocationByName(locationName) {
        if (_locationCache[locationName]) return _locationCache[locationName];

        var idCol = search.createColumn({ name: "internalid" });
        var results = search.create({
            type: "location",
            filters: [
                ["name", "is", locationName],
                "AND",
                ["isinactive", "is", "F"]
            ],
            columns: [idCol]
        }).run().getRange({ start: 0, end: 1 });

        if (results.length === 0) {
            log.debug("LOCATION_NOT_FOUND", "No active location named: " + locationName);
            return null;
        }

        var locId = parseInt(results[0].getValue(idCol), 10);
        _locationCache[locationName] = locId;
        log.debug("LOCATION_FOUND", locationName + " -> ID " + locId);
        return locId;
    }

    function resolveLocation(poType, stockingWarehouse) {
        if (poType === "Dropship") {
            return findLocationByName("Dropship");
        }
        if (poType === "Stocking" && stockingWarehouse) {
            var locationName = WAREHOUSE_MAP[stockingWarehouse];
            if (!locationName) {
                log.debug("WAREHOUSE_UNKNOWN", "No mapping for stocking_warehouse: " + stockingWarehouse);
                return null;
            }
            return findLocationByName(locationName);
        }
        return null;
    }

    function copySOShippingToPO(soId, po) {
        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
            var soShip = so.getSubrecord({ fieldId: "shippingaddress" });

            var addrFields = {
                country: soShip.getValue({ fieldId: "country" }) || "US",
                addressee: soShip.getValue({ fieldId: "addressee" }) || "",
                attention: soShip.getValue({ fieldId: "attention" }) || "",
                addr1: soShip.getValue({ fieldId: "addr1" }) || "",
                addr2: soShip.getValue({ fieldId: "addr2" }) || "",
                city: soShip.getValue({ fieldId: "city" }) || "",
                state: soShip.getValue({ fieldId: "state" }) || "",
                zip: soShip.getValue({ fieldId: "zip" }) || "",
                addrphone: soShip.getValue({ fieldId: "addrphone" }) || ""
            };

            log.debug("SO_SHIP_ADDR", JSON.stringify(addrFields));

            po.setValue({ fieldId: "shipaddresslist", value: "" });

            var poShip = po.getSubrecord({ fieldId: "shippingaddress" });
            poShip.setValue({ fieldId: "country", value: addrFields.country });
            poShip.setValue({ fieldId: "addressee", value: addrFields.addressee });
            if (addrFields.attention) poShip.setValue({ fieldId: "attention", value: addrFields.attention });
            poShip.setValue({ fieldId: "addr1", value: addrFields.addr1 });
            if (addrFields.addr2) poShip.setValue({ fieldId: "addr2", value: addrFields.addr2 });
            poShip.setValue({ fieldId: "city", value: addrFields.city });
            poShip.setValue({ fieldId: "state", value: addrFields.state });
            poShip.setValue({ fieldId: "zip", value: addrFields.zip });
            if (addrFields.addrphone) poShip.setValue({ fieldId: "addrphone", value: addrFields.addrphone });

            log.debug("PO_SHIP_ADDR_SET", "Copied SO " + soId + " shipping address to PO");
            return { success: true, address: addrFields };
        } catch (e) {
            log.error("COPY_SHIP_ADDR_ERR", "SO " + soId + ": " + e.message);
            return { success: false, error: e.message };
        }
    }

    function setStockingShipAddress(po, stockingWarehouse) {
        try {
            var addr = WAREHOUSE_ADDRESS_MAP[stockingWarehouse];
            if (!addr) {
                return { success: false, error: "No address mapping for warehouse: " + stockingWarehouse };
            }

            po.setValue({ fieldId: "shipaddresslist", value: "" });

            var poShip = po.getSubrecord({ fieldId: "shippingaddress" });
            poShip.setValue({ fieldId: "country", value: addr.country });
            poShip.setValue({ fieldId: "addressee", value: addr.addressee });
            poShip.setValue({ fieldId: "addr1", value: addr.addr1 });
            if (addr.addr2) poShip.setValue({ fieldId: "addr2", value: addr.addr2 });
            poShip.setValue({ fieldId: "city", value: addr.city });
            poShip.setValue({ fieldId: "state", value: addr.state });
            poShip.setValue({ fieldId: "zip", value: addr.zip });

            log.debug("STOCKING_SHIP_ADDR", "Set shipping address for warehouse " + stockingWarehouse);
            return { success: true, warehouse: stockingWarehouse, address: addr };
        } catch (e) {
            log.debug("STOCKING_SHIP_ADDR_ERR", e.message);
            return { success: false, error: e.message };
        }
    }

    function isVendorApprovedForItem(itemId, vendorId) {
        if (!itemId || !vendorId) return false;

        try {
            var itemIntId = parseInt(itemId, 10);
            var vendorIntId = parseInt(vendorId, 10);
            if (isNaN(itemIntId) || isNaN(vendorIntId)) return false;

            var sql = "SELECT 1 AS ok FROM itemvendor WHERE item = ? AND vendor = ? FETCH FIRST 1 ROWS ONLY";
            var resultSet = query.runSuiteQL({ query: sql, params: [itemIntId, vendorIntId] });
            var rows = resultSet.asMappedResults();

            var approved = rows.length > 0;
            log.audit("VENDOR_CHECK", "Item " + itemIntId + " + Vendor " + vendorIntId + " = " + (approved ? "APPROVED" : "NOT APPROVED"));
            return approved;
        } catch (e) {
            log.error("VENDOR_CHECK_ERR", e.message);
            return false;
        }
    }

    var getKitMembers = function(kitItemId) {
        var members = [];
        try {
            var kitItemIntId = parseInt(kitItemId, 10);
            var sql = 
                "SELECT item FROM KitItemMember WHERE parentitem = ? " +
                "UNION " +
                "SELECT item FROM ItemMember WHERE parentitem = ?";
            
            var resultSet = query.runSuiteQL({ 
                query: sql, 
                params: [kitItemIntId, kitItemIntId] 
            });
            var rows = resultSet.asMappedResults();
            for (var i = 0; i < rows.length; i++) {
                members.push(parseInt(rows[i].item, 10));
            }
        } catch (e) {
            log.error("GET_KIT_MEMBERS_ERR", "Kit " + kitItemId + ": " + e.message);
        }
        return members;
    }

    function findLinkedSO(websiteOrderNumber, poSkus) {
        if (!websiteOrderNumber || !poSkus || poSkus.length === 0) return null;

        log.debug("FIND_LINKED_SO_START", "Searching for SO with otherrefnum exactly: " + websiteOrderNumber);

        var sql = "SELECT id, tranid, entity FROM transaction WHERE type = 'SalesOrd' AND otherrefnum = ?";
        var resultSet = query.runSuiteQL({ query: sql, params: [String(websiteOrderNumber)] });
        var soResults = resultSet.asMappedResults();

        if (soResults.length === 0) {
            log.debug("LINKED_SO", "No SO found for website_order_number: " + websiteOrderNumber);
            return null;
        }

        log.debug("LINKED_SO_MULTIPLE", "Found " + soResults.length + " exact SO(s) for otherrefnum " + websiteOrderNumber);

        for (var i = 0; i < soResults.length; i++) {
            var soId = parseInt(soResults[i].id, 10);
            var soTranId = soResults[i].tranid;
            var soCustId = parseInt(soResults[i].entity, 10);

            try {
                var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
                var lineCount = so.getLineCount({ sublistId: "item" });
                var hasMatchingItem = false;
                var soItemDetails = [];

                for (var li = 0; li < lineCount; li++) {
                    var lineItemId = String(so.getSublistValue({ sublistId: "item", fieldId: "item", line: li }));
                    var lineItemText = String(so.getSublistText({ sublistId: "item", fieldId: "item", line: li }) || "");
                    var lineSku = getItemSkuById(lineItemId);

                    soItemDetails.push({ itemId: lineItemId, sku: lineSku, text: lineItemText });

                    for (var psi = 0; psi < poSkus.length; psi++) {
                        var poSku = String(poSkus[psi]).toUpperCase();
                        if ((lineSku && lineSku.toUpperCase() === poSku) ||
                            lineItemText.toUpperCase().indexOf(poSku) >= 0) {
                            hasMatchingItem = true;
                            log.audit("SO_ITEM_MATCH", "SO " + soTranId + " (ID " + soId + ") line " + li + " matches PO SKU " + poSku + " (itemId: " + lineItemId + ")");
                            break;
                        }
                    }
                    if (hasMatchingItem) break;
                }

                if (hasMatchingItem) {
                    log.audit("LINKED_SO", "Found SO " + soTranId + " (ID " + soId + ", customer " + soCustId + ") with matching item for website_order_number: " + websiteOrderNumber);
                    return {
                        id: soId,
                        tranid: soTranId,
                        customerId: soCustId,
                        itemDetails: soItemDetails
                    };
                } else {
                    log.debug("SO_NO_ITEM_MATCH", "SO " + soTranId + " (ID " + soId + ") does not have matching items. Items: " + JSON.stringify(soItemDetails));
                }
            } catch (e) {
                log.error("SO_LOAD_ERR", "Error loading SO " + soId + ": " + e.message);
            }
        }

        log.error("LINKED_SO_NO_MATCH", "No SO with otherrefnum " + websiteOrderNumber + " has matching items for SKUs: " + poSkus.join(", "));
        return null;
    }

    function updateSOForDropship(soId, dropshipLocationId, resolvedItems, vendorId) {
        if (!soId) return { success: false, reason: "no soId provided" };

        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });
        var lineCount = so.getLineCount({ sublistId: "item" });
        var linesChanged = 0;
        var validDropshipLines = 0;
        var skippedLines = [];

        var soStatus = so.getValue({ fieldId: "status" });
        log.debug("SO_STATUS", "SO " + soId + " status=" + soStatus + ", lines=" + lineCount);

        var qtyMap = {};
        var skuMap = {};
        var skuList = [];

        if (resolvedItems && resolvedItems.length > 0) {
            for (var qi = 0; qi < resolvedItems.length; qi++) {
                var ri = resolvedItems[qi];
                qtyMap[String(ri.itemId)] = ri.qty;
                if (ri.sku) {
                    var upperSku = String(ri.sku).toUpperCase();
                    skuMap[upperSku] = { qty: ri.qty, itemId: ri.itemId };
                    skuList.push(upperSku);
                }
                if (ri.kitParentSku) {
                    var upperKit = String(ri.kitParentSku).toUpperCase();
                    skuMap[upperKit] = { qty: ri.qty, itemId: ri.itemId, isKit: true };
                    if (skuList.indexOf(upperKit) === -1) skuList.push(upperKit);
                }
            }
        }

        log.debug("SO_MATCH_MAPS", "qtyMap keys: " + Object.keys(qtyMap).join(", ") + " | skuList: " + skuList.join(", "));

        for (var i = 0; i < lineCount; i++) {
            so.selectLine({ sublistId: "item", line: i });
            var changed = false;

            var lineItemId = String(so.getCurrentSublistValue({ sublistId: "item", fieldId: "item" }));
            var lineItemText = String(so.getCurrentSublistText({ sublistId: "item", fieldId: "item" }) || "");
            var lineDesc = "";
            try {
                lineDesc = String(so.getCurrentSublistValue({ sublistId: "item", fieldId: "description" }) || "").toUpperCase();
            } catch (e) {}

            var lineSku = getItemSkuById(lineItemId);
            var lineSkuUpper = lineSku ? lineSku.toUpperCase() : "";

            log.debug("SO_LINE_SCAN", "Line " + i + ": itemId=" + lineItemId + ", itemText=" + lineItemText + ", sku=" + lineSku + ", desc=" + lineDesc.substring(0, 50));

            var matchedQty = undefined;
            var matchSource = "none";

            if (qtyMap[lineItemId] !== undefined) {
                matchedQty = qtyMap[lineItemId];
                matchSource = "itemId";
            }

            if (matchedQty === undefined && lineSkuUpper && skuMap[lineSkuUpper]) {
                matchedQty = skuMap[lineSkuUpper].qty;
                matchSource = "itemSku";
                log.debug("SO_SKU_MATCH", "Line " + i + ": Matched by item SKU '" + lineSku + "' (itemId " + lineItemId + ")");
            }

            if (matchedQty === undefined) {
                var itemTextUpper = lineItemText.toUpperCase();
                for (var sIdx = 0; sIdx < skuList.length; sIdx++) {
                    var checkSku = skuList[sIdx];
                    if (itemTextUpper.indexOf(checkSku) >= 0) {
                        matchedQty = skuMap[checkSku].qty;
                        matchSource = "itemText";
                        log.debug("SO_TEXT_MATCH", "Line " + i + ": Matched by item text containing '" + checkSku + "'");
                        break;
                    }
                }
            }

            if (matchedQty === undefined && lineDesc) {
                for (var dIdx = 0; dIdx < skuList.length; dIdx++) {
                    var checkSku2 = skuList[dIdx];
                    if (lineDesc.indexOf(checkSku2) >= 0) {
                        matchedQty = skuMap[checkSku2].qty;
                        matchSource = "description";
                        log.debug("SO_DESC_MATCH", "Line " + i + ": Matched by description containing '" + checkSku2 + "'");
                        break;
                    }
                }
            }

            if (dropshipLocationId) {
                var currentLoc = so.getCurrentSublistValue({ sublistId: "item", fieldId: "location" });
                if (String(currentLoc) !== String(dropshipLocationId)) {
                    so.setCurrentSublistValue({
                        sublistId: "item", fieldId: "location",
                        value: dropshipLocationId, ignoreFieldChange: false
                    });
                    changed = true;
                }
            } else {
                try {
                    var currentLoc = so.getCurrentSublistValue({ sublistId: "item", fieldId: "location" });
                    if (currentLoc) {
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: null, ignoreFieldChange: false });
                        changed = true;
                    }
                } catch (e) {
                    log.debug("CLEAR_LOC_ERR", "Could not clear location: " + e.message);
                }
            }

            if (matchedQty !== undefined) {
                var currentQty = so.getCurrentSublistValue({ sublistId: "item", fieldId: "quantity" });
                var desiredQty = matchedQty;
                if (Number(currentQty) !== Number(desiredQty)) {
                    var currentRate = Number(so.getCurrentSublistValue({ sublistId: "item", fieldId: "rate" })) || 0;
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: desiredQty, ignoreFieldChange: false });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: desiredQty * currentRate, ignoreFieldChange: false });
                    log.debug("SO_QTY_UPDATE", "Line " + i + ": qty " + currentQty + " -> " + desiredQty);
                    changed = true;
                }
                try {
                    var currentCommit = so.getCurrentSublistValue({ sublistId: "item", fieldId: "commitinventory" });
                    if (String(currentCommit) !== "3") {
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "commitinventory", value: "3", ignoreFieldChange: false });
                        changed = true;
                        log.debug("SO_COMMIT_UPDATE", "Line " + i + ": commitinventory -> Do Not Commit (3)");
                    }
                } catch (cErr) {
                    log.error("SO_COMMIT_ERR", "Could not set commitinventory: " + cErr.message);
                }
            }

            if (matchedQty === undefined) {
                log.debug("DROPSHIP_LINE_SKIPPED", JSON.stringify({ soId: soId, line: i, itemId: lineItemId, item: lineItemText, sku: lineSku, reason: "not in resolvedItems" }));
                so.cancelLine({ sublistId: "item" });
                continue;
            }

            var vendorApproved = true;
            if (vendorId) {
                vendorApproved = isVendorApprovedForItem(lineItemId, vendorId);
                if (!vendorApproved) {
                    log.error("DROPSHIP_VENDOR_NOT_APPROVED", "Vendor " + vendorId + " is NOT approved on item " + lineItemText + " (itemId " + lineItemId + ")");
                    skippedLines.push({ line: i, itemId: lineItemId, item: lineItemText, reason: "vendor_not_approved" });
                }
            }

            try {
                so.setCurrentSublistValue({ sublistId: "item", fieldId: "createpo", value: "DropShip", ignoreFieldChange: false });
                log.debug("DROPSHIP_LINE_READY", JSON.stringify({ soId: soId, line: i, itemId: lineItemId, item: lineItemText, vendorId: vendorId, createpo: "DropShip", vendorApproved: vendorApproved, matchSource: matchSource }));
                validDropshipLines++;
            } catch (e) {
                log.error("CREATEPO_ERR", "Line " + i + " item " + lineItemId + ": " + e.message);
                skippedLines.push({ line: i, itemId: lineItemId, item: lineItemText, reason: "createpo_failed: " + e.message });
                so.cancelLine({ sublistId: "item" });
                continue;
            }

            if (vendorId) {
                try {
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "povendor", value: parseInt(vendorId, 10), ignoreFieldChange: false });
                    log.debug("POVENDOR_SET", "Line " + i + ": povendor = " + vendorId);
                } catch (e) {
                    log.error("POVENDOR_ERR", "Could not set povendor on SO line " + i + ": " + e.message);
                    skippedLines.push({ line: i, itemId: lineItemId, item: lineItemText, reason: "povendor_failed: " + e.message });
                    so.cancelLine({ sublistId: "item" });
                    validDropshipLines--;
                    continue;
                }
            }

            changed = true;
            so.commitLine({ sublistId: "item" });
            linesChanged++;
        }

        if (validDropshipLines === 0) {
            return {
                success: false,
                reason: "No sales order lines are eligible for dropship. Skipped: " + JSON.stringify(skippedLines),
                soId: soId,
                soStatus: soStatus,
                skippedLines: skippedLines
            };
        }

        if (linesChanged === 0) {
            log.debug("SO_SETUP_SKIP", "All " + lineCount + " lines already correct - skipping save");
            return { success: true, soId: soId, linesChanged: 0, soStatus: soStatus, validDropshipLines: validDropshipLines };
        }

        var savedSoId = so.save({ enableSourcing: true, ignoreMandatoryFields: true });
        log.audit("SO_SETUP_SAVED", "SO " + savedSoId + " - " + linesChanged + "/" + lineCount + " lines updated, " + validDropshipLines + " dropship-ready");

        return { success: true, soId: savedSoId, linesChanged: linesChanged, soStatus: soStatus, validDropshipLines: validDropshipLines };
    }

    // Find a PO that is BOTH linked to this SO AND has our specific po_number as otherrefnum.
    function findLinkedPOByNumber(soId, poNumber) {
        try {
            var results = search.create({
                type: search.Type.PURCHASE_ORDER,
                filters: [
                    ["createdfrom", "anyof", soId],
                    "AND",
                    ["otherrefnum", "equalto", String(poNumber)],
                    "AND",
                    ["mainline", "is", "T"]
                ],
                columns: ["internalid", "tranid"]
            }).run().getRange({ start: 0, end: 1 });

            if (!results || results.length === 0) {
                log.debug("FIND_LINKED_PO_BY_NUM", "No PO found for SO " + soId + " with otherrefnum=" + poNumber);
                return null;
            }
            log.audit("FIND_LINKED_PO_BY_NUM", "Found PO " + results[0].getValue("tranid") + " (ID " + results[0].id + ") for SO " + soId + " / PO# " + poNumber);
            return { id: parseInt(results[0].id, 10), poNumber: results[0].getValue("tranid") };
        } catch (e) {
            log.error("FIND_LINKED_PO_BY_NUM_ERR", e.message);
            return null;
        }
    }

    // Returns the full set of PO IDs currently linked to this SO (for before/after diffing).
    function getAllLinkedPOIds(soId) {
        try {
            var results = search.create({
                type: search.Type.PURCHASE_ORDER,
                filters: [
                    ["createdfrom", "anyof", soId],
                    "AND",
                    ["mainline", "is", "T"]
                ],
                columns: ["internalid"]
            }).run().getRange({ start: 0, end: 1000 });

            var ids = {};
            if (results) {
                for (var i = 0; i < results.length; i++) {
                    ids[String(results[i].id)] = true;
                }
            }
            return ids;
        } catch (e) {
            log.error("GET_ALL_LINKED_PO_IDS_ERR", e.message);
            return {};
        }
    }

    // After a Kit auto-PO is created it gets ALL Kit component lines.
    // This trims the PO lines down to ONLY the items in this MongoDB PO's resolvedItems.
    function trimPOLinesToItems(po, resolvedItems) {
        var keepIds = {};
        for (var i = 0; i < resolvedItems.length; i++) {
            keepIds[String(resolvedItems[i].itemId)] = true;
        }
        var lineCount = po.getLineCount({ sublistId: "item" });
        var toRemove = [];
        for (var li = 0; li < lineCount; li++) {
            var lineItemId = String(po.getSublistValue({ sublistId: "item", fieldId: "item", line: li }));
            if (!keepIds[lineItemId]) toRemove.push(li);
        }
        // Remove from the bottom up so indices stay valid
        for (var ri = toRemove.length - 1; ri >= 0; ri--) {
            po.removeLine({ sublistId: "item", line: toRemove[ri] });
        }
        log.debug("TRIM_PO_LINES", "Removed " + toRemove.length + " lines not belonging to this PO. Kept: " + Object.keys(keepIds).join(", "));
        return toRemove.length;
    }

    function setPOHeaders(po, opts) {
        try { po.setValue({ fieldId: "tranid", value: "PO" + String(opts.po_number) }); } catch (e) {
            log.debug("TRANID_SKIP", "Could not set tranid: " + e.message);
        }
        po.setValue({ fieldId: "otherrefnum", value: String(opts.po_number) });
        var poDate = opts.created_at ? new Date(opts.created_at) : new Date();
        if (isNaN(poDate.getTime())) poDate = new Date();
        po.setValue({ fieldId: "trandate", value: poDate });

        try { po.setValue({ fieldId: "custbody2", value: String(opts.distributor_order_number || opts.po_number) }); } catch (e) {
            log.debug("FIELD_SKIP", "custbody2: " + e.message);
        }
        try { po.setValue({ fieldId: "custbody1", value: opts.status }); } catch (e) {
            log.debug("FIELD_SKIP", "custbody1: " + e.message);
        }
        if (opts.distributor) {
            try { po.setValue({ fieldId: "custbody_otherrefnumber_custom", value: String(opts.distributor) }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody_otherrefnumber_custom: " + e.message);
            }
        }
        if (opts.linkedSoId) {
            try { po.setValue({ fieldId: "custbody_linkedsalesorder", value: parseInt(opts.linkedSoId, 10) }); } catch (e) {
                log.debug("FIELD_SKIP", "custbody_linkedsalesorder: " + e.message);
            }
        }
    }

    function clearSOCreatePO(soId) {
        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });
        var lineCount = so.getLineCount({ sublistId: "item" });
        var cleared = 0;

        for (var ci = 0; ci < lineCount; ci++) {
            so.selectLine({ sublistId: "item", line: ci });
            try {
                so.setCurrentSublistValue({ sublistId: "item", fieldId: "createpo", value: "", ignoreFieldChange: true });
                so.setCurrentSublistValue({ sublistId: "item", fieldId: "povendor", value: "", ignoreFieldChange: true });
                so.commitLine({ sublistId: "item" });
                cleared++;
            } catch (lineErr) {
                log.debug("SO_CLEAR_LINE_ERR", "Line " + ci + ": " + lineErr.message);
                try { so.cancelLine({ sublistId: "item" }); } catch (e) { }
            }
        }

        var cleanedId = so.save({ enableSourcing: false, ignoreMandatoryFields: true });
        log.debug("SO_CREATEPO_CLEAN_SAVED", "SO " + cleanedId + " - cleared createpo/povendor on " + cleared + "/" + lineCount + " lines");
        return { soId: cleanedId, linesCleared: cleared, totalLines: lineCount };
    }

    function processSinglePO(payload) {
        var before = null;
        var after = null;
        var diff = null;

        try {
            log.debug("PAYLOAD", JSON.stringify(payload));

            var action = payload.action || "skip";
            var po_number = payload.po_number;
            var otherrefnum = payload.otherrefnum;
            var vendor_id = payload.vendor_id;
            var distributor = payload.distributor || "";
            var distributor_order_number = payload.distributor_order_number || "";
            var status = payload.status || "";
            var invoice = payload.invoice;
            var website_order_number = payload.website_order_number || "";
            var order_items = payload.order_items;
            var po_type = payload.po_type || "";
            var stocking_warehouse = payload.stocking_warehouse || "";
            var created_at = payload.created_at || "";

            if (!po_number || String(po_number).trim() === "") {
                return { success: false, error: "Missing or empty po_number" };
            }
            po_number = String(po_number).trim();
            otherrefnum = String(otherrefnum || po_number).trim();
            if (!otherrefnum) {
                return { success: false, error: "Missing otherrefnum (po_number resolved to empty)" };
            }

            var existing = findPurchaseOrder(otherrefnum);

            if (existing && action === "skip") {
                log.audit("SKIP", "PO " + po_number + " already exists (ID " + existing.id + "). Skipping.");
                return { success: true, action: "skipped", po_number: po_number, internalId: existing.id, poNumber: existing.poNumber };
            }

            // ── For Dropship: find linked SO before creating PO ───────────────
            var linkedSoId = null;
            var linkedSoNumber = null;
            var linkedSoCustomerId = null;

            if (po_type === "Dropship") {
                if (!website_order_number || String(website_order_number).trim() === "") {
                    log.error("DROPSHIP_ABORT", "Aborting PO creation: Missing website_order_number in payload.");
                    return {
                        success: false,
                        error: "Dropship PO creation aborted. website_order_number is completely missing or empty.",
                        po_number: po_number,
                        website_order_number: website_order_number || ""
                    };
                }

                var poSkus = [];
                if (Array.isArray(order_items)) {
                    for (var k = 0; k < order_items.length; k++) {
                        if (order_items[k].sku) poSkus.push(order_items[k].sku);
                    }
                }
                
                var soInfo = findLinkedSO(website_order_number, poSkus);
                
                if (soInfo) {
                    linkedSoId = soInfo.id;
                    linkedSoNumber = soInfo.tranid;
                    linkedSoCustomerId = soInfo.customerId;
                } else {
                    log.error("DROPSHIP_ABORT", "Aborting PO creation: No matching Sales Order or matching SKUs found for website order: " + website_order_number);
                    return {
                        success: false,
                        error: "Dropship PO creation aborted. A valid, matching NetSuite Sales Order must exist to prevent creating a standalone PO.",
                        po_number: po_number,
                        website_order_number: website_order_number
                    };
                }
            }

            var skippedSkus = [];
            var resolvedItems = [];

            if (Array.isArray(order_items) && order_items.length > 0) {
                for (var ri = 0; ri < order_items.length; ri++) {
                    var rawItem = order_items[ri];
                    var rawSku = rawItem.sku;
                    if (!rawSku) continue;

                    try {
                        var riCol = search.createColumn({ name: "internalid" });
                        var rtCol = search.createColumn({ name: "type" });
                        var riResults = search.create({
                            type: search.Type.ITEM,
                            filters: [["itemid", "is", rawSku]],
                            columns: [riCol, rtCol]
                        }).run().getRange({ start: 0, end: 1 });

                        if (!riResults || riResults.length === 0) {
                            log.debug("ITEM_NOT_FOUND", "SKU \"" + rawSku + "\" not in NetSuite");
                            skippedSkus.push(rawSku);
                            continue;
                        }

                        var riId = parseInt(riResults[0].getValue(riCol), 10);
                        var riType = riResults[0].getText(rtCol) || riResults[0].getValue(rtCol);

                        if (riType === "Group" || riType === "Kit" || riType === "Kit/Package") {
                            log.debug("ITEM_SKIP_TYPE", "SKU \"" + rawSku + "\" is " + riType + " — skipping");
                            skippedSkus.push(rawSku + " (type:" + riType + ")");
                            continue;
                        }

                        log.debug("ITEM_FOUND", "SKU \"" + rawSku + "\" → ID " + riId + ", type: " + riType);
                        resolvedItems.push({
                            sku: rawSku,
                            itemId: riId,
                            qty: parseInt(rawItem.qty || rawItem.quantity, 10) || 1,
                            cost: parseFloat(rawItem.cost || rawItem.amount) || 0
                        });
                    } catch (lookErr) {
                        log.error("ITEM_LOOKUP_ERR", "SKU \"" + rawSku + "\" — " + lookErr.message);
                        skippedSkus.push(rawSku);
                    }
                }
            }

            var locationId = resolveLocation(po_type, stocking_warehouse);
            log.debug("LOCATION_RESOLVED", JSON.stringify({
                po_type: po_type,
                stocking_warehouse: stocking_warehouse,
                locationId: locationId
            }));

            var po;
            var isUpdate = false;
            var isDropshipCreate = false;
            var soSetupResult = null;
            var autoPOInfo = null;

            var headerOpts = {
                po_number: po_number,
                website_order_number: website_order_number,
                distributor_order_number: distributor_order_number,
                status: status,
                distributor: distributor,
                invoice: invoice,
                created_at: created_at
            };

            var dsFormId = findFormId("Ecomm BP - Purchase Order");

            if (po_type === "Dropship" && linkedSoId) {
                // ── PRIMARY CHECK: Does a PO for THIS exact po_number already exist linked to the SO? ──
                // This prevents two MongoDB POs from hijacking each other's NetSuite PO.
                autoPOInfo = findLinkedPOByNumber(linkedSoId, po_number);

                if (autoPOInfo) {
                    log.audit("LINKED_PO_FOUND_BY_NUM", "PO " + autoPOInfo.poNumber + " (ID " + autoPOInfo.id + ") already linked to SO " + linkedSoNumber + " for po_number=" + po_number);
                    po = record.load({ type: record.Type.PURCHASE_ORDER, id: autoPOInfo.id, isDynamic: true });
                    isUpdate = true;

                    if (dsFormId) po.setValue({ fieldId: "customform", value: parseInt(dsFormId, 10) });
                    if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });

                    setPOHeaders(po, headerOpts);
                    if (locationId) {
                        po.setValue({ fieldId: "location", value: "" });
                        log.debug("HEADER_LOCATION_SET", "Dropship PO location → " + locationId);
                    }

                } else {
                    // ── NO MATCHING LINKED PO — need to create a new one ──
                    // Snapshot existing linked PO IDs so we can detect the newly created one.
                    var beforeLinkedIds = getAllLinkedPOIds(linkedSoId);
                    log.debug("BEFORE_LINKED_POS", "Existing linked POs before SO update: " + JSON.stringify(Object.keys(beforeLinkedIds)));

                    log.debug("NO_AUTO_PO", "No linked PO for SO " + linkedSoId + " with po_number=" + po_number + " — updating SO to trigger auto-PO");

                    try {
                        var soLineMap = {};
                        try {
                            var soLookup = record.load({ type: record.Type.SALES_ORDER, id: linkedSoId, isDynamic: false });
                            var scount = soLookup.getLineCount({ sublistId: "item" });
                            for (var si = 0; si < scount; si++) {
                                var sItemId = soLookup.getSublistValue({ sublistId: "item", fieldId: "item", line: si });
                                var sLineId = soLookup.getSublistValue({ sublistId: "item", fieldId: "line", line: si });
                                if (!soLineMap[sItemId]) soLineMap[sItemId] = sLineId;
                                var members = getKitMembers(sItemId);
                                for (var mi = 0; mi < members.length; mi++) {
                                    var memberId = String(members[mi]);
                                    if (!soLineMap[memberId]) soLineMap[memberId] = sLineId;
                                }
                            }
                        } catch (e) { log.debug("SO_LINE_LOOKUP_ERR", e.message); }

                        var soRec = record.load({ type: record.Type.SALES_ORDER, id: linkedSoId, isDynamic: true });
                        var soLineCount = soRec.getLineCount({ sublistId: "item" });
                        var soLinesUpdated = 0;
                        var poNeedsSpecOrd = false;

                        for (var sli = 0; sli < soLineCount; sli++) {
                            var soLineItemId = soRec.getSublistValue({ sublistId: "item", fieldId: "item", line: sli });

                            // 1. Build a map of ONLY the items in THIS specific PO payload
                            var payloadItemIds = {};
                            for (var ri = 0; ri < resolvedItems.length; ri++) {
                                payloadItemIds[String(resolvedItems[ri].itemId)] = true;
                            }

                            // 2. Check if the Sales Order line item matches our payload items
                            var isMatchedLine = false;
                            var matchReason = "none";
                            
                            if (payloadItemIds[String(soLineItemId)]) {
                                isMatchedLine = true;
                                matchReason = "Direct ID Match";
                            } else {
                                // 3. If it's a Kit, check if any Kit members match our payload items
                                var members = getKitMembers(soLineItemId);
                                for (var mi = 0; mi < members.length; mi++) {
                                    if (payloadItemIds[String(members[mi])]) {
                                        isMatchedLine = true;
                                        matchReason = "Kit Member ID Match (" + members[mi] + ")";
                                        break;
                                    }
                                }
                            }

                            // 4. Ultra-Robust Text Fallback match for composite item names (e.g., "SKU1, SKU2")
                            var lineTextUpper = String(soRec.getSublistText({ sublistId: "item", fieldId: "item", line: sli }) || "").toUpperCase();
                            var lineDescUpper = String(soRec.getSublistValue({ sublistId: "item", fieldId: "description", line: sli }) || "").toUpperCase();
                            var lineSkuUpper = (getItemSkuById(soLineItemId) || "").toUpperCase();
                            
                            if (!isMatchedLine) {
                                for (var fbi = 0; fbi < resolvedItems.length; fbi++) {
                                    var rSku = String(resolvedItems[fbi].sku).toUpperCase();
                                    if (rSku && (lineTextUpper.indexOf(rSku) >= 0 || lineDescUpper.indexOf(rSku) >= 0 || lineSkuUpper.indexOf(rSku) >= 0)) {
                                        isMatchedLine = true;
                                        matchReason = "Text Fallback Match (" + rSku + ")";
                                        break;
                                    }
                                }
                            }

                            log.debug("LINE_MATCH_EVAL", JSON.stringify({
                                line: sli,
                                itemId: soLineItemId,
                                sku: lineSkuUpper,
                                text: lineTextUpper,
                                desc: lineDescUpper.substring(0, 30),
                                matched: isMatchedLine,
                                reason: matchReason
                            }));

                            if (!isMatchedLine) {
                                log.debug("SKIPPING_SO_LINE", "Line " + sli + " (item " + soLineItemId + ") does not belong to this PO's payload items. Skipping.");
                                continue;
                            }

                            var preferredVendor = null;
                            var isKit = false;

                            try {
                                var itemLookup = search.lookupFields({
                                    type: search.Type.ITEM,
                                    id: soLineItemId,
                                    columns: ["vendor", "type"]
                                });

                                if (itemLookup.vendor && itemLookup.vendor.length > 0) {
                                    preferredVendor = parseInt(itemLookup.vendor[0].value, 10);
                                    log.debug("PREFERRED_VENDOR", "Item " + soLineItemId + " preferred vendor: " + preferredVendor);
                                }

                                if (itemLookup.type && itemLookup.type.length > 0) {
                                    var typeVal = String(itemLookup.type[0].value).toUpperCase();
                                    var typeText = String(itemLookup.type[0].text).toUpperCase();
                                    if (typeVal.indexOf("KIT") >= 0 || typeText.indexOf("KIT") >= 0) {
                                        isKit = true;
                                        poNeedsSpecOrd = true;
                                        log.debug("KIT_DETECTED", "Item " + soLineItemId + " is a Kit. Will generate Special Order PO.");
                                    }
                                }
                            } catch (vlErr) {
                                log.debug("ITEM_LOOKUP_ERR", "Item " + soLineItemId + ": " + vlErr.message);
                            }

                            // var createPoValue = isKit ? "SpecOrd" : "DropShip";
                            // soRec.setSublistValue({ sublistId: "item", fieldId: "createpo", line: sli, value: createPoValue });

                            // if (locationId) {
                            //     soRec.setSublistValue({ sublistId: "item", fieldId: "location", line: sli, value: locationId });
                            // }

                            // var resolvedVendor = preferredVendor || (vendor_id ? parseInt(vendor_id, 10) : null);
                            // if (resolvedVendor) {
                            //     soRec.setSublistValue({ sublistId: "item", fieldId: "povendor", line: sli, value: resolvedVendor });
                            //     log.debug("SO_LINE_SET", "Line " + sli + ": createpo=" + createPoValue + ", povendor=" + resolvedVendor + (preferredVendor ? " (preferred)" : " (payload fallback)"));
                            // }

                            // soLinesUpdated++;
                            // Correct Dynamic Mode execution path: Select -> Set Current -> Commit
                            soRec.selectLine({ sublistId: "item", line: sli });

                            var createPoValue = isKit ? "SpecOrd" : "DropShip";
                            soRec.setCurrentSublistValue({ sublistId: "item", fieldId: "createpo", value: createPoValue, ignoreFieldChange: false });

                            if (locationId) {
                                soRec.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                            }

                            var resolvedVendor = preferredVendor || (vendor_id ? parseInt(vendor_id, 10) : null);
                            if (resolvedVendor) {
                                soRec.setCurrentSublistValue({ sublistId: "item", fieldId: "povendor", value: resolvedVendor, ignoreFieldChange: false });
                                log.debug("SO_LINE_SET", "Line " + sli + ": createpo=" + createPoValue + ", povendor=" + resolvedVendor + (preferredVendor ? " (preferred)" : " (payload fallback)"));
                            }

                            soRec.commitLine({ sublistId: "item" });
                            soLinesUpdated++;
                        }

                        var savedSoId = soRec.save({ enableSourcing: true, ignoreMandatoryFields: true });
                        log.debug("SO_DROPSHIP_SAVED", "SO " + savedSoId + " updated — " + soLinesUpdated + " lines set to createpo=DropShip");
                        soSetupResult = { success: true, soId: savedSoId, linesUpdated: soLinesUpdated };

                        // ── Bypassing Search Index with Polling Loop: find the PO natively from the SO Lines ───────
                        var newlyCreatedId = null;
                        var maxPolls = 8; // poll up to 8 times
                        var pollIntervalMs = 1000; // wait 1 second between polls
                        
                        log.debug("PO_POLLING_START", "Starting to poll SO " + savedSoId + " line links for auto-created PO...");

                        for (var poll = 1; poll <= maxPolls; poll++) {
                            try {
                                // Sleep for 1 second on subsequent iterations to give NetSuite background queue time to create the PO
                                if (poll > 1) {
                                    var sleepStart = new Date().getTime();
                                    while (new Date().getTime() < sleepStart + pollIntervalMs) {
                                        // busy wait
                                    }
                                }

                                var postSaveSo = record.load({ type: record.Type.SALES_ORDER, id: savedSoId, isDynamic: false });
                                var postLineCount = postSaveSo.getLineCount({ sublistId: "item" });
                                for (var p_li = 0; p_li < postLineCount; p_li++) {
                                    var poLink = postSaveSo.getSublistValue({ sublistId: "item", fieldId: "createdpo", line: p_li });
                                    if (poLink) {
                                        if (!beforeLinkedIds[String(poLink)]) {
                                            newlyCreatedId = parseInt(poLink, 10);
                                            log.audit("PO_LINK_FOUND_VIA_POLLING", "Poll #" + poll + ": Read createdpo=" + poLink + " directly from SO line " + p_li);
                                            break;
                                        }
                                    }
                                }

                                if (newlyCreatedId) break;

                                log.debug("PO_POLLING_RETRY", "Poll #" + poll + ": PO link not populated yet on SO. Retrying...");

                            } catch (poLinkErr) {
                                log.error("SO_POLL_ERR", "Poll #" + poll + " error: " + poLinkErr.message);
                            }
                        }

                        // Fallback to search index diff if the above polling fails
                        if (!newlyCreatedId) {
                            log.debug("PO_POLLING_FAILED", "Polling SO lines completed without finding PO link. Trying Search Index Diff fallback...");
                            var afterLinkedIds = getAllLinkedPOIds(linkedSoId);
                            for (var nk in afterLinkedIds) {
                                if (!beforeLinkedIds[nk]) { newlyCreatedId = parseInt(nk, 10); break; }
                            }
                        }

                        if (newlyCreatedId) {
                            autoPOInfo = { id: newlyCreatedId, poNumber: "PO" + po_number };
                            log.audit("AUTO_PO_FOUND_NEW", "Newly created PO ID " + newlyCreatedId + " detected for po_number=" + po_number);
                            po = record.load({ type: record.Type.PURCHASE_ORDER, id: newlyCreatedId, isDynamic: true });
                            isUpdate = true;

                            // Trim Kit-exploded lines: keep only this PO's items
                            if (resolvedItems.length > 0) {
                                trimPOLinesToItems(po, resolvedItems);
                            }

                            if (dsFormId) po.setValue({ fieldId: "customform", value: parseInt(dsFormId, 10) });
                            if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                            if (locationId) {
                                po.setValue({ fieldId: "location", value: "" });
                                log.debug("HEADER_LOCATION_SET", "Auto-PO location → " + locationId);
                            }
                            setPOHeaders(po, headerOpts);

                            try {
                                var soCleanResult = clearSOCreatePO(savedSoId);
                                log.debug("SO_CREATEPO_CLEARED", JSON.stringify(soCleanResult));
                                if (soSetupResult) soSetupResult.createpoCleared = soCleanResult;
                            } catch (cleanErr) {
                                log.error("SO_CREATEPO_CLEAR_ERR", cleanErr.message);
                            }

                        } else {
                            log.debug("AUTO_PO_MISSING", "No auto-PO found — creating PO natively from SO " + linkedSoId);
                            var safeVendorId = vendor_id ? parseInt(vendor_id, 10) : null;
                            try {
                                var defaults = { soid: parseInt(linkedSoId, 10) };
                                if (poNeedsSpecOrd) {
                                    defaults.specord = "T";
                                } else {
                                    defaults.dropship = "T";
                                }

                                po = record.create({
                                    type: record.Type.PURCHASE_ORDER,
                                    isDynamic: true,
                                    defaultValues: defaults
                                });
                                log.debug("NATIVE_PO_CREATE", "Created PO natively with " + (poNeedsSpecOrd ? "specord=T" : "dropship=T"));
                                
                                if (safeVendorId && !isNaN(safeVendorId)) {
                                    try { po.setValue({ fieldId: "entity", value: safeVendorId }); } catch (ev) { }
                                }
                            } catch (transformErr) {
                                var transformErrMsg = transformErr.message || "Unknown error";
                                log.error("TRANSFORM_FAILED", transformErrMsg);
                                return {
                                    success: false,
                                    error: transformErrMsg,
                                    po_number: po_number,
                                    linkedSoId: linkedSoId
                                };
                            }
                            isDropshipCreate = true;

                            // Trim Kit-exploded lines: keep only this PO's items
                            if (resolvedItems.length > 0) {
                                trimPOLinesToItems(po, resolvedItems);
                            }

                            var dsFormId2 = findFormId("Ecomm BP - Purchase Order");
                            if (dsFormId2) po.setValue({ fieldId: "customform", value: parseInt(dsFormId2, 10) });
                            if (vendor_id) po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                            if (locationId) {
                                po.setValue({ fieldId: "location", value: "" });
                                log.debug("HEADER_LOCATION_SET", "Transform PO location → " + locationId);
                            }
                            setPOHeaders(po, headerOpts);
                            // clearSOCreatePO has been moved to execute strictly after po.save() is completed.
                        }

                    } catch (soErr) {
                        log.error("SO_DROPSHIP_FAILED", JSON.stringify({ soId: linkedSoId, error: soErr.message }));
                        return {
                            success: false,
                            error: "Sales Order update failed: " + soErr.message + ". PO creation aborted because linking to Sales Order is mandatory for Dropship/Special Order transactions.",
                            po_number: po_number,
                            linkedSoId: linkedSoId
                        };
                    }
                }

            } else if (existing && action === "update") {
                po = record.load({ type: record.Type.PURCHASE_ORDER, id: existing.id, isDynamic: true });
                isUpdate = true;

                var formId = findFormId("Ecomm BP - Purchase Order");
                if (formId) {
                    po.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
                    log.debug("FORM_SET", "customform → " + formId);
                }
                if (vendor_id) {
                    po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                }
                if (locationId) {
                    po.setValue({ fieldId: "location", value: "" });
                    log.debug("HEADER_LOCATION_SET", "Updated PO location → " + locationId);
                }
                setPOHeaders(po, headerOpts);

            } else {
                var raceCheck = findPurchaseOrder(otherrefnum);
                if (raceCheck) {
                    if (action === "skip") {
                        log.audit("RACE_GUARD_SKIP", "PO " + po_number + " was created by another worker (ID " + raceCheck.id + "). Skipping.");
                        return { success: true, action: "skipped", po_number: po_number, internalId: raceCheck.id, poNumber: raceCheck.poNumber, raceGuard: true };
                    }
                    log.audit("RACE_GUARD_UPDATE", "PO " + po_number + " was created by another worker (ID " + raceCheck.id + "). Loading for update.");
                    po = record.load({ type: record.Type.PURCHASE_ORDER, id: raceCheck.id, isDynamic: true });
                    isUpdate = true;
                    existing = raceCheck;
                } else {
                    po = record.create({ type: record.Type.PURCHASE_ORDER, isDynamic: true });
                }

                var formId2 = findFormId("Ecomm BP - Purchase Order");
                if (formId2) {
                    po.setValue({ fieldId: "customform", value: parseInt(formId2, 10) });
                    log.debug("FORM_SET", "customform → " + formId2);
                }
                if (vendor_id) {
                    po.setValue({ fieldId: "entity", value: parseInt(vendor_id, 10) });
                }
                if (locationId) {
                    po.setValue({ fieldId: "location", value: "" });
                    log.debug("HEADER_LOCATION_SET", "PO location → " + locationId);
                }
                setPOHeaders(po, headerOpts);
            }

            var shipResult = null;
            if (po_type === "Stocking" && stocking_warehouse) {
                shipResult = setStockingShipAddress(po, stocking_warehouse);
                log.debug("STOCKING_SHIP_RESULT", JSON.stringify(shipResult));
            }
            if (po_type === "Dropship" && linkedSoId) {
                shipResult = copySOShippingToPO(linkedSoId, po);
                log.debug("DROPSHIP_SHIP_RESULT", JSON.stringify(shipResult));
            }

            var poSubsidiary = "";
            try { poSubsidiary = po.getValue({ fieldId: "subsidiary" }); } catch (e) { }
            log.debug("ENTITY_SET", JSON.stringify({
                vendor: vendor_id,
                subsidiary: poSubsidiary,
                form: po.getValue({ fieldId: "customform" })
            }));

            before = snapshotPO(po);

            var oldLineCount = po.getLineCount({ sublistId: "item" });
            var linesAdded = 0;
            var linesUpdated = 0;

            if (isDropshipCreate && oldLineCount > 0) {
                log.debug("DROPSHIP_LINES", "Auto-populated " + oldLineCount + " lines from SO — updating rate/location only");

                var existingLineMap = {};
                for (var eli = 0; eli < oldLineCount; eli++) {
                    var existItemId = po.getSublistValue({ sublistId: "item", fieldId: "item", line: eli });
                    var mapKey = String(existItemId);
                    if (!existingLineMap[mapKey]) existingLineMap[mapKey] = [];
                    existingLineMap[mapKey].push(eli);
                }

                var matchedLines = {};
                var unmatchedItems = [];

                for (var mi = 0; mi < resolvedItems.length; mi++) {
                    var poItem = resolvedItems[mi];
                    var itemKey = String(poItem.itemId);
                    var matchedLine = -1;

                    if (existingLineMap[itemKey]) {
                        for (var mli = 0; mli < existingLineMap[itemKey].length; mli++) {
                            var candidate = existingLineMap[itemKey][mli];
                            if (!matchedLines[candidate]) {
                                matchedLine = candidate;
                                matchedLines[candidate] = true;
                                break;
                            }
                        }
                    }

                    if (matchedLine >= 0) {
                        try {
                            po.selectLine({ sublistId: "item", line: matchedLine });
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: poItem.cost, ignoreFieldChange: false });
                            if (locationId) {
                                po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                            }
                            po.commitLine({ sublistId: "item" });
                            linesUpdated++;
                            log.debug("LINE_UPDATED", "Line " + matchedLine + " — SKU \"" + poItem.sku + "\" rate=" + poItem.cost);
                        } catch (updErr) {
                            log.error("LINE_UPDATE_ERR", "Line " + matchedLine + " SKU \"" + poItem.sku + "\" — " + updErr.message);
                            unmatchedItems.push(poItem);
                        }
                    } else {
                        unmatchedItems.push(poItem);
                    }
                }

                for (var ui = 0; ui < unmatchedItems.length; ui++) {
                    var newItem = unmatchedItems[ui];
                    try {
                        po.selectNewLine({ sublistId: "item" });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: newItem.itemId, ignoreFieldChange: false });
                        if (locationId) {
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                        }
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: newItem.qty, ignoreFieldChange: false });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: newItem.cost, ignoreFieldChange: false });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: newItem.qty * newItem.cost, ignoreFieldChange: false });
                        try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "class", value: "", ignoreFieldChange: true }); } catch (e) { }
                        po.commitLine({ sublistId: "item" });
                        linesAdded++;
                    } catch (addErr) {
                        log.error("LINE_ADD_ERR", "SKU \"" + newItem.sku + "\" — " + addErr.message);
                        skippedSkus.push(newItem.sku);
                    }
                }

                var linesToRemove = [];
                for (var rli = 0; rli < oldLineCount; rli++) {
                    if (!matchedLines[rli]) linesToRemove.push(rli);
                }
                if (linesToRemove.length > 0) {
                    log.debug("REMOVE_UNMATCHED", "Removing " + linesToRemove.length + " auto-populated lines not in order_items");
                    for (var rmi = linesToRemove.length - 1; rmi >= 0; rmi--) {
                        po.removeLine({ sublistId: "item", line: linesToRemove[rmi] });
                    }
                }

                log.debug("DROPSHIP_LINE_RESULT", "Updated: " + linesUpdated + ", Added: " + linesAdded + ", Removed: " + linesToRemove.length);

            } else {
                var soLineMap = {};
                if (linkedSoId) {
                    try {
                        var soLookup = record.load({ type: record.Type.SALES_ORDER, id: linkedSoId, isDynamic: false });
                        var scount = soLookup.getLineCount({ sublistId: "item" });
                        for (var si = 0; si < scount; si++) {
                            var sItemId = soLookup.getSublistValue({ sublistId: "item", fieldId: "item", line: si });
                            var sLineId = soLookup.getSublistValue({ sublistId: "item", fieldId: "line", line: si });
                            if (!soLineMap[sItemId]) soLineMap[sItemId] = sLineId;
                            var members = getKitMembers(sItemId);
                            for (var mi = 0; mi < members.length; mi++) {
                                var memberId = String(members[mi]);
                                if (!soLineMap[memberId]) soLineMap[memberId] = sLineId;
                            }
                        }
                    } catch (e) { log.debug("SO_LINE_LOOKUP_ERR", e.message); }
                }

                for (var i = 0; i < resolvedItems.length; i++) {
                    var stdItem = resolvedItems[i];
                    try {
                        po.selectNewLine({ sublistId: "item" });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: stdItem.itemId, ignoreFieldChange: false });

                        if (linkedSoId && soLineMap[stdItem.itemId]) {
                            try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "orderdoc", value: linkedSoId, ignoreFieldChange: false }); } catch (e) { }
                            try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "orderline", value: soLineMap[stdItem.itemId], ignoreFieldChange: false }); } catch (e) { }
                        }

                        if (locationId) {
                            po.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId, ignoreFieldChange: false });
                            log.debug("LINE_LOCATION_SET", "SKU " + stdItem.sku + " location → " + locationId);
                        }
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: stdItem.qty, ignoreFieldChange: false });
                        po.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: stdItem.cost, ignoreFieldChange: false });
                        try { po.setCurrentSublistValue({ sublistId: "item", fieldId: "class", value: "", ignoreFieldChange: true }); } catch (e) { }
                        po.commitLine({ sublistId: "item" });
                        linesAdded++;
                        log.debug("ITEM_ADDED", "SKU \"" + stdItem.sku + "\" → lines now: " + po.getLineCount({ sublistId: "item" }));
                    } catch (lineErr) {
                        log.error("ITEM_SKIP", "SKU \"" + stdItem.sku + "\" — " + lineErr.message);
                        skippedSkus.push(stdItem.sku);
                    }
                }

                if (oldLineCount > 0) {
                    log.debug("REMOVE_OLD", "Removing " + oldLineCount + " old lines (new added: " + linesAdded + ")");
                    for (var r = oldLineCount - 1; r >= 0; r--) {
                        po.removeLine({ sublistId: "item", line: r });
                    }
                }
            }

            if (linesAdded === 0 && linesUpdated === 0) {
                after = snapshotPO(po);
                diff = diffSnapshots(before, after);
                var skuList = Array.isArray(order_items) ? order_items.map(function (x) { return x.sku; }).join(", ") : "none";
                return {
                    success: true,
                    action: "no_items",
                    po_number: po_number,
                    skus: skuList,
                    skipped: skippedSkus,
                    before: before, after: after, diff: diff
                };
            }

            try { po.setValue({ fieldId: "class", value: "" }); } catch (e) { }

            after = snapshotPO(po);
            diff = diffSnapshots(before, after);

            var savedId = po.save({ enableSourcing: false, ignoreMandatoryFields: true });
            log.debug("SUCCESS", "PO " + po_number + " saved → ID: " + savedId);
 
            // Clean up Sales Order lines only after the PO has successfully saved natively!
            if (isDropshipCreate && linkedSoId) {
                try {
                    var soCleanResult = clearSOCreatePO(linkedSoId);
                    log.debug("SO_CREATEPO_CLEARED_AFTER_SAVE", JSON.stringify(soCleanResult));
                    if (soSetupResult) soSetupResult.createpoCleared = soCleanResult;
                } catch (cleanErr) {
                    log.error("SO_CREATEPO_CLEAR_ERR_AFTER_SAVE", cleanErr.message);
                }
            }

            try {
                record.submitFields({
                    type: record.Type.PURCHASE_ORDER,
                    id: savedId,
                    values: { tranid: "PO" + String(po_number) },
                    options: { ignoreMandatoryFields: true }
                });
                log.debug("TRANID_FORCED", "Successfully forced tranid to PO" + po_number);
            } catch (forceErr) {
                log.error("TRANID_FORCE_ERR", "Could not force custom PO number: " + forceErr.message);
            }

            var createdfromResult = null;
            if (linkedSoId) {
                try {
                    // Bypass Search Index lag by querying the record fields directly
                    var poLookup = search.lookupFields({
                        type: search.Type.PURCHASE_ORDER,
                        id: savedId,
                        columns: ["createdfrom"]
                    });

                    var isLinked = false;
                    if (poLookup.createdfrom && poLookup.createdfrom.length > 0) {
                        isLinked = (String(poLookup.createdfrom[0].value) === String(linkedSoId));
                    }

                    createdfromResult = {
                        linked: isLinked,
                        soId: linkedSoId,
                        poId: savedId
                    };
                    log.debug("CREATEDFROM_VERIFY", JSON.stringify(createdfromResult));
                } catch (vErr) {
                    createdfromResult = { error: vErr.message };
                }
            }

            // ── SECOND CRITICAL GUARDRAIL FIX: Delete and abort if NetSuite dropped the native link ──
            if (po_type === "Dropship" && createdfromResult && createdfromResult.linked === false) {
                log.error("DROPSHIP_LINK_DROP_ABORT", "NetSuite successfully saved the PO ID " + savedId + " but dropped the native link. Deleting rogue standalone record.");
                
                try {
                    record.delete({
                        type: record.Type.PURCHASE_ORDER,
                        id: savedId
                    });
                    log.audit("DROPSHIP_CLEANUP_SUCCESS", "Successfully deleted standalone PO ID: " + savedId);
                } catch (delErr) {
                    log.error("DROPSHIP_CLEANUP_FAILED", "Could not automatically delete standalone PO ID " + savedId + ": " + delErr.message);
                }

                return {
                    success: false,
                    error: "Dropship PO creation aborted. NetSuite processed a standalone record but dropped the mandatory 'createdfrom' native link to Sales Order ID " + linkedSoId + " due to line/vendor data conflicts.",
                    po_number: po_number,
                    linkedSoId: linkedSoId
                };
            }

            return {
                success: true,
                action: isUpdate ? "updated" : (isDropshipCreate ? "created_dropship" : "created"),
                po_number: po_number,
                internalId: savedId,
                linesAdded: linesAdded,
                linesUpdated: linesUpdated,
                locationId: locationId,
                po_type: po_type,
                skippedSkus: skippedSkus.length > 0 ? skippedSkus : undefined,
                soSetup: soSetupResult,
                autoPO: autoPOInfo,
                createdfromResult: createdfromResult,
                linkedSo: linkedSoId ? { id: linkedSoId, soNumber: linkedSoNumber } : null,
                shipResult: shipResult,
                before: before, after: after, diff: diff
            };

        } catch (e) {
            log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return {
                success: false,
                error: e.message,
                po_number: payload ? payload.po_number : null,
                before: before, after: after, diff: diff
            };
        }
    }

    function findPurchaseOrder(otherrefnum) {
        var sql = "SELECT id, tranid FROM transaction WHERE type = 'PurchOrd' AND otherrefnum = ? ORDER BY id DESC";
        var resultSet = query.runSuiteQL({ query: sql, params: [String(otherrefnum)] });
        var rows = resultSet.asMappedResults();

        if (rows.length === 0) return null;

        if (rows.length > 1) {
            log.audit("PO_DUPLICATES", "Found " + rows.length + " POs for otherrefnum " + otherrefnum + " -- using newest (highest ID)");
        }

        return {
            id: parseInt(rows[0].id, 10),
            poNumber: rows[0].tranid
        };
    }

    function post(payload) {
        log.audit("BATCH_ENTRY", { timestamp: new Date().toISOString(), batch: !!(payload && payload.batch), count: payload && payload.batch ? payload.batch.length : 1 });
        try {
            if (!payload.batch || !Array.isArray(payload.batch)) {
                var singleResult = processSinglePO(payload);
                log.audit("BATCH_EXIT", { timestamp: new Date().toISOString(), mode: "single", result: singleResult });
                return singleResult;
            }

            var items = payload.batch;
            var script = runtime.getCurrentScript();
            var startUsage = script.getRemainingUsage();
            var MIN_GOVERNANCE = 200;

            log.audit("BATCH_START", "Processing batch of " + items.length + " POs, governance: " + startUsage);

            var results = [];
            var stopped = 0;

            for (var bi = 0; bi < items.length; bi++) {
                var remaining = script.getRemainingUsage();
                if (remaining < MIN_GOVERNANCE) {
                    stopped = items.length - bi;
                    log.audit("BATCH_GOV_STOP", "Stopping at PO " + bi + "/" + items.length + " - only " + remaining + " governance units left");
                    for (var si = bi; si < items.length; si++) {
                        results.push({
                            success: false,
                            po_number: items[si].po_number || null,
                            error: "governance_exhausted",
                            skipped: true
                        });
                    }
                    break;
                }

                try {
                    results.push(processSinglePO(items[bi]));
                } catch (batchErr) {
                    log.error("BATCH_PO_ERR", "PO " + (items[bi].po_number || "?") + ": " + batchErr.message);
                    results.push({
                        success: false,
                        po_number: items[bi].po_number || null,
                        error: batchErr.message,
                        stack: batchErr.stack || null
                    });
                }
            }

            var endUsage = script.getRemainingUsage();
            log.audit("BATCH_DONE", "Processed " + (items.length - stopped) + "/" + items.length + " POs, governance used: " + (startUsage - endUsage) + ", remaining: " + endUsage);

            var batchResult = {
                batch: true,
                total: items.length,
                processed: items.length - stopped,
                stopped: stopped,
                governanceUsed: startUsage - endUsage,
                governanceRemaining: endUsage,
                results: results
            };
            log.audit("BATCH_EXIT", { timestamp: new Date().toISOString(), mode: "batch", batchResult: batchResult });
            return batchResult;
        } catch (topErr) {
            log.error("RESTLET_TOPLEVEL_ERROR", JSON.stringify({ message: topErr.message, stack: topErr.stack }));
            log.audit("BATCH_EXIT", { timestamp: new Date().toISOString(), mode: "error", error: topErr.message, stack: topErr.stack });
            return {
                batch: !!(payload && payload.batch),
                total: payload && payload.batch ? payload.batch.length : 1,
                processed: 0,
                stopped: payload && payload.batch ? payload.batch.length : 1,
                error: topErr.message,
                stack: topErr.stack || null,
                results: []
            };
        }
    }

    return { post: post };
}); 