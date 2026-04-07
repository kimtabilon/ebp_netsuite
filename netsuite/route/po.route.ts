import { Router } from "express";
import log from "../config/logger.config";
import { getDb } from "../config/mongdodb.config";
import { syncPurchaseOrdersToNetsuite, retryFailedPurchaseOrders } from "../services/po.sync";
import { stagePurchaseOrders, resolveVendor, validateWarehouse } from "../services/po.stage";
import { postToNetsuiteForPO } from "../services/netsuite.client";
import { listPurchaseOrders, getPurchaseOrder, fetchAllPurchaseOrders } from "../services/netsuite.rest.client";

// ── Warehouse map with addresses for logging ───────────────────────────────
const WAREHOUSE_MAP: Record<string, { netsuiteName: string; address: string }> = {
    "MW":     { netsuiteName: "California - Chatsworth", address: "21540 Prairie Street, Suite F, Chatsworth CA 91311" },
    "W2G-PA": { netsuiteName: "Ware2Go - PA (Fairless Hills)", address: "1 Kresge Road, Fairless Hills, PA 19030" },
    "W2G-IL": { netsuiteName: "Ware2Go - IL (Aurora)", address: "1206 NAGEL BLVD, Batavia, IL 60510" },
    "W2G-KY": { netsuiteName: "Ware2Go - KY (Hebron)", address: "2525 Litton Lane, Hebron, KY 41048" },
    "W2G-TX": { netsuiteName: "Ware2Go - TX (Dallas)", address: "2450 Esters Blvd #100, Grapevine, TX 76051" }
};

const router = Router();

