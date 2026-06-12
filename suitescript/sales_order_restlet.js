/**
 * NETSUITE RESTLET — Sales Order Sync (EBP)
 *
 * Deploy: RESTlet, POST function = post
 * Script ID: customscript_ebp_sales_order_sync (match your NetSuite script record)
 * Uses dynamic SO + location resolution from fulfillment_channel / ship state.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    // ========== CONFIGURATION ==========
    var CUSTOMER_MAP = {
        "amazon": "Amazon",
        "walmart": "Walmart",
        "newegg": "NewEgg",
        "newegg_business": "NewEgg Business",
        "ebay": "eBay",
        "shopify": "Shopify"
    };

    var CHANNEL_MAP = {
        "amazon": "3rd Party Marketplace : Amazon",
        "walmart": "3rd Party Marketplace : Walmart",
        "newegg": "3rd Party Marketplace : NewEgg",
        "newegg_business": "3rd Party Marketplace : Newegg Business",
        "ebay": "3rd Party Marketplace : eBay",
        "shopify": "Web : eComm"
    };

    var FORM_NAME = "Ecomm BP - Sales Order";
    var SKIP_ITEM_TYPES = ["Group"];

    // Caches
    var _customerCache = {};
    var _channelCache = {};
    var _formCache = {};
    var _locationCache = {};

    // ========== LOCATION RESOLUTION (no fallback — returns null if unresolved) ==========
    function findLocationId(locationName) {
        if (!locationName) return null;
        if (_locationCache[locationName]) return _locationCache[locationName];

        try {
            var locSearch = search.create({
                type: search.Type.LOCATION,
                filters: [
                    ["name", "is", locationName],
                    "AND",
                    ["isinactive", "is", "F"]
                ],
                columns: ["internalid"]
            });
            var results = locSearch.run().getRange({ start: 0, end: 1 });
            if (results.length > 0) {
                var locId = parseInt(results[0].getValue("internalid"), 10);
                _locationCache[locationName] = locId;
                log.debug("LOCATION_FOUND", locationName + " → ID " + locId);
                return locId;
            } else {
                log.audit("LOCATION_NOT_FOUND", "No active location named: " + locationName);
                return null;
            }
        } catch (e) {
            log.error("LOCATION_SEARCH_ERR", e.message);
            return null;
        }
    }

    function resolveLocationId(payload) {
        var fulfillmentChannel = (payload.fulfillment_channel || "").toUpperCase();
        var storeType = (payload.store_type || "").toLowerCase();
        var shipState = payload.shipping_address && payload.shipping_address.state
            ? payload.shipping_address.state.toUpperCase() : null;

        var locationId = null;

        // Rule 1: AFN → Amazon FBA
        if (fulfillmentChannel === "AFN") {
            locationId = findLocationId("Amazon FBA");
        }
        // Rule 2: MFN – route by state
        else if (fulfillmentChannel === "MFN") {
            if (shipState) {
                var westStates = ["CA", "OR", "WA", "AZ", "NV", "UT", "CO"];
                if (westStates.indexOf(shipState) !== -1) {
                    locationId = findLocationId("California - Chatsworth");
                } else {
                    var centralStates = ["TX", "OK", "KS", "NE", "IA", "MO", "AR", "LA"];
                    if (centralStates.indexOf(shipState) !== -1) {
                        locationId = findLocationId("Ware2Go - TX (Dallas)");
                    } else {
                        var eastStates = ["NY", "NJ", "PA", "DE", "MD", "VA", "NC", "SC", "GA", "FL", "CT", "MA", "VT", "NH", "ME", "RI"];
                        if (eastStates.indexOf(shipState) !== -1) {
                            locationId = findLocationId("Ware2Go - PA (Fairless Hills)");
                        }
                    }
                }
            }
            // Default MFN location if state not matched or no state
            if (!locationId) {
                locationId = findLocationId("California - Chatsworth");
            }
        }
        // Rule 3: No fulfillment_channel – use store_type as hint
        else {
            if (storeType === "shopify") {
                // For Shopify, no location 
                locationId = null;
            } else if (storeType === "amazon") {
                locationId = findLocationId("Amazon FBA");
            } else if (storeType === "walmart" || storeType === "newegg" || storeType === "newegg_business" || storeType === "ebay") {
                locationId = findLocationId("California - Chatsworth");
            }
        }

        // No fallback — if still null, return null and let the caller decide
        if (!locationId) {
            log.audit("LOCATION_UNRESOLVED", "No matching location found for payload. Location will be left empty.");
        }

        return locationId;
    }

    // ========== OTHER HELPERS ==========
    function findCustomer(companyName) {
        if (_customerCache[companyName]) return _customerCache[companyName];
        var col1 = search.createColumn({ name: "internalid" });
        var col2 = search.createColumn({ name: "subsidiary" });
        var results = search.create({
            type: search.Type.CUSTOMER,
            filters: [["companyname", "is", companyName]],
            columns: [col1, col2]
        }).run().getRange({ start: 0, end: 1 });
        if (results.length === 0) return null;
        var info = {
            id: parseInt(results[0].getValue(col1), 10),
            subsidiary: results[0].getValue(col2),
            subsidiaryText: results[0].getText(col2) || ""
        };
        _customerCache[companyName] = info;
        return info;
    }

    function findLeadSource(soRecord, name) {
        if (_channelCache[name]) return _channelCache[name];
        var FIELD_ID = "csegecomm_channel";
        var recordId = null;
        var childPart = name.split(" : ").pop();
        try {
            var field = soRecord.getField({ fieldId: FIELD_ID });
            if (field) {
                var options = field.getSelectOptions();
                for (var oi = 0; oi < options.length; oi++) {
                    var optText = options[oi].text;
                    var optVal = options[oi].value;
                    if (optText === name || optText === childPart || (optText && optText.indexOf(childPart) >= 0)) {
                        recordId = String(optVal);
                        break;
                    }
                }
            }
        } catch (e) { /* ignore */ }
        if (!recordId) {
            for (var rid = 1; rid <= 20; rid++) {
                try {
                    var rec = record.load({ type: "customrecord_csegecomm_channel", id: rid });
                    var recName = rec.getValue({ fieldId: "name" });
                    if (recName === name || recName === childPart || (recName && recName.indexOf(childPart) >= 0)) {
                        recordId = String(rid);
                        break;
                    }
                } catch (e2) { /* ignore */ }
            }
        }
        if (!recordId) return { id: null, fieldId: null };
        var result = { id: recordId, fieldId: FIELD_ID };
        _channelCache[name] = result;
        return result;
    }

    function findFormId(formName) {
        if (_formCache[formName]) return _formCache[formName];
        try {
            var formCol = search.createColumn({ name: "customform" });
            var soResults = search.create({
                type: search.Type.SALES_ORDER,
                filters: [["mainline", "is", "T"]],
                columns: [formCol]
            }).run().getRange({ start: 0, end: 50 });
            for (var i = 0; i < soResults.length; i++) {
                var fId = soResults[i].getValue(formCol);
                var fName = soResults[i].getText(formCol);
                if (fName && fName.indexOf(formName) >= 0) {
                    _formCache[formName] = fId;
                    return fId;
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function findSalesOrder(otherrefnum) {
        var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var refCol = search.createColumn({ name: "otherrefnum" });
        var tranCol = search.createColumn({ name: "tranid" });
        var results = search.create({
            type: search.Type.SALES_ORDER,
            filters: [["poastext", "is", otherrefnum], "AND", ["mainline", "is", "T"]],
            columns: [idCol, refCol, tranCol]
        }).run().getRange({ start: 0, end: 10 });
        if (results.length === 0) return null;
        var found = parseInt(results[0].getValue(idCol), 10);
        var soNum = results[0].getValue(tranCol);
        return { id: found, soNumber: soNum };
    }

    /** Resolve Amazon SKU → active item row: Item Name/Number, then Vendor Name/Code, then Display Name (exact). */
    function findActiveItemBySku(sku) {
        var cols = ["internalid", "type", "isinactive", "itemid", "displayname"];
        function run(fieldId) {
            return search.create({
                type: search.Type.ITEM,
                filters: [
                    ["isinactive", "is", "F"],
                    "AND",
                    [fieldId, "is", sku]
                ],
                columns: cols
            }).run().getRange({ start: 0, end: 5 });
        }
        try {
            var r1 = run("itemid");
            if (r1 && r1.length) return r1;
        } catch (e1) { log.debug("ITEM_SEARCH_itemid", sku + " — " + e1.message); }
        try {
            var r2 = run("vendornamecode");
            if (r2 && r2.length) return r2;
        } catch (e2) { log.debug("ITEM_SEARCH_vendornamecode", sku + " — " + e2.message); }
        try {
            var r3 = run("displayname");
            if (r3 && r3.length) return r3;
        } catch (e3) { log.debug("ITEM_SEARCH_displayname", sku + " — " + e3.message); }
        return [];
    }

    function snapshotSO(soRecord) {
        var snap = { header: {}, lines: [] };
        var headerFields = ["customform", "entity", "subsidiary", "otherrefnum", "trandate", "shipdate", "orderstatus", "memo", "currency", "custbody1", "custbody3", "csegecomm_channel"];
        for (var hi = 0; hi < headerFields.length; hi++) {
            try { snap.header[headerFields[hi]] = soRecord.getValue({ fieldId: headerFields[hi] }); } catch (e) { /* ignore */ }
        }
        try {
            var addrRec = soRecord.getSubrecord({ fieldId: "shippingaddress" });
            snap.header.shippingAddress = {
                addressee: addrRec.getValue({ fieldId: "addressee" }) || "",
                attention: addrRec.getValue({ fieldId: "attention" }) || "",
                addr1: addrRec.getValue({ fieldId: "addr1" }) || "",
                addr2: addrRec.getValue({ fieldId: "addr2" }) || "",
                city: addrRec.getValue({ fieldId: "city" }) || "",
                state: addrRec.getValue({ fieldId: "state" }) || "",
                zip: addrRec.getValue({ fieldId: "zip" }) || "",
                country: addrRec.getValue({ fieldId: "country" }) || ""
            };
        } catch (e) { snap.header.shippingAddress = null; }
        var lineCount = soRecord.getLineCount({ sublistId: "item" });
        snap.header.lineCount = lineCount;
        var lineFields = ["item", "quantity", "rate", "amount", "location", "price", "description"];
        for (var li = 0; li < lineCount; li++) {
            var line = { line: li };
            for (var lf = 0; lf < lineFields.length; lf++) {
                try { line[lineFields[lf]] = soRecord.getSublistValue({ sublistId: "item", fieldId: lineFields[lf], line: li }); } catch (e2) { /* ignore */ }
            }
            snap.lines.push(line);
        }
        return snap;
    }

    function diffSnapshots(before, after) {
        if (!before || !after) return null;
        var diff = { header: {}, lines: {} };
        var allKeys = Object.keys(before.header).concat(Object.keys(after.header));
        var seen = {};
        for (var ki = 0; ki < allKeys.length; ki++) {
            var k = allKeys[ki];
            if (seen[k]) continue;
            seen[k] = true;
            var bVal = before.header[k];
            var aVal = after.header[k];
            if (String(bVal) !== String(aVal)) diff.header[k] = { from: bVal, to: aVal };
        }
        if (before.lines.length !== after.lines.length) diff.lines.countChange = { from: before.lines.length, to: after.lines.length };
        diff.lines.before = before.lines;
        diff.lines.after = after.lines;
        return diff;
    }

    // ========== MAIN POST HANDLER ==========
    function post(payload) {
        var so;
        var before = null;
        var existingId = null;
        var existingSoNum = null;

        try {
            log.debug("PAYLOAD", JSON.stringify(payload));
            var action = payload.action || "skip";
            var otherrefnum = payload.otherrefnum;
            var trandate = payload.trandate;
            var store_type = (payload.store_type || "amazon").toLowerCase();
            var order_status = payload.order_status || "";
            var fulfillment_channel = payload.fulfillment_channel || "";
            var ship_date = payload.ship_date;
            var items = payload.items;
            var shipping = payload.shipping_address || null;

            if (!otherrefnum) return { success: false, error: "Missing otherrefnum" };

            var existingMatch = findSalesOrder(otherrefnum);
            existingId = existingMatch ? existingMatch.id : null;
            existingSoNum = existingMatch ? existingMatch.soNumber : null;

            if (existingId && action === "skip") {
                return { success: true, action: "skipped", otherrefnum: otherrefnum, existingId: existingId, soNumber: existingSoNum };
            }

            var customerName = CUSTOMER_MAP[store_type];
            if (!customerName) return { success: false, error: "Unknown store_type: " + store_type };
            var customerInfo = findCustomer(customerName);
            if (!customerInfo) return { success: false, error: "Customer '" + customerName + "' not found" };

            var formId = findFormId(FORM_NAME);
            log.debug("FORM", FORM_NAME + " → ID " + formId);

            // ----- ITEM MAPPING (pre‑validation) -----
            var mappedItems = [];
            var skippedSkus = [];
            if (Array.isArray(items)) {
                for (var i = 0; i < items.length; i++) {
                    var lineItem = items[i];
                    var sku = lineItem.item ? String(lineItem.item).trim() : "";
                    if (!sku) { skippedSkus.push("(empty)"); continue; }
                    try {
                        var itemResults = findActiveItemBySku(sku);
                        if (!itemResults.length) { skippedSkus.push(sku + " (not_found)"); continue; }
                        if (itemResults[0].getValue("isinactive") === true || itemResults[0].getValue("isinactive") === "T") { skippedSkus.push(sku + " (inactive)"); continue; }
                        var itemType = itemResults[0].getText("type") || itemResults[0].getValue("type");
                        if (SKIP_ITEM_TYPES.indexOf(itemType) >= 0) { skippedSkus.push(sku + " (type:" + itemType + ")"); continue; }
                        var itemInternalId = parseInt(itemResults[0].getValue("internalid"), 10);
                        var qty = parseInt(lineItem.quantity, 10) || 1;
                        var amt = parseFloat(lineItem.amount) || 0;
                        var rate = qty > 0 ? (amt / qty) : amt;
                        log.debug("ITEM_MATCH", "Input=\"" + sku + "\" → NS itemid=\"" + itemResults[0].getValue("itemid") + "\" displayname=\"" + itemResults[0].getValue("displayname") + "\" internalid=" + itemInternalId);
                        mappedItems.push({ sku: sku, internalId: itemInternalId, qty: qty, amt: amt, rate: rate });
                    } catch (err) { skippedSkus.push(sku + " (error:" + err.message + ")"); }
                }
            }

            var skuList = Array.isArray(items) ? items.map(function (x) { return (x && x.item) || "unknown"; }).join(", ") : "none";
            log.audit("ITEM_MAPPING", "Mapped: " + mappedItems.length + " | Skipped: " + skippedSkus.join(", "));

            // ----- STRICT SKU CHECK (Fail if ANY item is missing) -----
            if (skippedSkus.length > 0) {
                return { 
                    success: false, 
                    error: "Strict SKU match failed. SKUs not found or inactive in NetSuite: " + skippedSkus.join(", ")
                };
            }

            // ----- HEADER‑ONLY UPDATE (no valid SKUs) -----
            if (mappedItems.length === 0) {
                if (existingId) {
                    var fieldValues = {};
                    if (trandate) { var pd = new Date(trandate); if (!isNaN(pd.getTime())) fieldValues.trandate = pd; }
                    if (ship_date) { var psd = new Date(ship_date); if (!isNaN(psd.getTime())) fieldValues.shipdate = psd; }
                    if (order_status) fieldValues.custbody1 = String(order_status);
                    if (fulfillment_channel) fieldValues.custbody3 = String(fulfillment_channel);
                    record.submitFields({ type: record.Type.SALES_ORDER, id: existingId, values: fieldValues, options: { enableSourcing: false, ignoreMandatoryFields: true } });
                    return { success: true, action: "header_updated", otherrefnum: otherrefnum, internalId: existingId, soNumber: existingSoNum, skus_attempted: skuList, skipped: skippedSkus };
                } else {
                    return { success: true, action: "no_items", otherrefnum: otherrefnum, skus_attempted: skuList, skipped: skippedSkus };
                }
            }

            // ----- AT LEAST ONE VALID ITEM – LOAD/CREATE SO -----
            if (existingId && action === "update") {
                // Use isDynamic: true for consistency with line manipulation methods
                so = record.load({ type: record.Type.SALES_ORDER, id: existingId, isDynamic: true });
            } else {
                so = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
            }

            before = snapshotSO(so);

            if (formId) so.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
            so.setValue({ fieldId: "entity", value: customerInfo.id });
            // Required for item/subsidiary validation — without this NS often rejects lines on save.
            if (customerInfo.subsidiary) {
                try {
                    var subInt = parseInt(customerInfo.subsidiary, 10);
                    if (!isNaN(subInt)) so.setValue({ fieldId: "subsidiary", value: subInt });
                } catch (subEx) { log.debug("SUBSIDIARY_SKIP", subEx.message); }
            }

            var channelName = CHANNEL_MAP[store_type];
            var channelResult = channelName ? findLeadSource(so, channelName) : { id: null, fieldId: null };
            if (channelResult.id && channelResult.fieldId) {
                try { so.setValue({ fieldId: channelResult.fieldId, value: parseInt(channelResult.id, 10) }); } catch (e) { /* ignore */ }
            }

            so.setValue({ fieldId: "otherrefnum", value: String(otherrefnum) });
            if (trandate) { var pd2 = new Date(trandate); if (!isNaN(pd2.getTime())) so.setValue({ fieldId: "trandate", value: pd2 }); }
            if (ship_date) { var psd2 = new Date(ship_date); if (!isNaN(psd2.getTime())) so.setValue({ fieldId: "shipdate", value: psd2 }); }
            try { so.setValue({ fieldId: "custbody1", value: String(order_status) }); } catch (e) { /* ignore */ }
            try { so.setValue({ fieldId: "custbody3", value: String(fulfillment_channel) }); } catch (e2) { /* ignore */ }

            if (shipping && (shipping.addr1 || shipping.city || shipping.state || shipping.zip)) {
                try {
                    var addr = so.getSubrecord({ fieldId: "shippingaddress" });
                    if (shipping.country) addr.setValue({ fieldId: "country", value: shipping.country });
                    if (shipping.addressee) addr.setValue({ fieldId: "addressee", value: shipping.addressee });
                    if (shipping.company) addr.setValue({ fieldId: "attention", value: shipping.company });
                    if (shipping.addr1) addr.setValue({ fieldId: "addr1", value: shipping.addr1 });
                    if (shipping.addr2) addr.setValue({ fieldId: "addr2", value: shipping.addr2 });
                    if (shipping.city) addr.setValue({ fieldId: "city", value: shipping.city });
                    if (shipping.state) addr.setValue({ fieldId: "state", value: shipping.state });
                    if (shipping.zip) addr.setValue({ fieldId: "zip", value: shipping.zip });
                } catch (e3) { log.error("SHIPPING_ADDR_ERR", e3.message); }
            }

            // Location is optional — if unresolved, fields are simply left empty
            var locationId = null;
            log.debug("LOCATION_FINAL", locationId ? "Using location ID: " + locationId : "No location resolved — leaving empty");
            if (locationId) {
                try { so.setValue({ fieldId: "location", value: locationId }); } catch (locHead) { /* form may omit header location */ }
            }

            // ----- LINE ITEMS CLEANUP -----
            // Remove only lines that have NOT been fulfilled or committed.
            // Keeping "needsInventoryDetail" lines was causing duplication; we now allow removal 
            // if no fulfillment/commitment exists.
            var preClear = so.getLineCount({ sublistId: "item" });
            log.debug("CLEANUP", "Starting cleanup of " + preClear + " existing lines");
            
            for (var rm = preClear - 1; rm >= 0; rm--) {
                try {
                    var lineShipped = parseFloat(so.getSublistValue({ sublistId: "item", fieldId: "quantityfulfilled", line: rm })) || 0;
                    var lineCommitted = parseFloat(so.getSublistValue({ sublistId: "item", fieldId: "quantitycommitted", line: rm })) || 0;

                    if (lineShipped > 0 || lineCommitted > 0) {
                        log.audit("LINE_SKIP_REMOVE", "Line " + rm + " kept (Shipped: " + lineShipped + ", Committed: " + lineCommitted + ")");
                        continue;
                    }
                    
                    so.removeLine({ sublistId: "item", line: rm });
                } catch (rmErr) {
                    log.error("LINE_REMOVE_ERR", "Line " + rm + ": " + rmErr.message);
                }
            }

            // ----- ADD / UPDATE MAPPED LINES -----
            for (var mi = 0; mi < mappedItems.length; mi++) {
                var mapped = mappedItems[mi];
                try {
                    // Check if the item already exists on a line we had to keep (fulfilled/committed)
                    var existingLine = so.findSublistLineWithValue({
                        sublistId: "item",
                        fieldId: "item",
                        value: mapped.internalId
                    });

                    if (existingLine >= 0) {
                        log.audit("LINE_UPDATE", "SKU " + mapped.sku + " found on existing line " + existingLine + " — updating");
                        so.selectLine({ sublistId: "item", line: existingLine });
                    } else {
                        log.debug("LINE_ADD", "Adding new line for SKU " + mapped.sku);
                        so.selectNewLine({ sublistId: "item" });
                    }

                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: mapped.internalId });

                    // Clear createpo — prevent auto-PO for dropship-flagged items.
                    try {
                        var autoCreatePO = so.getCurrentSublistValue({ sublistId: "item", fieldId: "createpo" });
                        if (autoCreatePO) {
                            so.setCurrentSublistValue({ sublistId: "item", fieldId: "createpo", value: "", ignoreFieldChange: false });
                        }
                    } catch (cpErr) { /* ignore */ }

                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: mapped.qty });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: mapped.rate });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: mapped.amt });
                    
                    if (locationId) {
                        so.setCurrentSublistValue({ sublistId: "item", fieldId: "location", value: locationId });
                    }
                    
                    so.commitLine({ sublistId: "item" });
                } catch (lineErr) {
                    log.error("LINE_SYNC_ERR", "SKU " + mapped.sku + ": " + lineErr.message);
                    skippedSkus.push(mapped.sku + " (sync_error)");
                }
            }

            if (so.getLineCount({ sublistId: "item" }) === 0) {
                throw new Error("Failed to add any valid line items. Check item vs subsidiary, location, and required fields.");
            }

            var after = snapshotSO(so);
            var diff = diffSnapshots(before, after);
            // enableSourcing: true forces NetSuite to recalculate the header total from
            // the line amounts — critical fix for zero-total SOs on update.
            var savedId = so.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.audit("SUCCESS", "Order " + otherrefnum + " saved → ID: " + savedId);

            return {
                success: true,
                action: existingId ? "updated" : "created",
                otherrefnum: otherrefnum,
                internalId: savedId,
                before: before,
                after: after,
                diff: diff
            };
        } catch (e) {
            log.error("FATAL", e.name + ": " + e.message);
            return {
                success: false,
                error: e.message,
                otherrefnum: payload && payload.otherrefnum ? payload.otherrefnum : null,
                existingId: existingId,
                soNumber: existingSoNum
            };
        }
    }

    return { post: post };
});