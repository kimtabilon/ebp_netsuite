// /**
//  * NETSUITE RESTLET — Sales Order Sync
//  *
//  * HOW TO DEPLOY IN NETSUITE:
//  * 1. Go to: Customization → Scripting → Scripts → New
//  * 2. Script Type: RESTlet
//  * 3. Name: EBP Sales Order Sync
//  * 4. Script ID: customscript_ebp_sales_order_sync
//  * 5. Upload this file
//  * 6. Set POST Function to: post
//  * 7. Save → Deploy
//  * 8. Deployment ID: customdeploy_ebp_sales_order_sync
//  * 9. Status: Released
//  * 10. Update .env:
//  *     RESTLET_SCRIPT_ID=customscript_ebp_sales_order_sync
//  *     RESTLET_DEPLOY_ID=customdeploy_ebp_sales_order_sync
//  *
//  * NOTE: This account uses SuiteTax (Advanced Tax). SuiteTax requires DYNAMIC
//  * mode for transaction records because the tax engine relies on field change
//  * events that only fire in dynamic mode (setCurrentSublistValue).
//  * Standard mode (setSublistValue) does NOT trigger these events, causing
//  * VALID_LINE_ITEM_REQD errors even when all visible fields are set.
//  *
//  * PAYLOAD EXPECTED:
//  * {
//  *   action:              "skip" | "update",
//  *   otherrefnum:         "113-1234567-1234567",
//  *   trandate:            "2026-01-15T00:00:00Z",
//  *   store_type:          "amazon" | "walmart" | "newegg" | "ebay",
//  *   order_status:        "Unshipped" | "Shipped" | ...,
//  *   fulfillment_channel: "MFN" | "AFN",
//  *   ship_date:           "2026-01-16T00:00:00Z" | null,
//  *   items:               [{ item: "SKU001", quantity: 2, amount: 49.99 }],
//  *   po:                  [{ po_number: 10001, po_vendor: 117, order_items: [...] }]
//  * }
//  */

// /**
//  * @NApiVersion 2.1
//  * @NScriptType Restlet
//  */
// define(["N/record", "N/search", "N/log"], function (record, search, log) {

//     // ── Lookup maps: store_type → names (dynamic ID resolution at runtime) ──
//     var CUSTOMER_MAP = {
//         "amazon": "Amazon",
//         "walmart": "Walmart",
//         "newegg": "NewEgg",
//         "newegg_business": "NewEgg Business",
//         "ebay": "eBay",
//         "shopify": "Shopify"
//     };

//     var CHANNEL_MAP = {
//         "amazon": "3rd Party Marketplace : Amazon",
//         "walmart": "3rd Party Marketplace : Walmart",
//         "newegg": "3rd Party Marketplace : NewEgg",
//         "ebay": "3rd Party Marketplace : eBay",
//         "shopify": "3rd Party Marketplace : Shopify"
//     };

//     var FORM_NAME = "Ecomm BP - Sales Order";

//     // ── Caches (per RESTlet invocation) ─────────────────────────────────────
//     var _customerCache = {};
//     var _channelCache = {};
//     var _formCache = {};

//     // ═══════════════════════════════════════════════════════════════════════════
//     // MAIN
//     // ═══════════════════════════════════════════════════════════════════════════
//     function post(payload) {
//         var so;
//         try {
//             log.debug("PAYLOAD", JSON.stringify(payload));

//             var action = payload.action || "skip";
//             var otherrefnum = payload.otherrefnum;
//             var trandate = payload.trandate;
//             var store_type = (payload.store_type || "amazon").toLowerCase();
//             var order_status = payload.order_status || "";
//             var fulfillment_channel = payload.fulfillment_channel || "";
//             var ship_date = payload.ship_date;
//             var items = payload.items;

//             if (!otherrefnum) {
//                 return { success: false, error: "Missing otherrefnum" };
//             }

//             // ── Check if Sales Order already exists ─────────────────────────
//             var existingMatch = findSalesOrder(otherrefnum);
//             var existingId = existingMatch ? existingMatch.id : null;
//             var existingSoNum = existingMatch ? existingMatch.soNumber : null;

//             if (existingId && action === "skip") {
//                 log.debug("SKIP", "Order " + otherrefnum + " already exists as " + existingSoNum + ". Skipping.");
//                 return { success: true, action: "skipped", otherrefnum: otherrefnum, existingId: existingId, soNumber: existingSoNum };
//             }

//             // ── Resolve Customer (dynamic from store_type) ──────────────────
//             var customerName = CUSTOMER_MAP[store_type];
//             if (!customerName) {
//                 return { success: false, error: "Unknown store_type: " + store_type + ". Add to CUSTOMER_MAP." };
//             }

//             var customerInfo = findCustomer(customerName);
//             if (!customerInfo) {
//                 return { success: false, error: "Customer '" + customerName + "' not found in NetSuite. Create it first." };
//             }
//             log.debug("CUSTOMER", JSON.stringify(customerInfo));

//             // ── Resolve Form (dynamic by name) ──────────────────────────────
//             var formId = findFormId(FORM_NAME);
//             log.debug("FORM", "'" + FORM_NAME + "' → ID " + formId);

//             // ── Build record (DYNAMIC mode — required for SuiteTax) ─────────
//             // SuiteTax needs field change events to process tax on line items.
//             // These events only fire in dynamic mode (setCurrentSublistValue).
//             if (existingId && action === "update") {
//                 so = record.load({ type: record.Type.SALES_ORDER, id: existingId, isDynamic: true });
//             } else {
//                 so = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
//             }

//             // ── Snapshot BEFORE any changes ──────────────────────────────
//             var before = snapshotSO(so);
//             log.debug("SNAPSHOT_BEFORE", JSON.stringify(before));

//             // Set Form FIRST (controls which fields/sublists are available)
//             if (formId) {
//                 so.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
//             }

//             // Entity (Customer) — auto-sets subsidiary in dynamic mode
//             so.setValue({ fieldId: "entity", value: customerInfo.id });

//             var soSubsidiary = so.getValue({ fieldId: "subsidiary" });
//             var soCurrency = "";
//             try { soCurrency = so.getValue({ fieldId: "currency" }); } catch (e) { }
//             var soOrderStatus = "";
//             try { soOrderStatus = so.getValue({ fieldId: "orderstatus" }); } catch (e) { }
//             log.debug("ENTITY_SET", JSON.stringify({
//                 entity: customerInfo.id,
//                 subsidiary: soSubsidiary,
//                 currency: soCurrency,
//                 orderstatus: soOrderStatus,
//                 form: so.getValue({ fieldId: "customform" }),
//                 isDynamic: true,
//                 recordMode: existingId ? "update" : "create"
//             }));