// ─── Direct PO RESTlet call ─────────────────────────────────────────────────
router.post("/po-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForPO(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Stage POs (ebp_pomanager → suite_purchase_order) ───────────────────────
router.get("/stage-po", async (_req: any, res: any) => {
    try {
        const result = await stagePurchaseOrders();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Sync POs (suite_purchase_order → NetSuite ERP) ─────────────────────────
router.get("/sync-po", async (_req: any, res: any) => {
    try {
        const results = await syncPurchaseOrdersToNetsuite();
        res.json({ success: true, count: results.length, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Reset PO sync flags (clean sync) ───────────────────────────────────────
// GET  /reset-po-sync → dry-run (count docs with ns_ flags)
// POST /reset-po-sync → unset all ns_ fields
router.get("/reset-po-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_purchase_order");
        const count = await col.countDocuments({
            $or: [
                { ns_synced: true },
                { ns_failed: true },
                { ns_error: { $exists: true } },
                { ns_retry_count: { $exists: true } },
            ]
        });
        res.json({ success: true, action: "dry_run", orders_with_sync_flags: count });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post("/reset-po-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_purchase_order");
        const result = await col.updateMany(
            {},
            {
                $set: { ns_synced: false },
                $unset: {
                    ns_synced_at: "", ns_result: "", ns_error: "",
                    ns_error_at: "", ns_retry_count: "", ns_failed: "",
                }
            }
        );
        log.info(`[RESET-PO-SYNC] Reset ${result.modifiedCount} POs`);
        res.json({ success: true, action: "reset", matched: result.matchedCount, modified: result.modifiedCount });
    } catch (e: any) {
        log.error("[RESET-PO-SYNC] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Retry failed POs ──────────────────────────────────────────────────────
router.get("/retry-failed-po", async (req: any, res: any) => {
    try {
        const resetAll = req.query.all === "1" || req.query.all === "true";
        const result = await retryFailedPurchaseOrders(resetAll);
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Test PO Flow — create SO → create PO + update SO ──────────────────────
// POST /test-po-flow?type=dropship    → Dropship PO + SO location update
// POST /test-po-flow?type=stocking    → Stocking PO (no SO link)
router.post("/test-po-flow", async (req: any, res: any) => {
    try {
        const poType = req.query.type || "dropship";
        const testId = "TEST-SO-" + 542865234;
        const testPoNum = 542865234;

        const poPayload: any = {
            action:   "update",
            po_type:  poType === "stocking" ? "Stocking" : "Dropship",
        };

        if (poType === "stocking") {
            Object.assign(poPayload, {
                po_number: testPoNum, otherrefnum: String(testPoNum),
                vendor_id: 117, distributor: "Synnex",
                distributor_order_number: "159016653",
                status: "Open PO", invoice: [], tracking: null,
                website_order_number: "", stocking_warehouse: "W2G-IL",
                order_items: [
                    { sku: "29S0500", qty: 80, cost: 487.74 },
                    { sku: "29S0100", qty: 80, cost: 346.16 },
                    { sku: "40N9020", qty: 50, cost: 299.54 },
                    { sku: "40N9070", qty: 20, cost: 452.07 },
                ],
            });
        } else {
            Object.assign(poPayload, {
                po_number: testPoNum, otherrefnum: String(testPoNum),
                vendor_id: 116, distributor: "suppliesnetwork",
                distributor_order_number: "322209601",
                status: "Open PO", invoice: [], tracking: null,
                website_order_number: testId, stocking_warehouse: "",
                order_items: [
                    { sku: "29S0100", qty: 1, cost: 68.81 },
                ],
            });
        }

        log.info(`[TEST-PO-FLOW] Sending ${poPayload.po_type} PO ${poPayload.po_number} (website_order_number: ${poPayload.website_order_number})`);
        const poResult = await postToNetsuiteForPO(poPayload);
        log.info(`[TEST-PO-FLOW] Done. PO action: ${poResult?.action}`);

        res.json({ success: true, type: poType, po: poResult });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

// ─── Dropship POs with synced SOs ───────────────────────────────────────────
// Returns website_order_numbers where:
//   suite_purchase_order.po_type = "Dropship"
//   AND a matching suite_sales_order (otherrefnum = website_order_number)
//   has ns_synced=true, ns_result="created"
router.get("/dropship-ready", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const poColl = nsDb.collection("suite_purchase_order");
        const soColl = nsDb.collection("suite_sales_order");

        // 1. All dropship PO website_order_numbers
        const dropshipPOs = await poColl
            .find({ po_type: "Dropship", website_order_number: { $exists: true, $ne: "" } })
            .project({ website_order_number: 1, po_number: 1, vendor_id: 1, ns_synced: 1 })
            .toArray();

        if (dropshipPOs.length === 0) {
            return res.json({ success: true, count: 0, matched: [] });
        }

        const orderNumbers = dropshipPOs.map((p: any) => p.website_order_number);

        // 2. Synced SOs whose otherrefnum matches
        const syncedSOs = await soColl
            .find({
                otherrefnum: { $in: orderNumbers },
                ns_synced: true,
                ns_result: "created",
            })
            .project({ otherrefnum: 1 })
            .toArray();

        const syncedSet = new Set(syncedSOs.map((s: any) => s.otherrefnum));

        // 3. Build matched list
        const matched = dropshipPOs
            .filter((p: any) => syncedSet.has(p.website_order_number))
            .map((p: any) => ({
                website_order_number: p.website_order_number,
                po_number: p.po_number,
                vendor_id: p.vendor_id,
                po_synced: !!p.ns_synced,
            }));

        res.json({
            success: true,
            total_dropship_pos: dropshipPOs.length,
            total_synced_sos: syncedSOs.length,
            count: matched.length,
            matched,
        });
    } catch (e: any) {
        log.error("[DROPSHIP-READY] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── PO Sync Status (counts by type + sync state) ───────────────────────────
router.get("/po-sync-status", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const poColl = nsDb.collection("suite_purchase_order");
        const soColl = nsDb.collection("suite_sales_order");

        // Total counts by type
        const totalStocking = await poColl.countDocuments({ po_type: { $ne: "Dropship" } });
        const totalDropship = await poColl.countDocuments({ po_type: "Dropship" });

        // Synced counts
        const syncedStocking = await poColl.countDocuments({ po_type: { $ne: "Dropship" }, ns_synced: true });
        const syncedDropship = await poColl.countDocuments({ po_type: "Dropship", ns_synced: true });

        // Failed counts
        const failedStocking = await poColl.countDocuments({ po_type: { $ne: "Dropship" }, ns_failed: true });
        const failedDropship = await poColl.countDocuments({ po_type: "Dropship", ns_failed: true });

        // Unsynced counts
        const unsyncedStocking = await poColl.countDocuments({ po_type: { $ne: "Dropship" }, ns_synced: { $ne: true }, ns_failed: { $ne: true } });
        const unsyncedDropship = await poColl.countDocuments({ po_type: "Dropship", ns_synced: { $ne: true }, ns_failed: { $ne: true } });

        // Dropship POs whose SO is synced in ERP (ready to sync)
        const dropshipCandidates = await poColl
            .find({ po_type: "Dropship", ns_synced: { $ne: true }, ns_failed: { $ne: true }, website_order_number: { $exists: true, $ne: "" } })
            .project({ website_order_number: 1 })
            .toArray();

        let dropshipReady = 0;
        let dropshipWaitingForSO = 0;
        if (dropshipCandidates.length > 0) {
            const orderNumbers = dropshipCandidates.map((p: any) => p.website_order_number);
            const syncedSOs = await soColl
                .find({ otherrefnum: { $in: orderNumbers }, ns_synced: true, ns_result: "created" })
                .project({ otherrefnum: 1 })
                .toArray();
            const syncedSet = new Set(syncedSOs.map((s: any) => s.otherrefnum));
            dropshipReady = dropshipCandidates.filter((p: any) => syncedSet.has(p.website_order_number)).length;
            dropshipWaitingForSO = unsyncedDropship - dropshipReady;
        } else {
            dropshipWaitingForSO = unsyncedDropship;
        }

        res.json({
            success: true,
            total: totalStocking + totalDropship,
            stocking: { total: totalStocking, synced: syncedStocking, unsynced: unsyncedStocking, failed: failedStocking },
            dropship: {
                total: totalDropship, synced: syncedDropship, unsynced: unsyncedDropship, failed: failedDropship,
                ready: dropshipReady, waiting_for_so: dropshipWaitingForSO,
            },
        });
    } catch (e: any) {
        log.error("[PO-SYNC-STATUS] Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Debug: trace sync-po logic step by step ────────────────────────────────
router.get("/po-sync-debug", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const poColl = nsDb.collection("suite_purchase_order");
        const soColl = nsDb.collection("suite_sales_order");

        const baseFilter = { ns_synced: { $ne: true }, ns_failed: { $ne: true } };

        const stockingCount = await poColl.countDocuments({ ...baseFilter, po_type: { $ne: "Dropship" } });

        const dropshipFilter = { ...baseFilter, po_type: "Dropship", website_order_number: { $exists: true, $ne: "" } };
        const dropshipCount = await poColl.countDocuments(dropshipFilter);

        const dropshipCandidates = await poColl
            .find(dropshipFilter)
            .limit(140)
            .project({ website_order_number: 1, po_number: 1 })
            .toArray();

        let syncedSOCount = 0;
        let readyCount = 0;
        let sampleCandidates: any[] = [];
        let sampleSOs: any[] = [];

        if (dropshipCandidates.length > 0) {
            sampleCandidates = dropshipCandidates.slice(0, 5);
            const orderNumbers = dropshipCandidates.map((p: any) => p.website_order_number);

            // Check with the exact filter used in po.sync.ts
            const syncedSOs = await soColl
                .find({ otherrefnum: { $in: orderNumbers }, ns_synced: true, ns_result: "created" })
                .project({ otherrefnum: 1, ns_result: 1 })
                .toArray();
            syncedSOCount = syncedSOs.length;

            const syncedSet = new Set(syncedSOs.map((s: any) => s.otherrefnum));
            readyCount = dropshipCandidates.filter((p: any) => syncedSet.has(p.website_order_number)).length;

            // Also check: what ns_result values do matching SOs actually have?
            const allMatchingSOs = await soColl
                .find({ otherrefnum: { $in: orderNumbers.slice(0, 20) } })
                .project({ otherrefnum: 1, ns_synced: 1, ns_result: 1 })
                .toArray();
            sampleSOs = allMatchingSOs.slice(0, 10);
        }

        // Also check: what ns_result values exist across all synced SOs?
        const soResultDistribution = await soColl.aggregate([
            { $match: { ns_synced: true } },
            { $group: { _id: "$ns_result", count: { $sum: 1 } } }
        ]).toArray();

        res.json({
            baseFilter,
            stocking_matching: stockingCount,
            dropship_matching: dropshipCount,
            dropship_candidates_fetched: dropshipCandidates.length,
            sample_candidates: sampleCandidates,
            synced_sos_matching_candidates: syncedSOCount,
            ready_to_sync: readyCount,
            sample_sos: sampleSOs,
            so_result_distribution: soResultDistribution,
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Sync Single PO by PO Number ───────────────────────────────────────────
// POST /sync-single-po
// Body: { po_number: 12345 }
// Finds the PO in suite_purchase_order (or po_management if not staged) and syncs just that one
router.post("/sync-single-po", async (req: any, res: any) => {
    try {
        const poNumber = req.body?.po_number;

        if (!poNumber) {
            return res.status(400).json({ success: false, error: "po_number is required in body" });
        }

        const nsDb = await getDb("netsuite");
        const poColl = nsDb.collection("suite_purchase_order");

        // Find the PO by po_number in staged collection
        let po = await poColl.findOne({ po_number: poNumber });

        // ── If not staged, try to find in po_management and stage it ──
        if (!po) {
            log.info(`[SYNC-SINGLE-PO] PO ${poNumber} not in suite_purchase_order, checking po_management...`);

            const poDb = await getDb("ebp_pomanager");
            const sourcePo = await poDb.collection("po_management").findOne({ po_number: poNumber });

            if (!sourcePo) {
                return res.status(404).json({
                    success: false,
                    error: `PO ${poNumber} not found in suite_purchase_order or po_management`
                });
            }

            log.info(`[SYNC-SINGLE-PO] Found PO ${poNumber} in po_management, auto-staging...`);

            // Build staged PO document (same logic as po.stage.ts)
            const vendor = resolveVendor(sourcePo.distributor, sourcePo.payment_type);
            const validatedWarehouse = validateWarehouse(
                sourcePo.stocking_warehouse,
                sourcePo.po_type,
                sourcePo.po_number
            );

            // Log warehouse and address
            const whInfo = WAREHOUSE_MAP[validatedWarehouse];
            if (whInfo) {
                log.info(`[SYNC-SINGLE-PO] Warehouse: ${validatedWarehouse} → ${whInfo.netsuiteName} (${whInfo.address})`);
            } else if (sourcePo.po_type === "Stocking") {
                log.warn(`[SYNC-SINGLE-PO] Warehouse: ${validatedWarehouse} — NO ADDRESS FOUND!`);
            }

            const stagedPo = {
                po_number: sourcePo.po_number,
                website_order_number: sourcePo.website_order_number || "",
                distributor: vendor.name,
                distributor_order_number: sourcePo.distributor_order_number ?? null,
                status: sourcePo.status || "",
                invoice: Array.isArray(sourcePo.invoice) ? sourcePo.invoice : [],
                vendor_id: vendor.id,
                tracking: sourcePo.tracking ?? null,
                order_items: sourcePo.order_items || [],
                po_type: sourcePo.po_type || "",
                stocking_warehouse: validatedWarehouse,
                created_at: sourcePo.created_at || "",
                updated_at: sourcePo.updated_at || "",
                ns_synced: false
            };

            // Upsert to suite_purchase_order
            await poColl.updateOne(
                { po_number: poNumber },
                { $set: stagedPo },
                { upsert: true }
            );

            log.info(`[SYNC-SINGLE-PO] PO ${poNumber} staged successfully`);

            // Re-fetch the staged PO (now it has _id)
            po = await poColl.findOne({ po_number: poNumber });

            if (!po) {
                return res.status(500).json({
                    success: false,
                    error: `PO ${poNumber} staging failed — could not re-fetch after upsert`
                });
            }
        }

        log.info(`[SYNC-SINGLE-PO] Ready to sync PO ${poNumber}: type=${po.po_type || "unknown"}, warehouse=${po.stocking_warehouse || "none"}, website_order=${po.website_order_number || "none"}`);

        // Reset sync flags so it will sync
        await poColl.updateOne(
            { _id: po._id },
            {
                $set: { ns_synced: false },
                $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
            }
        );

        // Call the sync with single PO payload directly to RESTlet
        // Transform order_items: database uses 'quantity'/'amount', RESTlet expects 'qty'/'cost'
        const transformedOrderItems = (po.order_items || []).map((item: any) => ({
            sku: item.sku,
            qty: item.quantity || item.qty || 0,
            cost: item.amount || item.cost || 0
        }));

        const poPayload: any = {
            action: "update",
            po_number: po.po_number,
            otherrefnum: String(po.po_number),
            vendor_id: po.vendor_id,
            distributor: po.distributor,
            distributor_order_number: po.distributor_order_number,
            status: po.status,
            invoice: po.invoice || [],
            tracking: po.tracking,
            order_items: transformedOrderItems,
            website_order_number: po.website_order_number || "",
            po_type: po.po_type || "Stocking",
            stocking_warehouse: po.stocking_warehouse || "",
            created_at: po.created_at
        };

        log.info(`[SYNC-SINGLE-PO] Sending PO ${poNumber} to NetSuite...`);
        const result = await postToNetsuiteForPO(poPayload);

        // Update MongoDB with result
        if (result.success === false) {
            await poColl.updateOne(
                { _id: po._id },
                {
                    $set: {
                        ns_synced: false,
                        ns_error: result.error || "sync_failed",
                        ns_error_at: new Date()
                    }
                }
            );
            return res.status(500).json({
                success: false,
                error: result.error,
                po_number: poNumber,
                ns_result: result
            });
        }

        await poColl.updateOne(
            { _id: po._id },
            {
                $set: {
                    ns_synced: true,
                    ns_synced_at: new Date(),
                    ns_result: result.action || "synced"
                },
                $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "" }
            }
        );

        log.info(`[SYNC-SINGLE-PO] PO ${poNumber} synced successfully: ${result.action}`);

        res.json({
            success: true,
            po_number: poNumber,
            staged: !po,  // was it auto-staged?
            action: result.action,
            internalId: result.internalId,
            ns_result: result
        });

    } catch (e: any) {
        log.error(`[SYNC-SINGLE-PO] Error syncing PO: ${e?.response?.data || e.message}`);
        res.status(500).json({ success: false, error: e?.response?.data || e.message });
    }
});

// ─── Delete All POs ─────────────────────────────────────────────────────────
// GET  /delete-all-po → dry-run
// POST /delete-all-po → delete
import { callCleanup } from "../services/netsuite.client";

router.get("/delete-all-po", async (_req: any, res: any) => {
    log.info("[DELETE-PO] GET dry-run — calling cleanup RESTlet");
    try {
        const result = await callCleanup({ action: "list_po" });
        res.json(result);
    } catch (e: any) {
        log.error("[DELETE-PO] ERROR", { status: e?.response?.status, data: e?.response?.data, message: e.message });
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

router.post("/delete-all-po", async (_req: any, res: any) => {
    log.info("[DELETE-PO] POST execute — looping batches via cleanup RESTlet");
    try {
        let totalDeleted = 0, totalErrors = 0, batchNum = 0, done = false;

        while (!done) {
            batchNum++;
            log.info(`[DELETE-PO] Batch ${batchNum}...`);
            const result = await callCleanup({ action: "delete_po" });
            const batch = result?.purchase_orders;

            if (!batch) {
                return res.status(500).json({ error: "No purchase_orders in response", raw: result });
            }

            totalDeleted += batch.deleted || 0;
            totalErrors += batch.errors || 0;
            done = batch.done || (batch.deleted === 0 && batch.remaining <= 0);

            log.info(`[DELETE-PO] Batch ${batchNum}: deleted ${batch.deleted}, errors ${batch.errors}, remaining ~${batch.remaining}`);
        }

        log.info(`[DELETE-PO] Done. Total deleted: ${totalDeleted}, errors: ${totalErrors}, batches: ${batchNum}`);
        res.json({ success: true, total_deleted: totalDeleted, total_errors: totalErrors, batches: batchNum });
    } catch (e: any) {
        log.error("[DELETE-PO] ERROR", { status: e?.response?.status, data: e?.response?.data, message: e.message });
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// NETSUITE REST API - PURCHASE ORDERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /purchaseOrder
 * List Purchase Orders from NetSuite via REST API
 * 
 * Headers:
 *   Prefer: respond-async
 *   X-NetSuite-Idempotency-Key: string
 * 
 * Query:
 *   q: SuiteQL query string
 *   limit: number (default 1000)
 *   offset: number (default 0)
 *   expandItems: boolean
 *   fetchAll: boolean - If true, fetches ALL pages and gets full record details for each
 */
router.get("/purchaseOrder", async (req: any, res: any) => {
    const prefer = req.headers.prefer;
    const idempotencyKey = req.headers["x-netsuite-idempotency-key"];
    const fetchAll = req.query.fetchAll === "true";

    try {
        // fetchAll mode: get all pages and full record details
        if (fetchAll) {
            log.info("[PurchaseOrder List] fetchAll mode enabled - fetching all pages and details");
            const allRecords = await fetchAllPurchaseOrders({
                q: req.query.q,
                expandSubResources: req.query.expandItems === "true" ? "item" : undefined,
                maxRecords: req.query.maxRecords ? parseInt(req.query.maxRecords, 10) : undefined
            });
            return res.json({
                success: true,
                fetchAll: true,
                count: allRecords.length,
                items: allRecords
            });
        }

        const options = {
            q: req.query.q,
            limit: req.query.limit ? parseInt(req.query.limit, 10) : 1000,
            offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
            expandSubResources: req.query.expandItems === "true" ? "item" : undefined
        };

        if (prefer === "respond-async") {
            if (!idempotencyKey) {
                return res.status(400).json({ success: false, error: "X-NetSuite-Idempotency-Key required for async" });
            }
            const data = await listPurchaseOrders(options);
            return res.status(202).setHeader("Preference-Applied", "respond-async").json({
                success: true,
                async: true,
                idempotencyKey,
                ...data
            });
        }

        const data = await listPurchaseOrders(options);
        return res.json({ success: true, ...data });
    } catch (e: any) {
        log.error("[PurchaseOrder List] Error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /purchaseOrder/:id
 * Get single Purchase Order by ID
 */
router.get("/purchaseOrder/:id", async (req: any, res: any) => {
    const { id } = req.params;
    const expandSubResources = req.query.expandItems === "true" ? "item" : undefined;

    try {
        const data = await getPurchaseOrder(id, expandSubResources);
        res.json({ success: true, data });
    } catch (e: any) {
        log.error(`[PurchaseOrder Get] ${id} Error:`, e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
