import axios from 'axios';
import * as dotenv from 'dotenv';
import { getDb } from '../config/mongdodb.config';
dotenv.config();

const WORKER_COUNT = 5;

// export async function getWare2GoOrder(options: { forceRestart?: boolean } = {}) {
//     try {
//         const { forceRestart = false } = options;
//         const username = process.env.W2G_USERNAME || '';
//         const password = process.env.W2G_PASSWORD || '';
//         const merchantId = process.env.W2G_MERCHANT_ID || '';

//         if (!username || !password || !merchantId) {
//             throw new Error('Missing required W2G environment variables');
//         }

//         const db = await getDb("ebp_w2g");
//         const ordersCollection = db.collection("w2g_orders");
//         const syncMetaCollection = db.collection("w2g_sync_meta");

//         await ordersCollection.createIndex({ orderId: 1 }, { unique: true });

//         const RATE_LIMIT_DELAY = 200;
//         const MAX_PAGES = 100000;
//         const DETAIL_BATCH_SIZE = 50;

//         // If forceRestart, clear previous sync state
//         if (forceRestart) {
//             console.log(`[W2G API] Force restart requested — clearing previous sync state...`);
//             await syncMetaCollection.deleteOne({ merchantId, type: 'full_sync' });
//         }

//         // Load last sync state
//         const syncState = await syncMetaCollection.findOne({ merchantId, type: 'full_sync' }) || {
//             lastProcessedPage: 0,
//             lastProcessedOrderIndex: 0,
//             totalOrderIds: [],
//             status: 'idle'
//         };

//         // If previously completed and not forceRestart, auto-clear and start fresh
//         if (syncState.status === 'completed' && !forceRestart) {
//             console.log(`[W2G API] Previous sync was completed. Auto-clearing metadata for fresh start...`);
//             await syncMetaCollection.deleteOne({ merchantId, type: 'full_sync' });
//             // Reset state after clearing
//             syncState.lastProcessedPage = 0;
//             syncState.lastProcessedOrderIndex = 0;
//             syncState.totalOrderIds = [];
//             syncState.status = 'idle';
//         }

//         let startPage = (syncState.lastProcessedPage || 0) + 1;
//         let orderIdsToFetch: string[] = syncState.totalOrderIds || [];
//         let hasMorePages = true;
//         let page = startPage;

//         const results = {
//             inserted: 0,
//             updated: 0,
//             skipped: 0,
//             errors: 0,
//             totalFetched: 0,
//             pagesProcessed: syncState.lastProcessedPage || 0,
//             detailsProcessed: syncState.lastProcessedOrderIndex || 0
//         };

//         console.log(`[W2G API] Starting sync for merchant ${merchantId}...`);
//         console.log(`[W2G API] Status: ${syncState.status} | Resuming from page ${startPage}, detail index ${results.detailsProcessed}`);

//         // Update status to running
//         await syncMetaCollection.updateOne(
//             { merchantId, type: 'full_sync' },
//             { $set: { status: 'running', startedAt: new Date() } },
//             { upsert: true }
//         );

//         // Phase 1: Fetch all order IDs
//         if (orderIdsToFetch.length === 0) {
//             console.log(`[W2G API] Phase 1: Collecting all order IDs...`);
//             orderIdsToFetch = [];
//             page = 1;
//             results.pagesProcessed = 0;

//             while (hasMorePages && page <= MAX_PAGES) {
//                 console.log(`[W2G API] Fetching order list page ${page}...`);

//                 let response;
//                 let retries = 3;

//                 while (retries > 0) {
//                     try {
//                         response = await axios({
//                             method: 'get',
//                             url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/orders`,
//                             auth: { username, password },
//                             params: { page: page, pageSize: 100 },
//                             timeout: 30000
//                         });
//                         break;
//                     } catch (apiError: any) {
//                         retries--;
//                         if (retries === 0) throw apiError;
//                         await new Promise(r => setTimeout(r, (3 - retries) * 2000));
//                     }
//                 }

//                 const orders = response?.data?.orders || [];
//                 const link = response?.data?.link;