//             // ── Channels/Lead Source (Custom Segment: csegecomm_channel) ───
//             var channelName = CHANNEL_MAP[store_type];
//             var channelResult = channelName ? findLeadSource(so, channelName) : { id: null, fieldId: null };
//             log.debug("CHANNEL", JSON.stringify({ name: channelName, id: channelResult.id, fieldId: channelResult.fieldId }));

//             if (channelResult.id && channelResult.fieldId) {
//                 try {
//                     so.setValue({ fieldId: channelResult.fieldId, value: parseInt(channelResult.id, 10) });
//                     log.debug("CHANNEL_SET", "Set " + channelResult.fieldId + " = " + channelResult.id);
//                 } catch (e) {
//                     log.error("CHANNEL_SET_ERR", e.message);
//                 }
//             }

//             // ── Standard fields ─────────────────────────────────────────────
//             so.setValue({ fieldId: "otherrefnum", value: String(otherrefnum) });

//             if (trandate) {
//                 var parsedDate = new Date(trandate);
//                 if (!isNaN(parsedDate.getTime())) {
//                     so.setValue({ fieldId: "trandate", value: parsedDate });
//                 }
//             }

//             if (ship_date) {
//                 var parsedShipDate = new Date(ship_date);
//                 if (!isNaN(parsedShipDate.getTime())) {
//                     so.setValue({ fieldId: "shipdate", value: parsedShipDate });
//                 }
//             }

//             // Custom fields
//             try { so.setValue({ fieldId: "custbody1", value: String(order_status) }); } catch (e) { }
//             try { so.setValue({ fieldId: "custbody3", value: String(fulfillment_channel) }); } catch (e) { }

//             // ── Shipping Address (shippingaddress subrecord) ─────────────
//             var shipping = payload.shipping_address;
//             if (shipping && (shipping.addr1 || shipping.city || shipping.state || shipping.zip)) {
//                 try {
//                     var addrSubrecord = so.getSubrecord({ fieldId: "shippingaddress" });

//                     // Country FIRST — controls state/zip validation in NetSuite
//                     if (shipping.country) {
//                         addrSubrecord.setValue({ fieldId: "country", value: shipping.country });
//                     }
//                     if (shipping.addressee) {
//                         addrSubrecord.setValue({ fieldId: "addressee", value: shipping.addressee });
//                     }
//                     if (shipping.company) {
//                         addrSubrecord.setValue({ fieldId: "attention", value: shipping.company });
//                     }
//                     if (shipping.addr1) {
//                         addrSubrecord.setValue({ fieldId: "addr1", value: shipping.addr1 });
//                     }
//                     if (shipping.addr2) {
//                         addrSubrecord.setValue({ fieldId: "addr2", value: shipping.addr2 });
//                     }
//                     if (shipping.city) {
//                         addrSubrecord.setValue({ fieldId: "city", value: shipping.city });
//                     }
//                     if (shipping.state) {
//                         addrSubrecord.setValue({ fieldId: "state", value: shipping.state });
//                     }
//                     if (shipping.zip) {
//                         addrSubrecord.setValue({ fieldId: "zip", value: shipping.zip });
//                     }

//                     log.debug("SHIPPING_ADDR_SET", JSON.stringify(shipping));
//                 } catch (addrErr) {
//                     // Non-fatal: don't fail the entire SO for an address error
//                     log.error("SHIPPING_ADDR_ERR", addrErr.message);
//                 }
//             }

//             // Memo — intentionally not set (leave blank)

//             // ── Track existing lines (will be removed AFTER new lines are added) ─
//             // NetSuite requires at least one valid line on a loaded record at all
//             // times. So we add new lines first, then remove the old ones.
//             var oldLineCount = so.getLineCount({ sublistId: "item" });
//             log.debug("PRE_LINES", "Existing lines to replace: " + oldLineCount);

//             // ── Line items (DYNAMIC mode) ─────────────────────────────────────
//             var linesAdded = 0;
//             var skippedSkus = [];
//             var SKIP_ITEM_TYPES = ["Group"];

//             log.debug("ITEMS_INPUT", {
//                 count: Array.isArray(items) ? items.length : 0,
//                 raw: Array.isArray(items) ? items.slice(0, 5) : items
//             });

//             if (Array.isArray(items) && items.length > 0) {
//                 for (var i = 0; i < items.length; i++) {
//                     var lineItem = items[i];
//                     var sku = lineItem.item;

//                     if (!sku) {
//                         log.debug("ITEM_SKIP_EMPTY", "Line " + i + " has no SKU");
//                         skippedSkus.push("empty");
//                         continue;
//                     }

//                     try {
//                         log.debug("ITEM_PROCESSING_" + i, "SKU: " + sku);

//                         // Item search
//                         var itemResults = search.create({
//                             type: search.Type.ITEM,
//                             filters: [
//                                 ["isinactive", "is", "F"],                    // only active items
//                                 "AND",
//                                 [
//                                     ["itemid", "is", sku],                    // exact item ID / SKU
//                                     "OR",
//                                     ["displayname", "is", sku],               // exact display name
//                                     "OR",
//                                     ["displayname", "contains", sku]          // fallback
//                                 ]
//                             ],
//                             columns: [
//                                 search.createColumn({ name: "internalid" }),
//                                 search.createColumn({ name: "type" })
//                             ]
//                         }).run().getRange({ start: 0, end: 5 });

//                         if (!itemResults || itemResults.length === 0) {
//                             log.debug("ITEM_NOT_FOUND", "SKU \"" + sku + "\" not found in NetSuite");
//                             skippedSkus.push(sku);
//                             continue;
//                         }

//                         var itemInternalId = parseInt(itemResults[0].getValue("internalid"), 10);
//                         var itemType = itemResults[0].getText("type") || itemResults[0].getValue("type");

//                         if (SKIP_ITEM_TYPES.indexOf(itemType) >= 0) {
//                             skippedSkus.push(sku + " (type:" + itemType + ")");
//                             continue;
//                         }

//                         var qty = parseInt(lineItem.quantity, 10) || 1;
//                         var amt = parseFloat(lineItem.amount) || 0;
//                         var rate = qty > 0 ? (amt / qty) : amt;

//                         // Add the line
//                         so.selectNewLine({ sublistId: "item" });
//                         so.setCurrentSublistValue({ sublistId: "item", fieldId: "item", value: itemInternalId });

//                         // Clear location & createpo (your existing logic — keep it)
//                         // ... (keep your location and createpo clearing code here)

//                         so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: qty });
//                         so.setCurrentSublistValue({ sublistId: "item", fieldId: "price", value: -1 });
//                         so.setCurrentSublistValue({ sublistId: "item", fieldId: "rate", value: rate });
//                         so.setCurrentSublistValue({ sublistId: "item", fieldId: "amount", value: amt });

//                         so.commitLine({ sublistId: "item" });

//                         linesAdded++;
//                         log.debug("LINE_ADDED", { sku: sku, internalId: itemInternalId, line: linesAdded });

