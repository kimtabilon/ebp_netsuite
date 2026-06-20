import { getDb } from "../config/mongdodb.config";
import { callCleanup, postToNetsuiteForCreditMemo } from "./netsuite.client";
import log from "../config/logger.config";
import { buildOAuthHeader } from "./netsuite.rest.client";
import axios from "axios";

const LOCATION_MAP: Record<string, string> = {
    "MW": "6",  // California - Chatsworth
    "W2G-PA": "10", // Ware2Go - PA
    "W2G-IL": "17", // Ware2Go - IL
    "W2G-KY": "8",  // Ware2Go - KY
    "W2G-TX": "11"  // Ware2Go - TX
};

const DROPSHIP_LOCATION_ID = "15";

/**
 * Syncs Credit Memos from suite_credit_memo_bill to NetSuite via RESTlet.
 */
export async function syncCreditMemosToNetsuite() {
    log.info("[NS Credit Sync] Starting via RESTlet...");
    const ns_db = await getDb("netsuite");
    const collection = ns_db.collection("suite_credit_memo_bill");

    const filter = {
        po_sync: true,
        bill_sync: true,
        po_type: "Stocking"
        // ns_synced: { $ne: true },
        // ns_failed: { $ne: true }
    };

    const credits = await collection.find(filter).toArray();
    log.info(`[NS Credit Sync] Found ${credits.length} records to sync.`);

    for (const credit of credits) {
        try {
            log.info(`[NS Credit Sync] Processing Ref: ${credit.reference_number} (PO ${credit.po_number})`);

            // Resolve Location ID
            let locationId = DROPSHIP_LOCATION_ID;
            if (credit.po_type === "Stocking" && credit.stocking_warehouse) {
                locationId = LOCATION_MAP[credit.stocking_warehouse] || DROPSHIP_LOCATION_ID;
            }

            const payload = {
                po_number: credit.po_number,
                invoice_number: credit.invoice_number,
                reference_number: credit.reference_number,
                invoice_date: credit.invoice_date,
                line_items: credit.items.map((item: any) => ({
                    sku: item.sku,
                    qty: item.qty,
                    price: item.price,
                    ...(item.serials && Array.isArray(item.serials) && item.serials.length > 0
                        ? { serial_number: item.serials[0] }
                        : {}),
                    inventory_status: "1"
                })),
                vendor_id: credit.vendor_id,
                location_id: locationId // Pass the resolved ID
            };

            const result = await postToNetsuiteForCreditMemo(payload);

            if (result.success) {
                log.info(`✅ [NS Credit Sync] Success: ${credit.reference_number} -> NS ID ${result.internalId}`);
                await collection.updateOne(
                    { _id: credit._id },
                    {
                        $set: {
                            ns_synced: true,
                            ns_synced_at: new Date(),
                            ns_vendor_credit_id: result.internalId,
                            ns_result: "created"
                        },
                        $unset: { ns_failed: "", ns_error: "", ns_error_at: "" }
                    }
                );
            } else {
                throw new Error(result.error || "Unknown RESTlet error");
            }

        } catch (err: any) {
            const errMsg = err.message;
            log.error(`❌ [NS Credit Sync] Failed for ${credit.reference_number}: ${errMsg}`);

            await collection.updateOne(
                { _id: credit._id },
                {
                    $set: {
                        ns_failed: true,
                        ns_error: errMsg,
                        ns_error_at: new Date()
                    }
                }
            );
        }
    }

    log.info("[NS Credit Sync] Finished.");
}


export async function deletesyncBills() {
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
            log.info("No record found")
            // return res.json({ success: true, message: "No matching vendor credits found to delete." });
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

        // res.json({
        //     success: true,
        //     total_found: matchRecords.length,
        //     deleted_count: deletedIds.length,
        //     failed_count: errors.length,
        //     deleted_ids: deletedIds,
        //     errors: errors.length > 0 ? errors : undefined
        // });

        log.info("Successful", {
            success: true,
            total_found: matchRecords.length,
            deleted_count: deletedIds.length,
            failed_count: errors.length,
            deleted_ids: deletedIds,
            errors: errors.length > 0 ? errors : undefined
        })

    } catch (e: any) {
        log.error("[API Delete Credits] Error:", e.response?.data || e.message);
        // res.status(500).json({ success: false, error: e.response?.data || e.message });
    }
}