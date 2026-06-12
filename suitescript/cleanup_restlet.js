/**
 * CLEANUP RESTLET
 * 
 * Provides utility actions for bulk record management:
 * - get_problematic_ids: Deep search for records with missing line-level classes
 * - update_classes: Strictly updates line-item classifications only
 * 
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/record', 'N/search', 'N/log', 'N/query'], (record, search, log, query) => {

    function post(payload) {
        var action = payload.action;
        var result = { success: true, action: action };

        try {
            switch (action) {
                case "delete_ids":
                    result.data = handleDeleteIds(payload.recordType, payload.ids);
                    break;
                case "delete_pos_by_number":
                    result.data = handleDeletePOsByNumber(payload.poNumbers);
                    break;
                case "update_classes":
                    result.data = handleUpdateClasses(payload.recordType, payload.ids);
                    break;
                case "get_problematic_ids":
                    result.data = findRecordsWithMissingLineClasses(payload.recordType);
                    break;
                case "get_links":
                    result.data = handleGetLinks(payload.recordType, payload.ids);
                    break;
                default:
                    result.success = false;
                    result.error = "Unknown action: " + action;
            }
        } catch (e) {
            log.error("RESTLET_ERROR", e.message);
            result.success = false;
            result.error = e.message;
        }

        return result;
    }

    function handleDeleteIds(recordType, ids) {
        var deleted = [];
        var errors = [];
        
        if (!ids || !Array.isArray(ids)) {
            return { success: false, error: "Invalid or missing ids array" };
        }

        for (var i = 0; i < ids.length; i++) {
            var currentId = ids[i];
            try {
                // If it's a PO or SO, try to clean up related records first
                if (recordType === 'purchaseorder' || recordType === 'purchaseOrder' || 
                    recordType === 'salesorder' || recordType === 'salesOrder') {
                    findAndDeleteRelated(currentId);
                }

                record.delete({ type: recordType, id: currentId });
                deleted.push(currentId);
            } catch (e) {
                errors.push({ id: currentId, error: e.message });
            }
        }

        return { 
            success: true, 
            summary: {
                totalRequested: ids.length,
                deletedCount: deleted.length, 
                errorCount: errors.length 
            },
            deletedIds: deleted,
            failedIds: errors 
        };
    }

    function handleDeletePOsByNumber(poNumbers) {
        var deleted = [];
        var errors = [];
        
        if (!poNumbers || !Array.isArray(poNumbers)) {
            return { success: false, error: "Invalid or missing poNumbers array" };
        }

        for(var i = 0; i < poNumbers.length; i++) {
            var raw = String(poNumbers[i]).trim();
            if (!raw) continue;
            var bare = raw.replace(/^PO/i, "").trim();

            try {
                // Find PO securely using SuiteQL
                var sql = "SELECT id, tranid, otherrefnum FROM transaction WHERE type = 'PurchOrd' AND (tranid = ? OR otherrefnum = ? OR tranid = ? OR otherrefnum = ?)";
                var rs = query.runSuiteQL({ 
                    query: sql, 
                    params: [raw, raw, bare, bare] 
                }).asMappedResults();

                if (rs.length === 0) {
                    errors.push({ number: raw, error: "PO not found in NetSuite" });
                    continue;
                }

                var internalId = rs[0].id;

                // Attempt to delete. If it has related receipts or bills, NetSuite will natively throw a dependency error here, which is exactly what we want!
                record.delete({ type: record.Type.PURCHASE_ORDER, id: internalId });
                deleted.push({ id: internalId, number: raw });

            } catch (e) {
                log.error("DELETE_ERR", "Failed on " + raw + ": " + e.message);
                errors.push({ id: internalId, number: raw, error: e.message });
            }
        }

        return { 
            success: true, 
            summary: {
                totalRequested: poNumbers.length,
                deletedCount: deleted.length, 
                errorCount: errors.length 
            },
            deletedList: deleted,
            failedList: errors 
        };
    }

    /**
     * Finds and deletes transactions created from a specific record (e.g. Receipts/Bills from a PO)
     */
    function findAndDeleteRelated(baseId) {
        if (!baseId) return;
        log.audit("CLEANUP", "Searching for records linked to: " + baseId);
        
        // Search for ANY transaction linked to this one
        var relatedSearch = search.create({
            type: search.Type.TRANSACTION,
            filters: [
                [
                    ["createdfrom", "anyof", [baseId]], 
                    "OR", 
                    ["appliedtotransaction", "anyof", [baseId]],
                    "OR",
                    ["billingtransaction", "anyof", [baseId]]
                ],
                "AND",
                ["mainline", "is", "T"]
            ],
            columns: ["recordtype", "tranid", "status"]
        });

        relatedSearch.run().each(function(result) {
            var relType = result.getValue("recordtype");
            var relId = result.id;
            var relTranId = result.getValue("tranid");
            
            try {
                log.audit("CLEANUP", "Found linked " + relType + " ID: " + relId + " (" + relTranId + ") for base ID: " + baseId);
                
                // Recursive call: handle deep chains (Payment -> Bill -> Receipt -> PO)
                findAndDeleteRelated(relId);
                
                record.delete({ type: relType, id: relId });
                log.audit("CLEANUP", "Successfully deleted linked " + relType + " (ID: " + relId + ")");
            } catch (e) {
                log.error("CLEANUP_FAILED", "Could not delete linked record " + relId + " (" + relType + "): " + e.message);
            }
            return true;
        });
    }

    function handleGetLinks(recordType, ids) {
        var results = {};
        
        if (!ids || !Array.isArray(ids)) {
            return { error: "Invalid or missing ids array" };
        }

        for (var i = 0; i < ids.length; i++) {
            var baseId = ids[i];
            var links = [];
            
            var relatedSearch = search.create({
                type: search.Type.TRANSACTION,
                filters: [
                    [
                        ["createdfrom", "anyof", [baseId]], 
                        "OR", 
                        ["appliedtotransaction", "anyof", [baseId]],
                        "OR",
                        ["billingtransaction", "anyof", [baseId]]
                    ]
                ],
                columns: ["recordtype", "tranid", "status", "mainline"]
            });

            relatedSearch.run().each(function(result) {
                links.push({
                    id: result.id,
                    type: result.getValue("recordtype"),
                    tranid: result.getValue("tranid"),
                    status: result.getText("status"),
                    mainline: result.getValue("mainline")
                });
                return links.length < 50; // Limit per ID
            });
            
            results[baseId] = links;
        }

        return results;
    }

    function handleUpdateClasses(recordType, ids) {
        var updated = [];
        var errors = [];
        
        for (var i = 0; i < ids.length; i++) {
            try {
                var rec = record.load({ type: recordType, id: ids[i], isDynamic: false });
                var lineCount = rec.getLineCount({ sublistId: 'item' });
                var hasChanged = false;

                // Line-by-Line Update ONLY
                for (var j = 0; j < lineCount; j++) {
                    var itemId = rec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: j });
                    var lineClass = rec.getSublistValue({ sublistId: 'item', fieldId: 'class', line: j });

                    if (!lineClass || lineClass == '') {
                        var itemLookup = search.lookupFields({
                            type: search.Type.ITEM,
                            id: itemId,
                            columns: ['class']
                        });

                        if (itemLookup.class && itemLookup.class.length > 0) {
                            var targetClass = itemLookup.class[0].value;
                            rec.setSublistValue({ sublistId: 'item', fieldId: 'class', line: j, value: targetClass });
                            hasChanged = true;
                        }
                    }
                }

                if (hasChanged) {
                    rec.save({ ignoreMandatoryFields: true });
                    updated.push(ids[i]);
                } else {
                    updated.push(ids[i]); 
                }
            } catch (e) {
                errors.push({ id: ids[i], error: e.message });
            }
        }

        return { success: true, updated: updated.length, errors: errors.length, errorList: errors };
    }

    function findRecordsWithMissingLineClasses(recordType) {
        var results = [];
        var typeMap = {
            "purchaseorder": search.Type.PURCHASE_ORDER,
            "salesorder": search.Type.SALES_ORDER,
            "vendorbill": search.Type.VENDOR_BILL
        };

        var nsType = typeMap[recordType] || recordType;

        var s = search.create({
            type: nsType,
            filters: [
                ["mainline", "is", "F"],
                "AND",
                ["class", "anyof", "@NONE@"],
                "AND",
                ["status", "anyof", "SalesOrd:B", "SalesOrd:D", "SalesOrd:E", "SalesOrd:F"],
                "AND",
                ["item.type", "noneof", "Description", "Subtotal", "Discount", "TaxItem", "TaxGroup", "ShipItem", "OtherCharge"]
            ],
            columns: [
                search.createColumn({ name: "internalid", summary: search.Summary.GROUP })
            ]
        });

        var pagedData = s.runPaged({ pageSize: 1000 });
        for (var pi = 0; pi < pagedData.pageRanges.length; pi++) {
            var page = pagedData.fetch({ index: pi });
            page.data.forEach(function (r) {
                if (results.length < 10000) {
                    results.push(r.getValue({ name: "internalid", summary: search.Summary.GROUP }));
                }
            });
            if (results.length >= 10000) break;
        }

        return { count: results.length, ids: results };
    }

    function findSalesOrderMissingClasses() {
        // Dummy placeholder to keep the script structure clean
    }

    return { post: post };
});