//                     } catch (lineErr) {
//                         log.error("ITEM_ERROR", "SKU \"" + sku + "\" — " + lineErr.name + ": " + lineErr.message);
//                         skippedSkus.push(sku);
//                     }
//                 }
//             }

//             // ── Check AFTER the entire loop ─────────────────────────────────────
//             if (linesAdded === 0) {
//                 var skuList = Array.isArray(items)
//                     ? items.map(x => (x && x.item) || "unknown").join(", ")
//                     : "none";

//                 log.audit("NO_VALID_ITEMS_ON_UPDATE",
//                     "Order " + otherrefnum + " - No items could be mapped. " +
//                     "SKUs attempted: " + skuList + " | Skipped: " + skippedSkus.join(", ")
//                 );

//                 // IMPORTANT SAFETY: Do NOT remove any old lines if we added zero new lines
//                 // This prevents destroying the existing Sales Order
//                 return {
//                     success: true,
//                     action: "no_items",
//                     otherrefnum: otherrefnum,
//                     skus_attempted: skuList,
//                     skipped: skippedSkus,
//                     message: "No valid items mapped - keeping existing lines (update protected)",
//                     before: before,
//                     after: snapshotSO(so),
//                     diff: diffSnapshots(before, snapshotSO(so))
//                 };
//             }

//             // ── Safe removal of old lines ───────────────────────────────────────sear
//             log.debug("LINES_READY", linesAdded + " new lines added, " + skippedSkus.length + " skipped");

//             if (oldLineCount > 0) {
//                 if (linesAdded > 0) {
//                     log.debug("REMOVING_OLD_LINES", "Safe removal of " + oldLineCount + " old lines");
//                     for (var r = oldLineCount - 1; r >= 0; r--) {
//                         so.removeLine({ sublistId: "item", line: r });
//                     }
//                     log.debug("OLD_LINES_REMOVED", "Now has " + so.getLineCount({ sublistId: "item" }) + " lines");
//                 } else {
//                     log.debug("KEEPING_EXISTING_LINES", "No new lines added - keeping original " + oldLineCount + " lines");
//                 }
//             }

//             // ── Snapshot AFTER all changes (before save) ─────────────────────────────
//             var after = snapshotSO(so);
//             log.debug("SNAPSHOT_AFTER", JSON.stringify(after));

//             // ── Diff: what actually changed ──────────────────────────────────────────
//             var diff = diffSnapshots(before, after);
//             log.debug("SNAPSHOT_DIFF", JSON.stringify(diff));

//             // ── Save (ONE time only) ─────────────────────────────────────────────────
//             log.audit("SAVING", "Attempting save for " + otherrefnum + " with " + linesAdded + " lines...");
//             var savedId;
//             try {
//                 savedId = so.save({ enableSourcing: true, ignoreMandatoryFields: false });
//             } catch (saveErr) {
//                 log.error("SAVE_FAILED", JSON.stringify({
//                     name: saveErr.name,
//                     message: saveErr.message,
//                     otherrefnum: otherrefnum,
//                     linesAdded: linesAdded,
//                     skippedSkus: skippedSkus
//                 }));
//                 throw saveErr;
//             }
//             log.audit("SUCCESS", "Order " + otherrefnum + " saved → ID: " + savedId);

//             return {
//                 success: true,
//                 action: existingId ? "updated" : "created",
//                 otherrefnum: otherrefnum,
//                 internalId: savedId,
//                 before: before,
//                 after: after,
//                 diff: diff
//             };

//         } catch (e) {
//             try {
//                 if (so) {
//                     var errLineCount = so.getLineCount({ sublistId: "item" });
//                     for (var el = 0; el < errLineCount; el++) {
//                         var errLine = {};
//                         ["item", "quantity", "rate", "amount", "location", "price"].forEach(function (f) {
//                             try { errLine[f] = so.getSublistValue({ sublistId: "item", fieldId: f, line: el }); } catch (x) { }
//                         });
//                         log.error("FAIL_LINE_" + el, JSON.stringify(errLine));
//                     }
//                 }
//             } catch (dumpErr) { }

//             // Capture after-snapshot even on failure (shows what was attempted)
//             var failAfter = null;
//             var failDiff = null;
//             try {
//                 if (so) {
//                     failAfter = snapshotSO(so);
//                     failDiff = diffSnapshots(before, failAfter);
//                 }
//             } catch (snapErr) { }

//             log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
//             return {
//                 success: false, error: e.message, otherrefnum: otherrefnum,
//                 existingId: existingId || null, soNumber: existingSoNum || null,
//                 before: before || null,
//                 after: failAfter,
//                 diff: failDiff
//             };
//         }
//     }

//     // ═══════════════════════════════════════════════════════════════════════════
//     // HELPERS
//     // ═══════════════════════════════════════════════════════════════════════════

//     function findCustomer(companyName) {
//         if (_customerCache[companyName]) return _customerCache[companyName];

//         var col1 = search.createColumn({ name: "internalid" });
//         var col2 = search.createColumn({ name: "subsidiary" });
//         var results = search.create({
//             type: search.Type.CUSTOMER,
//             filters: [["companyname", "is", companyName]],
//             columns: [col1, col2]
//         }).run().getRange({ start: 0, end: 1 });

//         if (results.length === 0) return null;

//         var info = {
//             id: parseInt(results[0].getValue(col1), 10),
//             subsidiary: results[0].getValue(col2),
//             subsidiaryText: results[0].getText(col2) || ""
//         };
//         _customerCache[companyName] = info;
//         return info;
//     }

//     // ── Channels/Lead Source — Custom Segment: csegecomm_channel ─────────────
//     // Uses getSelectOptions (dynamic mode) first, falls back to record.load
//     function findLeadSource(soRecord, name) {
//         if (_channelCache[name]) return _channelCache[name];

//         var FIELD_ID = "csegecomm_channel";
//         var recordId = null;
//         var childPart = name.split(" : ").pop();

//         // Attempt 1: getSelectOptions on the dynamic SO record
//         try {
//             var field = soRecord.getField({ fieldId: FIELD_ID });
//             if (field) {
//                 var options = field.getSelectOptions();
//                 log.debug("CHANNEL_OPTIONS", "Found " + options.length + " options");
//                 for (var oi = 0; oi < options.length; oi++) {
//                     var optText = options[oi].text;
//                     var optVal = options[oi].value;
//                     if (optText === name || optText === childPart ||
//                         (optText && optText.indexOf(childPart) >= 0)) {
//                         recordId = String(optVal);
//                         log.debug("CHANNEL_MATCH", "'" + optText + "' → ID " + recordId);
//                         break;
//                     }
//                 }
//             }
//         } catch (e) {
//             log.debug("CHANNEL_GETOPTIONS_ERR", e.message);
//         }

