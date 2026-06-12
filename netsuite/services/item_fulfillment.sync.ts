import { getDb } from "../config/mongdodb.config";
import log from "../config/logger.config";
import { postToNetsuiteForIF } from "./netsuite.client";
import { IF_COLLECTION } from "./item_fulfillment.stage";

const MAX_CONCURRENT = parseInt(process.env.NS_MAX_CONCURRENT || "1", 10);

export const syncItemFulfillmentsToNetsuite = async (): Promise<any[]> => {
    log.info("[IF Sync] Starting...");
    const ns_db     = await getDb("netsuite");
    const collection = ns_db.collection(IF_COLLECTION);

 
//     const pending = await collection.find({
//   po_number: {
//     $in:   [
// 233885
//     ]
//   }
// }).toArray();
    const pending = await collection.find({
        
        so_synced:true,po_synced:true, 
        // ns_synced : false  
        ns_synced: { $exists: false } 
  
    }).toArray();

    log.info(`[IF Sync] Found ${pending.length} Item Fulfillments to sync`);
    const results: any[] = [];

    let index = 0;
    async function worker() {
        while (index < pending.length) {
            const i   = index++;
            const doc = pending[i];
            const ref = `PO${doc.po_number}-${doc.website_order_number}`;
            log.info(`[IF Sync] Processing: ${ref}`);

            const payload = {
                po_number:            doc.po_number,
                bill_number:          doc.bill_number || "",
                website_order_number: doc.website_order_number,
                ship_date:            doc.ship_date,
                tracking_number:      doc.tracking_number,
                weight_lbs:           doc.weight_lbs || 1,
                shipping_address:     doc.shipping_address,
                items:                doc.items
            };

            try {
                const result = await postToNetsuiteForIF(payload);

                if (result.success === false) {
                    await collection.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                ns_error:       result.error || "sync_failed",
                                ns_error_at:    new Date(),
                                ns_synced:      false,
                                ns_so_number:   result.soNumber,
                                ns_so_status:   result.soStatus
                            }
                        }
                    );
                    log.warn(`[IF Sync] ❌ Failed for ${ref}: ${result.error}${result.soStatus ? " (SO Status: " + result.soStatus + ")" : ""}`);
                    results.push({ ref, success: false, error: result.error, soNumber: result.soNumber });
                } else {
                    await collection.updateOne(
                        { _id: doc._id },
                        {
                            $set: {
                                ns_synced:      true,
                                ns_synced_at:   new Date(),
                                ns_result:      result.action || "created",
                                ns_internal_id: result.internalId,
                                ns_so_number:   result.soNumber,
                                ns_error:       null,
                                ns_error_at:    null
                            }
                        }
                    );
                    log.info(`[IF Sync] ✅ Success: ${ref} → NS ID ${result.internalId} (SO: ${result.soNumber})`);
                    results.push({ ref, success: true, action: result.action, internalId: result.internalId, soNumber: result.soNumber });
                }
            } catch (e: any) {
                log.error(`[IF Sync] ❌ Exception for ${ref}: ${e.message}`);
                await collection.updateOne(
                    { _id: doc._id },
                    {
                        $set: {
                            ns_synced:      false,
                            ns_error:       e.message || "sync_exception",
                            ns_error_at:    new Date()
                        }
                    }
                );
                results.push({ ref, success: false, error: e.message });
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, pending.length) }, () => worker()));
    log.info(`[IF Sync] Done. Processed ${results.length} records.`);
    return results;
};
