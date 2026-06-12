import { Router } from "express";
import log from "../config/logger.config";
import { getDb } from "../config/mongdodb.config";
import { stageItemFulfillmentsDummy } from "../services/item_fulfillment.stage";
import { syncItemFulfillmentsToNetsuite } from "../services/item_fulfillment.sync";
import { postToNetsuiteForIF } from "../services/netsuite.client";
import { IF_COLLECTION } from "../services/item_fulfillment.stage";

const router = Router();

// ─── Direct IF RESTlet test call ────────────────────────────────────────────
// POST /if-test  Body: full payload
router.post("/if-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForIF(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Stage Item Fulfillments ─────────────────────────────────────────────────
// GET /stage-if-dummy → stages Dropship Shipped POs to  
router.get("/stage-if-dummy", async (_req: any, res: any) => {
    try {
        const result = await stageItemFulfillmentsDummy();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Sync Item Fulfillments ──────────────────────────────────────────────────
// GET /sync-if → sends pending staged IFs to NetSuite
router.get("/sync-if", async (_req: any, res: any) => {
    try {
        const results = await syncItemFulfillmentsToNetsuite();
        const success = results.filter((r: any) => r.success).length;
        const failed  = results.filter((r: any) => !r.success).length;
        res.json({ success: true, total: results.length, synced: success, failed, results });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── IF Sync Status ──────────────────────────────────────────────────────────
// GET /if-sync-status → counts by sync state
router.get("/if-sync-status", async (_req: any, res: any) => {
    try {
        const ns_db     = await getDb("netsuite");
        const col       = ns_db.collection(IF_COLLECTION);

        const total       = await col.countDocuments({});
        const synced      = await col.countDocuments({ ns_synced: true });
        const failed      = await col.countDocuments({ ns_failed: true });
        const skipped     = await col.countDocuments({ ns_skip: true });
        const waitingForSO = await col.countDocuments({ so_synced: { $ne: true } });
        const pending     = await col.countDocuments({
            ns_synced: { $ne: true },
            ns_failed: { $ne: true },
            ns_skip:   { $ne: true },
            so_synced: true
        });

        res.json({
            success: true,
            collection: IF_COLLECTION,
            total,
            synced,
            failed,
            skipped,
            pending,
            waiting_for_so: waitingForSO
        });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Reset IF sync flags ─────────────────────────────────────────────────────
// POST /reset-if-sync → reset all ns_ flags so records re-sync
router.post("/reset-if-sync", async (_req: any, res: any) => {
    try {
        const ns_db = await getDb("netsuite");
        const col   = ns_db.collection(IF_COLLECTION);
        const result = await col.updateMany(
            {},
            {
                $set: { ns_synced: false },
                $unset: { ns_synced_at: "", ns_result: "", ns_error: "", ns_error_at: "", ns_retry_count: "", ns_failed: "", ns_internal_id: "" }
            }
        );
        log.info(`[RESET-IF-SYNC] Reset ${result.modifiedCount} records`);
        res.json({ success: true, modified: result.modifiedCount });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Retry failed IFs ───────────────────────────────────────────────────────
// GET /retry-failed-if
router.get("/retry-failed-if", async (_req: any, res: any) => {
    try {
        const ns_db = await getDb("netsuite");
        const col   = ns_db.collection(IF_COLLECTION);
        const result = await col.updateMany(
            { ns_failed: true },
            {
                $set: { ns_synced: false, ns_failed: false },
                $unset: { ns_error: "", ns_error_at: "", ns_retry_count: "" }
            }
        );
        log.info(`[RETRY-IF] Reset ${result.modifiedCount} failed records`);
        const syncResults = await syncItemFulfillmentsToNetsuite();
        res.json({ success: true, reset: result.modifiedCount, synced: syncResults.length, results: syncResults });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