//         // Attempt 2: record.load fallback
//         if (!recordId) {
//             for (var rid = 1; rid <= 20; rid++) {
//                 try {
//                     var rec = record.load({ type: "customrecord_csegecomm_channel", id: rid });
//                     var recName = rec.getValue({ fieldId: "name" });
//                     log.debug("LEADSOURCE_REC_" + rid, "name=" + recName);
//                     if (recName === name || recName === childPart ||
//                         (recName && recName.indexOf(childPart) >= 0)) {
//                         recordId = String(rid);
//                         log.debug("LEADSOURCE_MATCH", "'" + recName + "' → ID " + recordId);
//                         break;
//                     }
//                 } catch (e) {
//                     log.debug("LEADSOURCE_REC_SKIP_" + rid, e.message);
//                 }
//             }
//         }

//         if (!recordId) {
//             log.error("LEADSOURCE_NOT_FOUND", "'" + name + "' not resolved");
//             return { id: null, fieldId: null };
//         }

//         var result = { id: recordId, fieldId: FIELD_ID };
//         _channelCache[name] = result;
//         log.debug("LEADSOURCE_RESOLVED", "field=" + FIELD_ID + " value=" + recordId);
//         return result;
//     }

//     function findFormId(formName) {
//         if (_formCache[formName]) return _formCache[formName];

//         try {
//             var formCol = search.createColumn({ name: "customform" });
//             var soResults = search.create({
//                 type: search.Type.SALES_ORDER,
//                 filters: [["mainline", "is", "T"]],
//                 columns: [formCol]
//             }).run().getRange({ start: 0, end: 50 });

//             for (var i = 0; i < soResults.length; i++) {
//                 var fId = soResults[i].getValue(formCol);
//                 var fName = soResults[i].getText(formCol);
//                 if (fName && fName.indexOf(formName) >= 0) {
//                     _formCache[formName] = fId;
//                     return fId;
//                 }
//             }
//         } catch (e) {
//             log.debug("FORM_SEARCH_ERR", e.message);
//         }

//         log.audit("FORM_NOT_FOUND", "Could not find form: " + formName);
//         return null;
//     }

//     // ── Snapshot: capture full SO state (header + lines) ─────────────────
//     function snapshotSO(soRecord) {
//         var snap = { header: {}, lines: [] };
//         var headerFields = [
//             "customform", "entity", "subsidiary", "otherrefnum", "trandate",
//             "shipdate", "orderstatus", "memo", "currency",
//             "custbody1", "custbody3", "csegecomm_channel"
//         ];
//         for (var hi = 0; hi < headerFields.length; hi++) {
//             try { snap.header[headerFields[hi]] = soRecord.getValue({ fieldId: headerFields[hi] }); } catch (e) { }
//         }
//         // Capture shipping address subrecord
//         try {
//             var addrRec = soRecord.getSubrecord({ fieldId: "shippingaddress" });
//             snap.header.shippingAddress = {
//                 addressee: addrRec.getValue({ fieldId: "addressee" }) || "",
//                 attention: addrRec.getValue({ fieldId: "attention" }) || "",
//                 addr1: addrRec.getValue({ fieldId: "addr1" }) || "",
//                 addr2: addrRec.getValue({ fieldId: "addr2" }) || "",
//                 city: addrRec.getValue({ fieldId: "city" }) || "",
//                 state: addrRec.getValue({ fieldId: "state" }) || "",
//                 zip: addrRec.getValue({ fieldId: "zip" }) || "",
//                 country: addrRec.getValue({ fieldId: "country" }) || ""
//             };
//         } catch (addrSnapErr) {
//             snap.header.shippingAddress = null;
//         }

//         var lineCount = soRecord.getLineCount({ sublistId: "item" });
//         snap.header.lineCount = lineCount;
//         var lineFields = ["item", "quantity", "rate", "amount", "location", "price", "description"];
//         for (var li = 0; li < lineCount; li++) {
//             var line = { line: li };
//             for (var lf = 0; lf < lineFields.length; lf++) {
//                 try { line[lineFields[lf]] = soRecord.getSublistValue({ sublistId: "item", fieldId: lineFields[lf], line: li }); } catch (e) { }
//             }
//             snap.lines.push(line);
//         }
//         return snap;
//     }

//     // ── Diff: compare before/after snapshots ──────────────────────────────
//     function diffSnapshots(before, after) {
//         if (!before || !after) return null;
//         var diff = { header: {}, lines: {} };
//         var allKeys = Object.keys(before.header).concat(Object.keys(after.header));
//         var seen = {};
//         for (var ki = 0; ki < allKeys.length; ki++) {
//             var k = allKeys[ki];
//             if (seen[k]) continue;
//             seen[k] = true;
//             var bVal = before.header[k];
//             var aVal = after.header[k];
//             if (String(bVal) !== String(aVal)) {
//                 diff.header[k] = { from: bVal, to: aVal };
//             }
//         }
//         // Line diff: simple count + content comparison
//         if (before.lines.length !== after.lines.length) {
//             diff.lines.countChange = { from: before.lines.length, to: after.lines.length };
//         }
//         diff.lines.before = before.lines;
//         diff.lines.after = after.lines;
//         return diff;
//     }

//     function findSalesOrder(otherrefnum) {
//         log.debug("SO_LOOKUP", "Searching for otherrefnum=" + otherrefnum);
//         var idCol = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
//         var refCol = search.createColumn({ name: "otherrefnum" });
//         var tranCol = search.createColumn({ name: "tranid" });
//         var results = search.create({
//             type: search.Type.SALES_ORDER,
//             filters: [["poastext", "is", otherrefnum], "AND", ["mainline", "is", "T"]],
//             columns: [idCol, refCol, tranCol]
//         }).run().getRange({ start: 0, end: 10 });

//         if (results.length === 0) {
//             log.debug("SO_LOOKUP_RESULT", "otherrefnum=" + otherrefnum + " → NOT FOUND");
//             return null;
//         }

//         // Log ALL matches
//         for (var si = 0; si < results.length; si++) {
//             log.debug("SO_MATCH_" + si, JSON.stringify({
//                 id: results[si].getValue(idCol),
//                 soNumber: results[si].getValue(tranCol),
//                 otherrefnum: results[si].getValue(refCol)
//             }));
//         }

//         if (results.length > 1) {
//             log.audit("SO_DUPLICATES", "Found " + results.length + " SOs for PO# " + otherrefnum + " — using newest (highest ID)");
//         }

//         // Results sorted by internalid DESC — first result is the newest
//         var found = parseInt(results[0].getValue(idCol), 10);
//         var soNum = results[0].getValue(tranCol);
//         log.debug("SO_LOOKUP_RESULT", "otherrefnum=" + otherrefnum + " → newest ID " + found + " (" + soNum + ")");
//         return { id: found, soNumber: soNum };
//     }