//                 for (const order of orders) {
//                     orderIdsToFetch.push(order.orderId);
//                 }

//                 results.totalFetched += orders.length;
//                 results.pagesProcessed++;

//                 // Save progress after each page
//                 await syncMetaCollection.updateOne(
//                     { merchantId, type: 'full_sync' },
//                     {
//                         $set: {
//                             lastProcessedPage: page,
//                             totalOrderIds: orderIdsToFetch,
//                             totalListPages: results.pagesProcessed,
//                             updatedAt: new Date()
//                         }
//                     },
//                     { upsert: true }
//                 );

//                 hasMorePages = !!link && link.includes(`page=${page + 1}`);
//                 page++;
                
//                 if (hasMorePages) {
//                     await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
//                 }
//             }

//             console.log(`[W2G API] Collected ${orderIdsToFetch.length} total order IDs`);
//         } else {
//             console.log(`[W2G API] Resuming with ${orderIdsToFetch.length} cached order IDs`);
//         }

//         // Phase 2: Fetch details with checkpoint saves
//         console.log(`[W2G API] Phase 2: Processing details from index ${results.detailsProcessed}...`);

//         for (let i = results.detailsProcessed; i < orderIdsToFetch.length; i++) {
//             const orderId = orderIdsToFetch[i];

//             try {
//                 const existing = await ordersCollection.findOne(
//                     { orderId: orderId },
//                     { projection: { status: 1 } }
//                 );

//                 if (existing?.status === 'SHIPPED') {
//                     results.skipped++;
//                     continue;
//                 }

//                 const detailResponse = await axios({
//                     method: 'get',
//                     url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/orders/${orderId}`,
//                     auth: { username, password },
//                     timeout: 30000
//                 });

//                 const fullOrder = detailResponse.data;

//                 const dbResult = await ordersCollection.updateOne(
//                     { orderId: orderId },
//                     {
//                         $set: { ...fullOrder, _updatedAt: new Date() },
//                         $setOnInsert: { _createdAt: new Date(), _source: 'ware2go_api' }
//                     },
//                     { upsert: true }
//                 );

//                 if (dbResult.upsertedCount) {
//                     results.inserted++;
//                 } else {
//                     results.updated++;
//                 }

//                 results.detailsProcessed = i + 1;

//                 // Save checkpoint every DETAIL_BATCH_SIZE orders
//                 if (results.detailsProcessed % DETAIL_BATCH_SIZE === 0) {
//                     await syncMetaCollection.updateOne(
//                         { merchantId, type: 'full_sync' },
//                         {
//                             $set: {
//                                 lastProcessedOrderIndex: results.detailsProcessed,
//                                 updatedAt: new Date()
//                             }
//                         }
//                     );
//                     console.log(`💾 Checkpoint saved at ${results.detailsProcessed}/${orderIdsToFetch.length}`);
//                 }

//                 if (i < orderIdsToFetch.length - 1) {
//                     await new Promise(r => setTimeout(r, 100));
//                 }

//             } catch (error: any) {
//                 results.errors++;
//                 console.error(`❌ Error with ${orderId}:`, error.message);
//             }
//         }

//         // ✅ SUCCESS: Clear metadata so next scheduled run starts fresh
//         console.log(`[W2G API] Sync completed successfully. Clearing sync metadata for next run...`);
//         await syncMetaCollection.deleteOne({ merchantId, type: 'full_sync' });

//         console.log(`\n📊 Sync Complete:`);
//         console.log(`   Total List Pages:    ${results.pagesProcessed}`);
//         console.log(`   Total Order IDs:     ${orderIdsToFetch.length}`);
//         console.log(`   Details Processed:   ${results.detailsProcessed}`);
//         console.log(`   Inserted:            ${results.inserted}`);
//         console.log(`   Updated:             ${results.updated}`);
//         console.log(`   Skipped (SHIPPED):   ${results.skipped}`);
//         console.log(`   Errors:              ${results.errors}`);
//         console.log(`   Meta Cleared:        ✅ Yes — next run will start from scratch`);

