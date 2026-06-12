import { Router } from "express";
import log from "../config/logger.config";
import { getDb } from "../config/mongdodb.config";
import { stageCreditBillsDummy } from "../services/bill.stage";
import { syncCreditMemosToNetsuite } from "../services/credit_memo.sync";
import { postToNetsuiteForCreditMemo, callCleanup } from "../services/netsuite.client";
import { buildOAuthHeader } from "../services/netsuite.rest.client";
import axios from "axios";

const router = Router();

// ─── Direct Credit Memo RESTlet call ─────────────────────────────────────────
router.post("/credit-test", async (req: any, res: any) => {
    try {
        const result = await postToNetsuiteForCreditMemo(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e?.response?.data || e.message });
    }
});

// ─── Stage Credit Memos (po_bills -> suite_credit_memo_bill) ────────────
router.get("/stage-credit", async (_req: any, res: any) => {
    try {
        const result = await stageCreditBillsDummy();
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Sync Credit Memos (suite_credit_memo_bill -> NetSuite ERP) ─────────
router.get("/sync-credit", async (_req: any, res: any) => {
    try {
        await syncCreditMemosToNetsuite();
        res.json({ success: true, message: "Sync process completed. Check logs for details." });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Reset Credit sync flags ──────────────────────────────────────────────────
router.post("/reset-credit-sync", async (_req: any, res: any) => {
    try {
        const nsDb = await getDb("netsuite");
        const col = nsDb.collection("suite_credit_memo_bill");
        const result = await col.updateMany(
            {},
            {
                $set: { ns_synced: false, ns_failed: false },
                $unset: {
                    ns_synced_at: "", ns_result: "", ns_error: "",
                    ns_error_at: "", ns_vendor_credit_id: ""
                }
            }
        );
        res.json({ success: true, action: "reset", modified: result.modifiedCount });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── Delete All Credit Memos in NetSuite ──────────────────────────────────────
router.post("/delete-all-credit-memos", async (_req: any, res: any) => {
    try {
        const ACCOUNT = process.env.NS_ACCOUNT_ID!;
        const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
        const queryUrl = `${BASE_URL}/services/rest/query/v1/suiteql`;

        log.info("[API Delete Credits] Fetching Vendor Credits from NetSuite...");
        
        // Fetch all credits
        const query = `SELECT id, tranid FROM transaction WHERE type = 'VendCred' ORDER BY id DESC`;
        
        const response = await axios.post(queryUrl, { q: query }, {
            headers: {
                Authorization: buildOAuthHeader(queryUrl, "POST"),
                "Content-Type": "application/json",
                Prefer: "transient"
            },
            timeout: 60000
        });

        const allItems = response.data.items || [];
        const matchRecords = allItems.filter((r: any) => r.tranid && String(r.tranid).startsWith("PO"));
        
        log.info(`[API Delete Credits] Found ${allItems.length} total Credits, ${matchRecords.length} match "PO*" prefix`);

        if (matchRecords.length === 0) {
            return res.json({ success: true, message: "No matching vendor credits found to delete." });
        }

        const ids = matchRecords.map((r: any) => r.id);
        
        log.info(`[API Delete Credits] Sending ${ids.length} IDs to cleanup RESTlet in batches of 40...`);
        
        const batchSize = 40;
        const deletedIds: string[] = [];
        const errors: any[] = [];

        for (let i = 0; i < ids.length; i += batchSize) {
            const chunk = ids.slice(i, i + batchSize);
            const cleanResult = await callCleanup({
                action: "delete_ids",
                recordType: "vendorcredit",
                ids: chunk
            });

            if (cleanResult?.success) {
                deletedIds.push(...(cleanResult.data?.deleted || []));
                if (cleanResult.data?.errors) {
                    errors.push(...cleanResult.data.errors);
                }
            } else {
                errors.push({ batch: chunk, error: cleanResult?.error || "Cleanup RESTlet failed" });
            }
        }

        log.info(`[API Delete Credits] Finished. Deleted: ${deletedIds.length}, Failed: ${errors.length}`);
        
        res.json({
            success: true,
            total_found: matchRecords.length,
            deleted_count: deletedIds.length,
            failed_count: errors.length,
            deleted_ids: deletedIds,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (e: any) {
        log.error("[API Delete Credits] Error:", e.response?.data || e.message);
        res.status(500).json({ success: false, error: e.response?.data || e.message });
    }
});

export default router;