//     return { post: post };
// });




/**
 * NETSUITE RESTLET — Sales Order Sync
 *
 * HOW TO DEPLOY IN NETSUITE:
 * 1. Go to: Customization → Scripting → Scripts → New
 * 2. Script Type: RESTlet
 * 3. Name: EBP Sales Order Sync
 * 4. Script ID: customscript_ebp_sales_order_sync
 * 5. Upload this file
 * 6. Set POST Function to: post
 * 7. Save → Deploy
 * 8. Deployment ID: customdeploy_ebp_sales_order_sync
 * 9. Status: Released
 *
 * PAYLOAD EXPECTED:
 * {
 *   action:              "skip" | "update",
 *   otherrefnum:         "113-1234567-1234567",
 *   trandate:            "2026-01-15T00:00:00Z",
 *   store_type:          "amazon" | "walmart" | "newegg" | "ebay" | "shopify",
 *   order_status:        "Unshipped" | "Shipped" | ...,
 *   fulfillment_channel: "MFN" | "AFN",
 *   ship_date:           "2026-01-16T00:00:00Z" | null,
 *   shipping_address:    { addressee, company, addr1, addr2, city, state, zip, country },
 *   items:               [{ item: "SKU001", quantity: 2, amount: 49.99 }]
 * }
 *
 * ACTIONS RETURNED:
 *   "created"        — new SO created with line items
 *   "updated"        — existing SO updated with new line items
 *   "header_updated" — existing SO: SKUs not found in NS, header fields patched via submitFields only
 *   "no_items"       — create mode: no valid SKUs found, SO not created
 *   "skipped"        — SO already exists and action was "skip"
 *
 * NOTE: This account uses SuiteTax (Advanced Tax). SuiteTax requires DYNAMIC
 * mode for transaction records because the tax engine relies on field change
 * events that only fire in dynamic mode (setCurrentSublistValue).
 * Standard mode (setSublistValue) does NOT trigger these events, causing
 * VALID_LINE_ITEM_REQD errors even when all visible fields are set.
 *
 * For existing SOs where no SKUs map to active NS items, we use record.submitFields
 * instead of record.load + so.save(). This avoids loading the record in dynamic
 * mode entirely, so SuiteTax never re-validates the existing lines.
 */

