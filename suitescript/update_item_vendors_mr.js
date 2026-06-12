/**
 * MASS UPDATE ITEM VENDORS — MapReduceScript
 *
 * Automatically loops through all active Inventory, Serialized, and Assembly Items,
 * and ensures that the 11 key dropship vendors are linked to every item.
 *
 * Features:
 *   - Runs entirely in the NetSuite backend (fully automated).
 *   - Skips saving if the item already has the vendors mapped (high-performance).
 *   - Automatic type-resolution between Inventory, Serialized, and Assembly Items.
 *   - Safely bypasses mandatory field validation during save.
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(["N/search", "N/record", "N/log", "N/runtime", "N/query"], function (search, record, log, runtime, query) {
    "use strict";

    // Mappings for native NetSuite record types
    var _typeMap = null;
    function getTypeMap() {
        if (_typeMap) return _typeMap;
        _typeMap = {
            "InvtPart": record.Type.INVENTORY_ITEM,
            "inventoryitem": record.Type.INVENTORY_ITEM,
            "SerializedInventoryItem": record.Type.SERIALIZED_INVENTORY_ITEM,
            "serializedinventoryitem": record.Type.SERIALIZED_INVENTORY_ITEM,
            "Assembly": record.Type.ASSEMBLY_ITEM,
            "assemblyitem": record.Type.ASSEMBLY_ITEM
        };
        return _typeMap;
    }

    // List of dropship vendors that MUST be linked to all active items
    var TARGET_VENDORS = [
        "116", // TD Synnex - Term
        "117", // TD Synnex - DLL
        "118", // D&H - DLL
        "119", // D&H
        "131", // Distribution Management - DLL
        "268", // Distribution Management
        "269", // Ingram Micro - DLL
        "133", // Ingram Micro - NET
        "285", // MA LABS
        "286", // Arlington
        "287"  // ASI
    ];

    // ── getInputData ─────────────────────────────────────────────────────
    function getInputData() {
        log.audit("VND_MR_START", "Gathering active items missing one or more dropship vendors using SuiteQL...");

        try {
            // High-priority active items from MongoDB staging database
            var activeIds = [2279,2377,2381,2387,2395,2398,2400,2401,2404,2406,2408,2410,2411,2413,2426,2427,2428,2429,2430,2431,2432,2433,2434,2435,2436,2437,2438,2439,2440,2441,2442,2443,2444,2445,2446,2447,2448,2449,2450,2451,2452,2453,2454,2455,2456,2457,2458,2459,2460,2461,2462,2463,2464,2465,2466,2467,2468,2469,2470,2471,2472,2473,2474,2475,2476,2477,2478,2479,2480,2481,2482,2483,2484,2485,2486,2704,3310,3391,3398,3402,3403,3405,3406,3407,3409,3410,7360,7450,7493,7636,8139,8140,8141,8142,8143,8144,8307,8337,8401,8403,8404,8405,8406,8407,8411,8419,8420,8421,8422,8423,8424,8426,8427,8428,8429,8431,8432,8433,8434,8436,8437,8438,8439,8440,8441,8442,8443,8445,8446,8447,8448,8449,8450,8451,8452,8453,8454,8455,8456,8457,8458,8459,8460,8461,8462,8463,8466,8469,8470,8471,8472,8473,8474,8475,8476,8477,8478,8479,8480,8481,8488,8489,8494,8495,8496,8497,8499,8501,8502,8503,8504,8543,8549,8552,8554,8555,8556,8557,8561,8854,9212,9984,11056,11118,11135,11260,11263,11267,11269,11270,11271,11272,11273,11274,11275,11276,11277,11278,11279,11280,11486,11492,11659,11732,11762,12676,12680,12687,12689,12692,12695,13112,13442,13463,13493,13640,14074,14184,14220,14326,15338,15343,15348,15349,15350,15446,15447,15448,15449,15652,15765,16537,16663,16664,16666,16667,16668,16669,16688,16920,16958,16963,16975,16982,16987,16991,17257,17279,17286,17714,17763,17774,17775,17803,17810,17984,18133,18554,18568,18640,18701,18741,18742,18749,18899,19165,19188,19191,19193,19194,19222,19280,19306,19308,19315,19316,19322,19323,19381,19463,19482,19489,19493,19495,19498,19855,19875,20000,20020,20169,20249,20270,20271,20330,20331,20356,20370,20419,20420,20426,20446,20449,20567,20725,20727,20728,20730,20772,20773,20774,20775,20776,20777,20778,20780,20781,20782,20860,20878,20904,20938,20940,20963,20964,20966,20967,20968,21049,21050,21051,21052,21053,21054,21056,21067,21070,21102,21103,21104,21312,21314,21316,21319,21320,21330,22676,22677,22678,22679,22803,22860,23194,23257,23258,23259,23260,23345,23355,23990,24627,26386,42400,42401,42402,42403,42405,42406,42410,42413,42415,42417,42418,42419,42431,42432,42433,42447,42448,42449,42455,42517,42785,42801,43530,43833,43848,43849,43852,43855,44010,44015,44016,44017,44018,44019,44020,44021,44022,44024,44026,44029,44030,44031,44032,44034,45077,45078,45079,45080,45081,45082,45083,45084,45085,45086,45091,45094,45095,45096,45097,45100,45104,45105,45107,45122,45129,45130,45447,46570,47077,47795,48977,48980,48984,48990,49241,49243,49251,50574,50723,50791,51340,51341,51349,51350,51359,51361,51364,52415,58280,58281,58283,58285,58779,58793,58799,58801,58802,58804,58863,59442,59482,59486,59495,59499,59501,59503,59504,59505,59510,59521,60433,63837,63885,63908,63932,63943,63949,63953,63959,63970,63974,63975,63976,63981,63993,63998,64004,64071,65213,66632,66643,66644,66647,66653,66654,66656,66665,66666,66682,66684,67302,70854,70858,71052,73797,73942,74121,75719,75743,76424,77262,77264,77265,77268,77270,77272,77651,77654,77655,77657,77658,77659,77660,77661,79865,79880,79881,79882,79884,84130,84235,84311,84396,84417,84488,84779,85324,87326,87327,87328,88054,89120,89258,89292,89293,89296,89299,89305,89306,89310,89311,89331,89339,89350,89365,89368,89369,89370,89372,89399,89404,89408,89412,89416,89424,89425,89430,89434,89435,89436,89437,89438,90214,90266,91519,93359,93362,93897,93900,93903,94337,97402,98596,99387,100271,100272,100273,100277,100278,100279,100280];
            var activeIdsStr = activeIds.join(",");

            var allResults = [];
            var seenIds = {};

            // 1. Fetch high-priority items first (100% standard, clean query)
            var prioritySql = "SELECT id, itemtype, itemid " +
                              "FROM item " +
                              "WHERE isinactive = 'F' " +
                              "  AND itemtype IN ('InvtPart', 'Assembly') " +
                              "  AND id IN (" + activeIdsStr + ") " +
                              "  AND id NOT IN ( " +
                              "      SELECT item " +
                              "      FROM itemvendor " +
                              "      WHERE vendor IN (116, 117, 118, 119, 131, 268, 269, 133, 285, 286, 287) " +
                              "      GROUP BY item " +
                              "      HAVING COUNT(DISTINCT vendor) = 11 " +
                              "  )";

            log.audit("VND_MR_PRIORITY", "Fetching priority items...");
            var priorityResultSet = query.runSuiteQL({ query: prioritySql }).asMappedResults();
            priorityResultSet.forEach(function (row) {
                seenIds[row.id] = true;
                allResults.push({
                    id: row.id,
                    recordType: row.itemtype === 'InvtPart' ? 'inventoryitem' : 'assemblyitem',
                    values: {
                        itemid: row.itemid
                    }
                });
            });
            log.audit("VND_MR_PRIORITY_DONE", "Found priority items: " + priorityResultSet.length);

            // 2. Fetch remaining items globally (standard clean query with LIMIT/OFFSET)
            var globalSql = "SELECT id, itemtype, itemid " +
                            "FROM item " +
                            "WHERE isinactive = 'F' " +
                            "  AND itemtype IN ('InvtPart', 'Assembly') " +
                            "  AND id NOT IN ( " +
                            "      SELECT item " +
                            "      FROM itemvendor " +
                            "      WHERE vendor IN (116, 117, 118, 119, 131, 268, 269, 133, 285, 286, 287) " +
                            "      GROUP BY item " +
                            "      HAVING COUNT(DISTINCT vendor) = 11 " +
                            "  )";

            var pagedData = query.runSuiteQLPaged({
                query: globalSql,
                pageSize: 1000
            });

            log.audit("VND_MR_FETCH_START", "Starting global paged fetch (Total Pages: " + pagedData.pageRanges.length + ")");

            pagedData.pageRanges.forEach(function (pageRange) {
                var page = pagedData.fetch({ index: pageRange.index });
                var resultSet = page.data.asMappedResults();
                
                resultSet.forEach(function (row) {
                    // Only add if not already in our priority list
                    if (!seenIds[row.id]) {
                        seenIds[row.id] = true;
                        allResults.push({
                            id: row.id,
                            recordType: row.itemtype === 'InvtPart' ? 'inventoryitem' : 'assemblyitem',
                            values: {
                                itemid: row.itemid
                            }
                        });
                    }
                });

                log.audit("VND_MR_FETCH", "Fetched page " + pageRange.index + "/" + pagedData.pageRanges.length + " (items: " + resultSet.length + ")");
            });

            log.audit("VND_MR_START_DONE", "Total queue length (Priority + Global): " + allResults.length);
            return allResults;

        } catch (e) {
            log.error("VND_MR_START_ERR", "SuiteQL item gathering failed: " + e.message);
            throw e;
        }
    }

    // ── map ──────────────────────────────────────────────────────────────
    function map(context) {
        var searchResult = JSON.parse(context.value);
        var id = Number(searchResult.id);
        var itemType = searchResult.recordType; // e.g. "inventoryitem" or "assemblyitem"

        var typeMap = getTypeMap();
        var recType = typeMap[itemType] || record.Type.INVENTORY_ITEM;

        var index = Number(context.key) || 0;
        if (index < 5 || index % 500 === 0) {
            log.audit("VND_MR_MAP", "Processing item index=" + index + " | ID=" + id + " | SKU=" + searchResult.values.itemid + " | Type=" + recType);
        }

        try {
            processItem(id, recType, context);
        } catch (err) {
            var errMsg = err.message || "";

            // Auto-retry for type mismatch (e.g. loaded as inventoryitem, but is serialized)
            if (errMsg.indexOf("different type:") >= 0) {
                var typeMatch = errMsg.match(/different type:\s*(\w+)\s*from/);
                if (typeMatch && typeMatch[1]) {
                    var retryType = typeMap[typeMatch[1]];
                    if (retryType && retryType !== recType) {
                        log.audit("VND_MR_RETRY", "ID=" + id + " type mismatch: retrying as " + typeMatch[1]);
                        try {
                            processItem(id, retryType, context);
                            return;
                        } catch (retryErr) {
                            log.error("VND_MR_RETRY_FAIL", "ID=" + id + " retry failed — " + retryErr.message);
                        }
                    }
                }
            }

            log.error("VND_MR_FAIL", "Failed item ID=" + id + " | SKU=" + searchResult.values.itemid + " | Error: " + errMsg);
            context.write({ key: "failed", value: String(id) });
        }
    }

    // Helper function to update the item's vendors sublist
    function processItem(id, recType, context) {
        var itemRec = record.load({
            type: recType,
            id: id,
            isDynamic: true // Dynamic mode allows on-the-fly sublist updates
        });

        // 1. Scan existing vendors in the sublist
        var lineCount = itemRec.getLineCount({ sublistId: "itemvendor" });
        var existingVendors = {};
        for (var i = 0; i < lineCount; i++) {
            var vendorVal = itemRec.getSublistValue({
                sublistId: "itemvendor",
                fieldId: "vendor",
                line: i
            });
            if (vendorVal) {
                existingVendors[String(vendorVal)] = true;
            }
        }

        // 2. Add any missing target vendors
        var changed = false;
        var preferredVendorSet = false;

        // Check if there is already a preferred vendor in the existing list
        for (var k = 0; k < lineCount; k++) {
            var isPref = itemRec.getSublistValue({
                sublistId: "itemvendor",
                fieldId: "preferredvendor",
                line: k
            });
            if (isPref === true || isPref === "T") {
                preferredVendorSet = true;
                break;
            }
        }

        TARGET_VENDORS.forEach(function (vId) {
            if (!existingVendors[vId]) {
                itemRec.selectNewLine({ sublistId: "itemvendor" });
                itemRec.setCurrentSublistValue({
                    sublistId: "itemvendor",
                    fieldId: "vendor",
                    value: vId
                });

                // If no preferred vendor exists on this item yet, mark the first one as preferred
                if (!preferredVendorSet) {
                    itemRec.setCurrentSublistValue({
                        sublistId: "itemvendor",
                        fieldId: "preferredvendor",
                        value: true
                    });
                    preferredVendorSet = true;
                }

                itemRec.commitLine({ sublistId: "itemvendor" });
                changed = true;
            }
        });

        // 3. Save the record ONLY if a vendor was missing
        if (changed) {
            itemRec.save({
                enableSourcing: false,
                ignoreMandatoryFields: true // Prevents mandatory fields from blocking the update
            });
            context.write({ key: "updated", value: String(id) });
        } else {
            context.write({ key: "skipped", value: String(id) });
        }
    }

    // ── reduce ───────────────────────────────────────────────────────────
    function reduce(context) {
        context.write({ key: context.key, value: String(context.values.length) });
    }

    // ── summarize ────────────────────────────────────────────────────────
    function summarize(summary) {
        var totals = { updated: 0, skipped: 0, failed: 0 };

        summary.output.iterator().each(function (key, value) {
            totals[key] = Number(value) || 0;
            return true;
        });

        var total = totals.updated + totals.skipped + totals.failed;
        var elapsed = summary.seconds;

        log.audit("VND_MR_DONE", "──── BATCH UPDATE COMPLETE ────"
            + "\n  Total Items Checked: " + total
            + "\n  Vendors Added/Updated: " + totals.updated
            + "\n  Skipped (Already Correct): " + totals.skipped
            + "\n  Failed to Update: " + totals.failed
            + "\n  Execution Time: " + elapsed + " seconds"
            + "\n  Processing Speed: " + (total > 0 ? (total / elapsed).toFixed(1) : 0) + " items/sec"
        );

        if (summary.inputSummary && summary.inputSummary.error) {
            log.error("VND_MR_INPUT_ERROR", summary.inputSummary.error);
        }

        var mapErrCount = 0;
        summary.mapSummary.errors.iterator().each(function (k, err) {
            mapErrCount++;
            if (mapErrCount <= 20) {
                log.error("VND_MR_MAP_ERROR", "Key=" + k + " — " + err);
            }
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