//         return results;

//     } catch (error: any) {
//         console.error("\n❌ [W2G API] Fatal error:", error.message);
        
//         // ❌ FAILURE: Keep metadata so next run can resume
//         const db = await getDb("ebp_w2g");
//         await db.collection("w2g_sync_meta").updateOne(
//             { merchantId: process.env.W2G_MERCHANT_ID, type: 'full_sync' },
//             { $set: { status: 'error', error: error.message, errorAt: new Date() } },
//             { upsert: true }
//         );
        
//         if (error.response) {
//             console.error("Status:", error.response.status);
//             console.error("Data:", JSON.stringify(error.response.data, null, 2));
//         }
//         throw error;
//     }
// }


 



 

export async function getWare2SoOrderOutbound(options: { 
    forceRestart?: boolean;
    retryFailedOnly?: boolean;
    all? :boolean   
} = {}) {
    try {
        const { forceRestart = false, retryFailedOnly = false,all=false } = options;
        const username = process.env.W2G_USERNAME || '';
        const password = process.env.W2G_PASSWORD || '';
        const merchantId = process.env.W2G_MERCHANT_ID || '';
        let  FINAL_STATUSES = [ ];
        if (all){
        FINAL_STATUSES=   ['shipped', 'cancelled', 'delivered', 'exception', 'voided'];
        }else{
        FINAL_STATUSES= [ 'cancelled', 'delivered', 'exception', 'voided'];
        }
        if (!username || !password || !merchantId) {
            throw new Error('Missing required W2G environment variables');
        }

        const db = await getDb("ebp_w2g");
        const ordersCollection = db.collection("w2g_orders");
        const syncMetaCollection = db.collection("w2g_sync_meta");

        await ordersCollection.createIndex({ orderId: 1 }, { unique: true });

        const RATE_LIMIT_DELAY = 200;
        const MAX_PAGES = 100000;
        const DETAIL_BATCH_SIZE = 50;
        const DB_RETRY_ATTEMPTS = 3;

        if (forceRestart) {
            console.log(`[W2G API] Force restart requested — clearing all sync state...`);
            await syncMetaCollection.deleteOne({ merchantId, type: 'full_sync' });
        }

        let syncState = await syncMetaCollection.findOne({ merchantId, type: 'full_sync' }) || {
            lastProcessedPage: 0,
            lastProcessedOrderIndex: 0,
            totalOrderIds: [],
            failedOrderIds: [],
            status: 'idle'
        };

        let orderIdsToFetch: string[] = [];
        
        if (retryFailedOnly) {
            if (!syncState.failedOrderIds || syncState.failedOrderIds.length === 0) {
                console.log(`[W2G API] No failed orders to retry.`);
                return { message: 'No failed orders to retry.' };
            }
            orderIdsToFetch = syncState.failedOrderIds;
            console.log(`[W2G API] Retry mode: Processing ${orderIdsToFetch.length} failed orders...`);
        } else {
            if (syncState.status === 'completed' && !forceRestart) {
                console.log(`[W2G API] Previous sync completed. Starting fresh...`);
                await syncMetaCollection.deleteOne({ merchantId, type: 'full_sync' });
                syncState = {
                    lastProcessedPage: 0,
                    lastProcessedOrderIndex: 0,
                    totalOrderIds: [],
                    failedOrderIds: [],
                    status: 'idle'
                };
            }

            let startPage = (syncState.lastProcessedPage || 0) + 1;
            orderIdsToFetch = syncState.totalOrderIds || [];
            let hasMorePages = true;
            let page = startPage;

            // Phase 1: Fetch all order IDs from list
            if (orderIdsToFetch.length === 0) {
                console.log(`[W2G API] Phase 1: Collecting all order IDs...`);
                orderIdsToFetch = [];
                page = 1;

                while (hasMorePages && page <= MAX_PAGES) {
                    console.log(`[W2G API] Fetching order list page ${page}...`);

                    let response;
                    let retries = 3;

                    while (retries > 0) {
                        try {
                            response = await axios({
                                method: 'get',
                                url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/orders`,
                                auth: { username, password },
                                params: { page: page, pageSize: 100 },
                                timeout: 30000
                            });
                            break;
                        } catch (apiError: any) {
                            retries--;
                            if (retries === 0) throw apiError;
                            console.warn(`⚠️ API error on page ${page}, retrying... (${apiError.message})`);
                            await new Promise(r => setTimeout(r, (3 - retries) * 2000));
                        }
                    }

                    const orders = response?.data?.orders || [];
                    const link = response?.data?.link;

                    for (const order of orders) {
                        orderIdsToFetch.push(order.orderId);
                    }

                    await syncMetaCollection.updateOne(
                        { merchantId, type: 'full_sync' },
                        {
                            $set: {
                                lastProcessedPage: page,
                                totalOrderIds: orderIdsToFetch,
                                updatedAt: new Date()
                            }
                        },
                        { upsert: true }
                    );

                    hasMorePages = !!link && link.includes(`page=${page + 1}`);
                    if (!hasMorePages && orders.length === 50) {
                        hasMorePages = true;
                    }

                    page++;
                    if (hasMorePages) {
                        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
                    }
                }

                console.log(`[W2G API] Collected ${orderIdsToFetch.length} total order IDs`);
            }
        }

        // Phase 2: Categorize orders — check which exist and their status
        console.log(`[W2G API] Phase 2: Checking ${orderIdsToFetch.length} orders in DB...`);

        // Fetch all existing orders with their status in ONE query
        const existingOrders = await ordersCollection.find(
            { orderId: { $in: orderIdsToFetch } },
            { projection: { orderId: 1, status: 1 } }
        ).toArray();

        // Build lookup map: orderId → status
        const existingMap = new Map<string, string>();
        for (const order of existingOrders) {
            existingMap.set(order.orderId, order.status);
        }

        // Categorize
        const idsToFetchDetails: string[] = []; // Need API call
        const idsToSkip: string[] = []; // Already final status
        const idsNew: string[] = []; // Don't exist

        for (const orderId of orderIdsToFetch) {
            const existingStatus = existingMap.get(orderId);

            if (!existingStatus) {
                // New order — fetch details
                idsNew.push(orderId);
                idsToFetchDetails.push(orderId);
            } else {
                // Existing order — check if final status
                const isFinal = FINAL_STATUSES.some(final => 
                    existingStatus.toLowerCase() === final
                );

                if (isFinal) {
                    idsToSkip.push(orderId);
                } else {
                    idsToFetchDetails.push(orderId);
                }
            }
        }

        console.log(`[W2G API] Categorized:`);
        console.log(`   New orders:        ${idsNew.length}`);
        console.log(`   Existing (active): ${idsToFetchDetails.length - idsNew.length}`);
        console.log(`   Existing (final):  ${idsToSkip.length} (skipped)`);

        // Phase 3: Fetch details only for orders that need it
        console.log(`[W2G API] Phase 3: Fetching details for ${idsToFetchDetails.length} orders with ${WORKER_COUNT} workers...`);

        const results = {
            inserted: 0,
            updated: 0,
            skipped: idsToSkip.length,
            errors: 0,
            detailsProcessed: 0,
            failedOrderIds: [] as string[]
        };

        await syncMetaCollection.updateOne(
            { merchantId, type: 'full_sync' },
            { $set: { status: 'running', startedAt: new Date() } },
            { upsert: true }
        );

        async function processBatch(batch: string[], batchIndex: number): Promise<void> {
            for (const orderId of batch) {
                try {
                    const detailResponse = await axios({
                        method: 'get',
                        url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/orders/${orderId}`,
                        auth: { username, password },
                        timeout: 30000
                    });

                    const fullOrder = detailResponse.data;

                    let dbSuccess = false;
                    let dbRetries = DB_RETRY_ATTEMPTS;

                    while (!dbSuccess && dbRetries > 0) {
                        try {
                            const dbResult = await ordersCollection.updateOne(
                                { orderId: orderId },
                                {
                                    $set: { ...fullOrder, _updatedAt: new Date() },
                                    $setOnInsert: { _createdAt: new Date(), _source: 'ware2go_api' }
                                },
                                { upsert: true }
                            );

                            if (dbResult.upsertedCount) {
                                results.inserted++;
                            } else {
                                results.updated++;
                            }

                            dbSuccess = true;

                        } catch (dbError: any) {
                            dbRetries--;
                            if (dbRetries === 0) {
                                results.failedOrderIds.push(orderId);
                                results.errors++;
                                console.error(`❌ [W${batchIndex}] DB unreachable for ${orderId}`);
                                throw dbError;
                            }
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }

                    results.detailsProcessed++;

                } catch (error: any) {
                    if (!results.failedOrderIds.includes(orderId)) {
                        results.errors++;
                        results.failedOrderIds.push(orderId);
                    }
                    console.error(`❌ [W${batchIndex}] Error with ${orderId}:`, error.message);
                }
            }
        }

        const batches: string[][] = [];
        for (let i = 0; i < idsToFetchDetails.length; i += WORKER_COUNT) {
            batches.push(idsToFetchDetails.slice(i, i + WORKER_COUNT));
        }

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            
            await Promise.all(
                batch.map((_, workerIndex) => 
                    processBatch([batch[workerIndex]], workerIndex)
                )
            );

            if (results.detailsProcessed % DETAIL_BATCH_SIZE === 0) {
                await syncMetaCollection.updateOne(
                    { merchantId, type: 'full_sync' },
                    {
                        $set: {
                            lastProcessedOrderIndex: results.detailsProcessed,
                            failedOrderIds: [...(syncState.failedOrderIds || []), ...results.failedOrderIds],
                            updatedAt: new Date()
                        }
                    }
                );
                console.log(`💾 Checkpoint saved at ${results.detailsProcessed}/${idsToFetchDetails.length}`);
            }

            if (i < batches.length - 1) {
                await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
            }
        }

        const allFailedIds = retryFailedOnly 
            ? results.failedOrderIds 
            : [...(syncState.failedOrderIds || []), ...results.failedOrderIds];

        const hasFailures = allFailedIds.length > 0;

        if (!hasFailures) {
            console.log(`[W2G API] All orders processed successfully. Clearing sync metadata...`);
            await syncMetaCollection.deleteOne({ merchantId, type: 'full_sync' });
        } else {
            console.log(`[W2G API] ⚠️ ${allFailedIds.length} orders failed. Keeping metadata for retry...`);
            await syncMetaCollection.updateOne(
                { merchantId, type: 'full_sync' },
                {
                    $set: {
                        status: 'failed',
                        failedOrderIds: allFailedIds,
                        lastProcessedOrderIndex: results.detailsProcessed,
                        completedAt: new Date(),
                        updatedAt: new Date()
                    }
                }
            );
        }

        console.log(`\n📊 Sync Complete:`);
        console.log(`   Total from API:      ${orderIdsToFetch.length}`);
        console.log(`   New orders:          ${idsNew.length}`);
        console.log(`   Active (re-fetched): ${idsToFetchDetails.length - idsNew.length}`);
        console.log(`   Final (skipped):     ${results.skipped}`);
        console.log(`   Inserted:            ${results.inserted}`);
        console.log(`   Updated:             ${results.updated}`);
        console.log(`   Errors:              ${results.errors}`);
        console.log(`   Failed Orders:       ${allFailedIds.length}`);
        console.log(`   Meta Cleared:        ${!hasFailures ? '✅ Yes' : '❌ No — kept for retry'}`);

        return results;

    } catch (error: any) {
        console.error("\n❌ [W2G API] Fatal error:", error.message);
        
        const db = await getDb("ebp_w2g");
        await db.collection("w2g_sync_meta").updateOne(
            { merchantId: process.env.W2G_MERCHANT_ID, type: 'full_sync' },
            { $set: { status: 'error', error: error.message, errorAt: new Date() } },
            { upsert: true }
        );
        
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}
 