/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/record", "N/search", "N/log"], function (record, search, log) {

    // ── Lookup maps: store_type → names ──────────────────────────────────────
    var CUSTOMER_MAP = {
        "amazon":          "Amazon",
        "walmart":         "Walmart",
        "newegg":          "NewEgg",
        "newegg_business": "NewEgg Business",
        "ebay":            "eBay",
        "shopify":         "Shopify"
    };

    var CHANNEL_MAP = {
        "amazon":          "3rd Party Marketplace : Amazon",
        "walmart":         "3rd Party Marketplace : Walmart",
        "newegg":          "3rd Party Marketplace : NewEgg",
        "newegg_business": "3rd Party Marketplace : NewEgg",
        "ebay":            "3rd Party Marketplace : eBay",
        "shopify":         "3rd Party Marketplace : Shopify"
    };

    var FORM_NAME       = "Ecomm BP - Sales Order";
    var SKIP_ITEM_TYPES = ["Group"];

    // ── Per-invocation caches ─────────────────────────────────────────────────
    var _customerCache = {};
    var _channelCache  = {};
    var _formCache     = {};

    // ═════════════════════════════════════════════════════════════════════════
    // MAIN POST HANDLER
    // ═════════════════════════════════════════════════════════════════════════
    function post(payload) {
        var so;
        var before = null;

        try {
            if (!payload || typeof payload !== "object") {
                return { success: false, error: "Invalid or missing payload" };
            }

            log.debug("PAYLOAD", JSON.stringify(payload));

            // ── Extract payload fields ────────────────────────────────────────
            var action              = payload.action              || "skip";
            var otherrefnum         = payload.otherrefnum;
            var trandate            = payload.trandate;
            var store_type          = (payload.store_type || "amazon").toLowerCase();
            var order_status        = payload.order_status        || "";
            var fulfillment_channel = payload.fulfillment_channel || "";
            var ship_date           = payload.ship_date;
            var items               = payload.items;
            var shipping            = payload.shipping_address    || null;

            if (!otherrefnum) {
                return { success: false, error: "Missing otherrefnum" };
            }

            // ── Check if SO already exists ────────────────────────────────────
            var existingMatch = findSalesOrder(otherrefnum);
            var existingId    = existingMatch ? existingMatch.id       : null;
            var existingSoNum = existingMatch ? existingMatch.soNumber  : null;

            if (existingId && action === "skip") {
                log.debug("SKIP", "Order " + otherrefnum + " already exists as " + existingSoNum);
                return {
                    success:    true,
                    action:     "skipped",
                    otherrefnum: otherrefnum,
                    existingId: existingId,
                    soNumber:   existingSoNum
                };
            }

            
            // ── Resolve customer ──────────────────────────────────────────────
            var customerName = CUSTOMER_MAP[store_type];
            if (!customerName) {
                return { success: false, error: "Unknown store_type: " + store_type };
            }
            var customerInfo = findCustomer(customerName);
            if (!customerInfo) {
                return { success: false, error: "Customer '" + customerName + "' not found in NetSuite" };
            }
            log.debug("CUSTOMER", JSON.stringify(customerInfo));

            // ── Resolve form ID ───────────────────────────────────────────────
            var formId = findFormId(FORM_NAME);
            log.debug("FORM", "'" + FORM_NAME + "' → ID " + formId);

            // ── Try to map SKUs BEFORE loading the record in dynamic mode ─────
            // This is the key insight: if no SKUs match, we use submitFields
            // instead of record.load, so SuiteTax never touches existing lines.
            var mappedItems  = [];
            var skippedSkus  = [];

            if (Array.isArray(items) && items.length > 0) {
                for (var i = 0; i < items.length; i++) {
                    var lineItem = items[i];
                    var sku = lineItem.item;

                    if (!sku) {
                        skippedSkus.push("(empty)");
                        continue;
                    }

                    try {
                        var itemResults = search.create({
                            type: search.Type.ITEM,
                            filters: [
                                ["itemid", "is", sku]
                            ],
                            columns: [
                                search.createColumn({ name: "internalid" }),
                                search.createColumn({ name: "type" }),
                                search.createColumn({ name: "isinactive" })
                            ]
                        }).run().getRange({ start: 0, end: 5 });

                        if (!itemResults || itemResults.length === 0) {
                            log.debug("ITEM_NOT_FOUND", "SKU \"" + sku + "\" not found in NetSuite");
                            skippedSkus.push(sku + " (not_found)");
                            continue;
                        }

                        var isInactive = itemResults[0].getValue("isinactive");
                        if (isInactive === true || isInactive === "T") {
                            log.audit("ITEM_INACTIVE", "SKU \"" + sku + "\" is inactive");
                            skippedSkus.push(sku + " (inactive)");
                            continue;
                        }

                        var itemType = itemResults[0].getText("type") || itemResults[0].getValue("type");
                        if (SKIP_ITEM_TYPES.indexOf(itemType) >= 0) {
                            skippedSkus.push(sku + " (type:" + itemType + ")");
                            continue;
                        }

                        var itemInternalId = parseInt(itemResults[0].getValue("internalid"), 10);
                        var qty  = parseInt(lineItem.quantity, 10) || 1;
                        var amt  = parseFloat(lineItem.amount)     || 0;
                        var rate = qty > 0 ? (amt / qty) : amt;

                        mappedItems.push({
                            sku:        sku,
                            internalId: itemInternalId,
                            qty:        qty,
                            amt:        amt,
                            rate:       rate
                        });

                        log.debug("ITEM_MAPPED", "SKU \"" + sku + "\" → NS ID " + itemInternalId);

                    } catch (itemErr) {
                        log.error("ITEM_LOOKUP_ERR", "SKU \"" + sku + "\" — " + itemErr.message);
                        skippedSkus.push(sku + " (error)");
                    }
                }
            }

            var skuList = Array.isArray(items)
                ? items.map(function(x) { return (x && x.item) || "unknown"; }).join(", ")
                : "none";

            log.audit("ITEM_MAPPING", "Mapped: " + mappedItems.length + " | Skipped: " + skippedSkus.join(", "));

            // ── NO ITEMS MAPPED ───────────────────────────────────────────────
            // If zero SKUs resolved, handle without loading the record in dynamic
            // mode — avoids SuiteTax re-validating existing lines on save.
            if (mappedItems.length === 0) {
                if (existingId) {
                    // Patch header fields only via submitFields (no record.load)
                    log.audit("HEADER_ONLY", otherrefnum + " — no SKUs mapped, patching header via submitFields");
                    try {
                        var fieldValues = {};

                        if (trandate) {
                            var pd = parseSafeDate(trandate);
                            if (pd) fieldValues["trandate"] = pd;
                        }
                        if (ship_date) {
                            var psd = parseSafeDate(ship_date);
                            if (psd) fieldValues["shipdate"] = psd;
                        }
                        if (order_status)        fieldValues["custbody1"] = String(order_status);
                        if (fulfillment_channel) fieldValues["custbody3"] = String(fulfillment_channel);

                        record.submitFields({
                            type:    record.Type.SALES_ORDER,
                            id:      existingId,
                            values:  fieldValues,
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });

                        log.audit("HEADER_ONLY_SUCCESS", otherrefnum + " → header patched on SO " + existingSoNum);
                        return {
                            success:        true,
                            action:         "header_updated",
                            otherrefnum:    otherrefnum,
                            internalId:     existingId,
                            soNumber:       existingSoNum,
                            skus_attempted: skuList,
                            skipped:        skippedSkus,
                            note:           "Header fields patched via submitFields — lines untouched (SKUs inactive or not in NS)"
                        };

                    } catch (sfErr) {
                        log.error("HEADER_ONLY_FAILED", sfErr.message);
                        return { success: false, error: sfErr.message, otherrefnum: otherrefnum };
                    }
                }

                // Create mode with no valid items — do not create an empty SO
                log.audit("NO_ITEMS_SKIP_CREATE", otherrefnum + " — no SKUs found, skipping SO creation");
                return {
                    success:        true,
                    action:         "no_items",
                    otherrefnum:    otherrefnum,
                    skus_attempted: skuList,
                    skipped:        skippedSkus
                };
            }

            // ── ITEMS MAPPED — load record and apply changes ──────────────────
            if (existingId && action === "update") {
                so = record.load({ type: record.Type.SALES_ORDER, id: existingId, isDynamic: true });
            } else {
                so = record.create({ type: record.Type.SALES_ORDER, isDynamic: true });
            }

            // Snapshot state before any changes
            before = snapshotSO(so);
            log.debug("SNAPSHOT_BEFORE", JSON.stringify(before));

            // Set form first (controls available fields/sublists)
            if (formId) {
                so.setValue({ fieldId: "customform", value: parseInt(formId, 10) });
            }

            // Set entity — auto-sets subsidiary in dynamic mode
            so.setValue({ fieldId: "entity", value: customerInfo.id });
            log.debug("ENTITY_SET", JSON.stringify({
                entity:     customerInfo.id,
                subsidiary: so.getValue({ fieldId: "subsidiary" }),
                mode:       existingId ? "update" : "create"
            }));

            // Set channel / lead source
            var channelName   = CHANNEL_MAP[store_type];
            var channelResult = channelName ? findLeadSource(so, channelName) : { id: null, fieldId: null };
            if (channelResult.id && channelResult.fieldId) {
                try {
                    so.setValue({ fieldId: channelResult.fieldId, value: parseInt(channelResult.id, 10) });
                    log.debug("CHANNEL_SET", channelResult.fieldId + " = " + channelResult.id);
                } catch (chErr) {
                    log.error("CHANNEL_SET_ERR", chErr.message);
                }
            }

            // Standard header fields
            so.setValue({ fieldId: "otherrefnum", value: String(otherrefnum) });

            // Date parsing: extract Y/M/D parts to build a local-midnight Date.
            // new Date("2026-01-15T00:00:00Z") is midnight UTC which, in US/Pacific,
            // becomes Jan 14 — causing an off-by-one-day error. By extracting the
            // date components and constructing a local Date, we always get the
            // intended calendar date regardless of the NetSuite company timezone.
            if (trandate) {
                var parsedDate = parseSafeDate(trandate);
                if (parsedDate) {
                    so.setValue({ fieldId: "trandate", value: parsedDate });
                }
            }
            if (ship_date) {
                var parsedShipDate = parseSafeDate(ship_date);
                if (parsedShipDate) {
                    so.setValue({ fieldId: "shipdate", value: parsedShipDate });
                }
            }

            // Custom body fields
            try { so.setValue({ fieldId: "custbody1", value: String(order_status) });        } catch (e) {}
            try { so.setValue({ fieldId: "custbody3", value: String(fulfillment_channel) }); } catch (e) {}

            // Shipping address subrecord
            if (shipping && (shipping.addr1 || shipping.city || shipping.state || shipping.zip)) {
                try {
                    var addrSubrecord = so.getSubrecord({ fieldId: "shippingaddress" });
                    if (shipping.country)   addrSubrecord.setValue({ fieldId: "country",   value: shipping.country });
                    if (shipping.addressee) addrSubrecord.setValue({ fieldId: "addressee", value: shipping.addressee });
                    if (shipping.company)   addrSubrecord.setValue({ fieldId: "attention", value: shipping.company });
                    if (shipping.addr1)     addrSubrecord.setValue({ fieldId: "addr1",     value: shipping.addr1 });
                    if (shipping.addr2)     addrSubrecord.setValue({ fieldId: "addr2",     value: shipping.addr2 });
                    if (shipping.city)      addrSubrecord.setValue({ fieldId: "city",      value: shipping.city });
                    if (shipping.state)     addrSubrecord.setValue({ fieldId: "state",     value: shipping.state });
                    if (shipping.zip)       addrSubrecord.setValue({ fieldId: "zip",       value: shipping.zip });
                    log.debug("SHIPPING_ADDR_SET", JSON.stringify(shipping));
                } catch (addrErr) {
                    log.error("SHIPPING_ADDR_ERR", addrErr.message);
                }
            }

            // Track old line count — must add new lines BEFORE removing old ones
            // because NetSuite requires at least one valid line at all times.
            var oldLineCount = so.getLineCount({ sublistId: "item" });
            log.debug("PRE_LINES", "Existing lines: " + oldLineCount + " | New lines to add: " + mappedItems.length);

            // ── Add new line items ────────────────────────────────────────────
            for (var mi = 0; mi < mappedItems.length; mi++) {
                var mapped = mappedItems[mi];
                try {
                    so.selectNewLine({ sublistId: "item" });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "item",     value: mapped.internalId });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "quantity", value: mapped.qty });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "price",    value: -1 }); // custom price
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "rate",     value: mapped.rate });
                    so.setCurrentSublistValue({ sublistId: "item", fieldId: "amount",   value: mapped.amt });
                    so.commitLine({ sublistId: "item" });
                    log.debug("LINE_ADDED_" + mi, "SKU " + mapped.sku + " → NS ID " + mapped.internalId);
                } catch (lineErr) {
                    log.error("LINE_ADD_ERR_" + mi, "SKU \"" + mapped.sku + "\" — " + lineErr.message);
                    skippedSkus.push(mapped.sku + " (line_error)");
                }
            }

            var linesAdded = so.getLineCount({ sublistId: "item" }) - oldLineCount;
            log.debug("LINES_ADDED", linesAdded + " new lines added");

            // ── Remove old lines (only if we successfully added new ones) ─────
            if (linesAdded > 0 && oldLineCount > 0) {
                log.debug("REMOVING_OLD_LINES", "Removing " + oldLineCount + " old lines");
                for (var r = oldLineCount - 1; r >= 0; r--) {
                    so.removeLine({ sublistId: "item", line: r });
                }
                log.debug("OLD_LINES_REMOVED", "Now has " + so.getLineCount({ sublistId: "item" }) + " lines");
            }

            // ── Snapshot AFTER changes, BEFORE save ───────────────────────────
            var after = snapshotSO(so);
            log.debug("SNAPSHOT_AFTER", JSON.stringify(after));
            var diff = diffSnapshots(before, after);
            log.debug("SNAPSHOT_DIFF", JSON.stringify(diff));

            // ── ONE save only ─────────────────────────────────────────────────
            log.audit("SAVING", otherrefnum + " — saving with " + so.getLineCount({ sublistId: "item" }) + " lines");
            var savedId;
            try {
                savedId = so.save({ enableSourcing: true, ignoreMandatoryFields: false });
            } catch (saveErr) {
                log.error("SAVE_FAILED", JSON.stringify({
                    name:        saveErr.name,
                    message:     saveErr.message,
                    otherrefnum: otherrefnum,
                    linesAdded:  linesAdded,
                    skippedSkus: skippedSkus
                }));
                throw saveErr;
            }
            log.audit("SUCCESS", otherrefnum + " saved → NS ID: " + savedId);

            return {
                success:     true,
                action:      existingId ? "updated" : "created",
                otherrefnum: otherrefnum,
                internalId:  savedId,
                before:      before,
                after:       after,
                diff:        diff
            };

        } catch (e) {
            // Dump line details on failure for debugging
            try {
                if (so) {
                    var errLineCount = so.getLineCount({ sublistId: "item" });
                    for (var el = 0; el < errLineCount; el++) {
                        var errLine = {};
                        ["item", "quantity", "rate", "amount", "location", "price"].forEach(function(f) {
                            try { errLine[f] = so.getSublistValue({ sublistId: "item", fieldId: f, line: el }); } catch(x) {}
                        });
                        log.error("FAIL_LINE_" + el, JSON.stringify(errLine));
                    }
                }
            } catch (dumpErr) {}

            var failAfter = null;
            var failDiff  = null;
            try {
                if (so) {
                    failAfter = snapshotSO(so);
                    failDiff  = diffSnapshots(before, failAfter);
                }
            } catch (snapErr) {}

            log.error("ERROR", JSON.stringify({ name: e.name, message: e.message, stack: e.stack }));
            return {
                success:    false,
                error:      e.message,
                otherrefnum: otherrefnum,
                existingId: existingId  || null,
                soNumber:   existingSoNum || null,
                before:     before    || null,
                after:      failAfter,
                diff:       failDiff
            };
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // HELPERS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Parse a date string into a local-midnight Date object.
     * Avoids UTC→timezone day shift by extracting Y/M/D components
     * from the ISO string and constructing a local Date.
     * Handles: "2026-01-15T00:00:00Z", "2026-01-15", "1/15/2026", Date objects
     */
    function parseSafeDate(raw) {
        if (!raw) return null;
        var d = new Date(raw);
        if (isNaN(d.getTime())) return null;
        // If the input looks like an ISO string, extract Y-M-D to avoid timezone shift
        var str = String(raw);
        var isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
            return new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
        }
        // For "M/D/YYYY" format (from server toSafeISO)
        var mdyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (mdyMatch) {
            return new Date(parseInt(mdyMatch[3], 10), parseInt(mdyMatch[1], 10) - 1, parseInt(mdyMatch[2], 10));
        }
        // Fallback: use the Date as-is (already parsed above)
        return d;
    }

    function findCustomer(companyName) {
        if (_customerCache[companyName]) return _customerCache[companyName];

        var col1 = search.createColumn({ name: "internalid" });
        var col2 = search.createColumn({ name: "subsidiary" });
        var results = search.create({
            type:    search.Type.CUSTOMER,
            filters: [["companyname", "is", companyName]],
            columns: [col1, col2]
        }).run().getRange({ start: 0, end: 1 });

        if (results.length === 0) return null;

        var info = {
            id:            parseInt(results[0].getValue(col1), 10),
            subsidiary:    results[0].getValue(col2),
            subsidiaryText: results[0].getText(col2) || ""
        };
        _customerCache[companyName] = info;
        return info;
    }

    function findLeadSource(soRecord, name) {
        if (_channelCache[name]) return _channelCache[name];

        var FIELD_ID  = "csegecomm_channel";
        var recordId  = null;
        var childPart = name.split(" : ").pop();

        // Attempt 1: getSelectOptions on the loaded dynamic SO record
        try {
            var field = soRecord.getField({ fieldId: FIELD_ID });
            if (field) {
                var options = field.getSelectOptions();
                for (var oi = 0; oi < options.length; oi++) {
                    var optText = options[oi].text;
                    var optVal  = options[oi].value;
                    if (optText === name || optText === childPart ||
                        (optText && optText.indexOf(childPart) >= 0)) {
                        recordId = String(optVal);
                        log.debug("CHANNEL_MATCH", "'" + optText + "' → ID " + recordId);
                        break;
                    }
                }
            }
        } catch (e) {
            log.debug("CHANNEL_GETOPTIONS_ERR", e.message);
        }

        // Attempt 2: search custom record (efficient — single search vs 20 record.load calls)
        if (!recordId) {
            try {
                var crResults = search.create({
                    type: "customrecord_csegecomm_channel",
                    filters: [
                        ["name", "contains", childPart]
                    ],
                    columns: [
                        search.createColumn({ name: "internalid" }),
                        search.createColumn({ name: "name" })
                    ]
                }).run().getRange({ start: 0, end: 10 });

                for (var cri = 0; cri < crResults.length; cri++) {
                    var crName = crResults[cri].getValue("name");
                    if (crName === name || crName === childPart ||
                        (crName && crName.indexOf(childPart) >= 0)) {
                        recordId = String(crResults[cri].getValue("internalid"));
                        log.debug("LEADSOURCE_MATCH", "'" + crName + "' → ID " + recordId);
                        break;
                    }
                }
            } catch (searchErr) {
                log.debug("LEADSOURCE_SEARCH_ERR", searchErr.message);
            }
        }

        if (!recordId) {
            log.error("LEADSOURCE_NOT_FOUND", "'" + name + "' not resolved");
            return { id: null, fieldId: null };
        }

        var result = { id: recordId, fieldId: FIELD_ID };
        _channelCache[name] = result;
        return result;
    }

    function findFormId(formName) {
        if (_formCache[formName]) return _formCache[formName];

        try {
            var formCol   = search.createColumn({ name: "customform" });
            var soResults = search.create({
                type:    search.Type.SALES_ORDER,
                filters: [["mainline", "is", "T"]],
                columns: [formCol]
            }).run().getRange({ start: 0, end: 50 });

            for (var i = 0; i < soResults.length; i++) {
                var fId   = soResults[i].getValue(formCol);
                var fName = soResults[i].getText(formCol);
                if (fName && fName.indexOf(formName) >= 0) {
                    _formCache[formName] = fId;
                    return fId;
                }
            }
        } catch (e) {
            log.debug("FORM_SEARCH_ERR", e.message);
        }

        log.audit("FORM_NOT_FOUND", "Could not find form: " + formName);
        return null;
    }

    function snapshotSO(soRecord) {
        var snap         = { header: {}, lines: [] };
        var headerFields = [
            "customform", "entity", "subsidiary", "otherrefnum", "trandate",
            "shipdate", "orderstatus", "memo", "currency",
            "custbody1", "custbody3", "csegecomm_channel"
        ];

        for (var hi = 0; hi < headerFields.length; hi++) {
            try { snap.header[headerFields[hi]] = soRecord.getValue({ fieldId: headerFields[hi] }); } catch (e) {}
        }

        try {
            var addrRec = soRecord.getSubrecord({ fieldId: "shippingaddress" });
            snap.header.shippingAddress = {
                addressee: addrRec.getValue({ fieldId: "addressee" }) || "",
                attention: addrRec.getValue({ fieldId: "attention" }) || "",
                addr1:     addrRec.getValue({ fieldId: "addr1" })     || "",
                addr2:     addrRec.getValue({ fieldId: "addr2" })     || "",
                city:      addrRec.getValue({ fieldId: "city" })      || "",
                state:     addrRec.getValue({ fieldId: "state" })     || "",
                zip:       addrRec.getValue({ fieldId: "zip" })       || "",
                country:   addrRec.getValue({ fieldId: "country" })   || ""
            };
        } catch (addrErr) {
            snap.header.shippingAddress = null;
        }

        var lineCount  = soRecord.getLineCount({ sublistId: "item" });
        snap.header.lineCount = lineCount;
        var lineFields = ["item", "quantity", "rate", "amount", "location", "price", "description"];

        for (var li = 0; li < lineCount; li++) {
            var line = { line: li };
            for (var lf = 0; lf < lineFields.length; lf++) {
                try { line[lineFields[lf]] = soRecord.getSublistValue({ sublistId: "item", fieldId: lineFields[lf], line: li }); } catch (e) {}
            }
            snap.lines.push(line);
        }
        return snap;
    }

    function diffSnapshots(before, after) {
        if (!before || !after) return null;
        var diff    = { header: {}, lines: {} };
        var allKeys = Object.keys(before.header).concat(Object.keys(after.header));
        var seen    = {};

        for (var ki = 0; ki < allKeys.length; ki++) {
            var k = allKeys[ki];
            if (seen[k]) continue;
            seen[k] = true;
            var bVal = before.header[k];
            var aVal = after.header[k];
            if (String(bVal) !== String(aVal)) {
                diff.header[k] = { from: bVal, to: aVal };
            }
        }

        if (before.lines.length !== after.lines.length) {
            diff.lines.countChange = { from: before.lines.length, to: after.lines.length };
        }
        diff.lines.before = before.lines;
        diff.lines.after  = after.lines;
        return diff;
    }

    function findSalesOrder(otherrefnum) {
        log.debug("SO_LOOKUP", "Searching for otherrefnum=" + otherrefnum);
        var idCol   = search.createColumn({ name: "internalid", sort: search.Sort.DESC });
        var refCol  = search.createColumn({ name: "otherrefnum" });
        var tranCol = search.createColumn({ name: "tranid" });

        var results = search.create({
            type:    search.Type.SALES_ORDER,
            filters: [["poastext", "is", otherrefnum], "AND", ["mainline", "is", "T"]],
            columns: [idCol, refCol, tranCol]
        }).run().getRange({ start: 0, end: 10 });

        if (results.length === 0) {
            log.debug("SO_LOOKUP_RESULT", "otherrefnum=" + otherrefnum + " → NOT FOUND");
            return null;
        }

        if (results.length > 1) {
            log.audit("SO_DUPLICATES", "Found " + results.length + " SOs for " + otherrefnum + " — using newest");
        }

        var found = parseInt(results[0].getValue(idCol), 10);
        var soNum = results[0].getValue(tranCol);
        log.debug("SO_LOOKUP_RESULT", "otherrefnum=" + otherrefnum + " → ID " + found + " (" + soNum + ")");
        return { id: found, soNumber: soNum };
    }

    return { post: post };
});