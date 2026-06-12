import axios from 'axios';
import * as dotenv from 'dotenv';
import { getDb } from '../config/mongdodb.config';

 
const WORKER_COUNT = 5; 

// export async function syncAllWare2GoInboundShipments(options: { 
//     forceRestart?: boolean; 
//     retryFailedOnly?: boolean;
//     startDate?: string; 
// } = {}) {
//     try {
//         const { 
//             forceRestart = false, 
//             retryFailedOnly = false,
//             startDate = "2021-01-01" // Default: Jan 1, 2026
//         } = options;
        
//         const username = process.env.W2G_USERNAME || '';
//         const password = process.env.W2G_PASSWORD || '';
//         const merchantId = process.env.W2G_MERCHANT_ID || '';

//         if (!username || !password || !merchantId) {
//             throw new Error('Missing required W2G environment variables');
//         }

//         const db = await getDb("ebp_w2g");
//         const inboundsCollection = db.collection("w2g_inbound");
//         const syncMetaCollection = db.collection("w2g_sync_meta");

//         await inboundsCollection.createIndex({ shipmentId: 1 }, { unique: true });

//         const RATE_LIMIT_DELAY = 200;
//         const MAX_PAGES = 100000;
//         const DETAIL_BATCH_SIZE = 50;
//         const DB_RETRY_ATTEMPTS = 3;

//         // If forceRestart, clear everything
//         if (forceRestart) {
//             console.log(`[W2G INBOUND] Force restart requested — clearing all sync state...`);
//             await syncMetaCollection.deleteOne({ merchantId, type: 'inbound_sync' });
//         }

//         // Load last sync state
//         let syncState = await syncMetaCollection.findOne({ merchantId, type: 'inbound_sync' }) || {
//             lastProcessedPage: 0,
//             lastProcessedShipmentIndex: 0,
//             totalShipmentIds: [],
//             failedShipmentIds: [],
//             status: 'idle'
//         };

//         // If retryFailedOnly mode — only process previously failed IDs
//         let shipmentIdsToFetch: string[] = [];
        
//         if (retryFailedOnly) {
//             if (!syncState.failedShipmentIds || syncState.failedShipmentIds.length === 0) {
//                 console.log(`[W2G INBOUND] No failed shipments to retry.`);
//                 return { message: 'No failed shipments to retry.' };
//             }
            
//             shipmentIdsToFetch = syncState.failedShipmentIds;
//             console.log(`[W2G INBOUND] Retry mode: Processing ${shipmentIdsToFetch.length} failed shipments...`);
            
//         } else {
//             // Normal mode: If previously completed, start fresh
//             if (syncState.status === 'completed' && !forceRestart) {
//                 console.log(`[W2G INBOUND] Previous sync completed. Starting fresh with date filter: ${startDate}...`);
//                 await syncMetaCollection.deleteOne({ merchantId, type: 'inbound_sync' });
//                 syncState = {
//                     lastProcessedPage: 0,
//                     lastProcessedShipmentIndex: 0,
//                     totalShipmentIds: [],
//                     failedShipmentIds: [],
//                     status: 'idle'
//                 };
//             }

//             let startPage = (syncState.lastProcessedPage || 0) + 1;
//             shipmentIdsToFetch = syncState.totalShipmentIds || [];
//             let hasMorePages = true;
//             let page = startPage;

//             // Phase 1: Fetch all shipment IDs from list endpoint (with date filter)
//             if (shipmentIdsToFetch.length === 0) {
//                 console.log(`[W2G INBOUND] Phase 1: Collecting shipment IDs from ${startDate} onwards...`);
//                 shipmentIdsToFetch = [];
//                 page = 1;

//                 while (hasMorePages && page <= MAX_PAGES) {
//                     console.log(`[W2G INBOUND] Fetching shipment list page ${page}...`);

//                     let response;
//                     let retries = 3;

//                     while (retries > 0) {
//                         try {
//                             response = await axios({
//                                 method: 'get',
//                                 url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/inbound_shipments`,
//                                 auth: { username, password },
//                                 params: { 
//                                     page: page, 
//                                     pageSize: 100 
//                                 },
//                                 // Date filter in request body
//                                 data: {
//                                     startDate: startDate,
//                                     // endDate: new Date().toISOString().split('T')[0] // Optional: today
//                                 },
//                                 timeout: 30000
//                             });
//                             break;
//                         } catch (apiError: any) {
//                             retries--;
//                             if (retries === 0) throw apiError;
//                             console.warn(`⚠️ API error on page ${page}, retrying... (${apiError.message})`);
//                             await new Promise(r => setTimeout(r, (3 - retries) * 2000));
//                         }
//                     }

//                     const shipments = response?.data?.shipments || response?.data?.inboundShipments || [];
//                     const link = response?.data?.link;

//                     for (const shipment of shipments) {
//                         const id = shipment.shipmentId || shipment.id || shipment.inboundShipmentId;
//                         if (id) shipmentIdsToFetch.push(id);
//                     }

//                     // Save progress after each page
//                     await syncMetaCollection.updateOne(
//                         { merchantId, type: 'inbound_sync' },
//                         {
//                             $set: {
//                                 lastProcessedPage: page,
//                                 totalShipmentIds: shipmentIdsToFetch,
//                                 startDate: startDate,
//                                 updatedAt: new Date()
//                             }
//                         },
//                         { upsert: true }
//                     );

//                     hasMorePages = !!link && link.includes(`page=${page + 1}`);
//                     if (!hasMorePages && shipments.length === 50) {
//                         hasMorePages = true;
//                     }

//                     page++;
//                     if (hasMorePages) {
//                         await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
//                     }
//                 }

//                 console.log(`[W2G INBOUND] Collected ${shipmentIdsToFetch.length} shipment IDs`);
//             }
//         }

//         // Phase 2: Process details with WORKER_COUNT parallel workers
//         console.log(`[W2G INBOUND] Phase 2: Processing ${shipmentIdsToFetch.length} shipments with ${WORKER_COUNT} workers...`);

//         const results = {
//             inserted: 0,
//             updated: 0,
//             skipped: 0,
//             errors: 0,
//             detailsProcessed: retryFailedOnly ? 0 : (syncState.lastProcessedShipmentIndex || 0),
//             failedShipmentIds: [] as string[]
//         };

//         // Update status to running
//         await syncMetaCollection.updateOne(
//             { merchantId, type: 'inbound_sync' },
//             { $set: { status: 'running', startedAt: new Date() } },
//             { upsert: true }
//         );

//         // Worker function: processes a batch of shipments
//         async function processBatch(batch: string[], batchIndex: number): Promise<void> {
//             for (let j = 0; j < batch.length; j++) {
//                 const shipmentId = batch[j];
//                 const globalIndex = batchIndex * WORKER_COUNT + j;

//                 try {
//                     // Fetch full shipment details
//                     const detailResponse = await axios({
//                         method: 'get',
//                         url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/inbound_shipments/${shipmentId}`,
//                         auth: { username, password },
//                         timeout: 30000
//                     });

//                     const fullShipment = detailResponse.data;
//                     const status = fullShipment.status || fullShipment.shipmentStatus || fullShipment.state;

        
//                     // const finalStatuses = ['RECEIVED', 'COMPLETED', 'CLOSED', 'CANCELLED'];
//                     // if (finalStatuses.includes(status)) {
//                     //     results.skipped++;
//                     //     console.log(`⏭️ [W${batchIndex}] Skipped ${shipmentId} (Status: ${status})`);
//                     //     continue;
//                     // }

//                     // Retry DB operations on failure
//                     let dbSuccess = false;
//                     let dbRetries = DB_RETRY_ATTEMPTS;

//                     while (!dbSuccess && dbRetries > 0) {
//                         try {
//                             const dbResult = await inboundsCollection.updateOne(
//                                 { shipmentId: shipmentId },
//                                 {
//                                     $set: { ...fullShipment, _updatedAt: new Date() },
//                                     $setOnInsert: { _createdAt: new Date(), _source: 'ware2go_api' }
//                                 },
//                                 { upsert: true }
//                             );

//                             if (dbResult.upsertedCount) {
//                                 results.inserted++;
//                             } else {
//                                 results.updated++;
//                             }

//                             dbSuccess = true;

//                         } catch (dbError: any) {
//                             dbRetries--;
//                             if (dbRetries === 0) {
//                                 results.failedShipmentIds.push(shipmentId);
//                                 results.errors++;
//                                 console.error(`❌ [W${batchIndex}] DB unreachable for ${shipmentId}`);
//                                 throw dbError;
//                             }
//                             await new Promise(r => setTimeout(r, 2000));
//                         }
//                     }

//                     results.detailsProcessed++;

//                 } catch (error: any) {
//                     if (!results.failedShipmentIds.includes(shipmentId)) {
//                         results.errors++;
//                         results.failedShipmentIds.push(shipmentId);
//                     }
//                     console.error(`❌ [W${batchIndex}] Error with ${shipmentId}:`, error.message);
//                 }
//             }
//         }

//         // Split shipmentIds into batches and run workers in parallel
//         const batches: string[][] = [];
//         for (let i = 0; i < shipmentIdsToFetch.length; i += WORKER_COUNT) {
//             batches.push(shipmentIdsToFetch.slice(i, i + WORKER_COUNT));
//         }

//         // Process batches with WORKER_COUNT concurrent workers
//         for (let i = 0; i < batches.length; i++) {
//             const batch = batches[i];
            
//             // Run all workers in this batch concurrently
//             await Promise.all(
//                 batch.map((_, workerIndex) => 
//                     processBatch([batch[workerIndex]], workerIndex)
//                 )
//             );

//             // Save checkpoint every DETAIL_BATCH_SIZE
//             if (results.detailsProcessed % DETAIL_BATCH_SIZE === 0) {
//                 await syncMetaCollection.updateOne(
//                     { merchantId, type: 'inbound_sync' },
//                     {
//                         $set: {
//                             lastProcessedShipmentIndex: results.detailsProcessed,
//                             failedShipmentIds: [...(syncState.failedShipmentIds || []), ...results.failedShipmentIds],
//                             updatedAt: new Date()
//                         }
//                     }
//                 );
//                 console.log(`💾 Checkpoint saved at ${results.detailsProcessed}/${shipmentIdsToFetch.length}`);
//             }

//             // Rate limit between batches
//             if (i < batches.length - 1) {
//                 await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
//             }
//         }

//         // Merge new failures with previous failures (for retry mode)
//         const allFailedIds = retryFailedOnly 
//             ? results.failedShipmentIds 
//             : [...(syncState.failedShipmentIds || []), ...results.failedShipmentIds];

//         // Only clear metadata if ALL shipments processed successfully
//         const hasFailures = allFailedIds.length > 0;

//         if (!hasFailures) {
//             console.log(`[W2G INBOUND] All shipments processed successfully. Clearing sync metadata...`);
//             await syncMetaCollection.deleteOne({ merchantId, type: 'inbound_sync' });
//         } else {
//             console.log(`[W2G INBOUND] ⚠️ ${allFailedIds.length} shipments failed. Keeping metadata for retry...`);
//             await syncMetaCollection.updateOne(
//                 { merchantId, type: 'inbound_sync' },
//                 {
//                     $set: {
//                         status: 'failed',
//                         failedShipmentIds: allFailedIds,
//                         lastProcessedShipmentIndex: results.detailsProcessed,
//                         completedAt: new Date(),
//                         updatedAt: new Date()
//                     }
//                 }
//             );
//         }

//         console.log(`\n📊 Inbound Sync Complete:`);
//         console.log(`   Total Shipment IDs:    ${shipmentIdsToFetch.length}`);
//         console.log(`   Details Processed:     ${results.detailsProcessed}`);
//         console.log(`   Inserted:              ${results.inserted}`);
//         console.log(`   Updated:               ${results.updated}`);
//         console.log(`   Skipped (Final Status):${results.skipped}`);
//         console.log(`   Errors:                ${results.errors}`);
//         console.log(`   Failed Shipments:      ${allFailedIds.length}`);
//         console.log(`   Meta Cleared:          ${!hasFailures ? '✅ Yes' : '❌ No — kept for retry'}`);

//         return results;

//     } catch (error: any) {
//         console.error("\n❌ [W2G INBOUND] Fatal error:", error.message);
        
//         const db = await getDb("w2g_inbound");
//         await db.collection("w2g_sync_meta").updateOne(
//             { merchantId: process.env.W2G_MERCHANT_ID, type: 'inbound_sync' },
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

 

 
 

 
export async function syncAllWare2GoInboundShipments(options: { 
    forceRestart?: boolean; 
    retryFailedOnly?: boolean;
    startDate?: string | null;
    all?:boolean
} = {}) {
    try {
        const { 
            forceRestart = false, 
            retryFailedOnly = false,
            startDate = null,
            all=false
        } = options;
        
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
        const inboundsCollection = db.collection("w2g_inbound");
        const syncMetaCollection = db.collection("w2g_sync_meta");

        await inboundsCollection.createIndex({ shipmentId: 1 }, { unique: true });

        const RATE_LIMIT_DELAY = 200;
        const MAX_PAGES = 100000;
        const DETAIL_BATCH_SIZE = 50;
        const DB_RETRY_ATTEMPTS = 3;

        if (forceRestart) {
            console.log(`[W2G INBOUND] Force restart requested — clearing all sync state...`);
            await syncMetaCollection.deleteOne({ merchantId, type: 'inbound_sync' });
        }

        let syncState = await syncMetaCollection.findOne({ merchantId, type: 'inbound_sync' }) || {
            lastProcessedPage: 0,
            lastProcessedShipmentIndex: 0,
            totalShipmentIds: [],
            failedShipmentIds: [],
            status: 'idle'
        };

        let shipmentIdsToFetch: string[] = [];
        
        if (retryFailedOnly) {
            if (!syncState.failedShipmentIds || syncState.failedShipmentIds.length === 0) {
                console.log(`[W2G INBOUND] No failed shipments to retry.`);
                return { message: 'No failed shipments to retry.' };
            }
            
            shipmentIdsToFetch = syncState.failedShipmentIds;
            console.log(`[W2G INBOUND] Retry mode: Processing ${shipmentIdsToFetch.length} failed shipments...`);
            
        } else {
            if (syncState.status === 'completed' && !forceRestart) {
                console.log(`[W2G INBOUND] Previous sync completed. Starting fresh${startDate ? ` from ${startDate}` : ' (all records)'}...`);
                await syncMetaCollection.deleteOne({ merchantId, type: 'inbound_sync' });
                syncState = {
                    lastProcessedPage: 0,
                    lastProcessedShipmentIndex: 0,
                    totalShipmentIds: [],
                    failedShipmentIds: [],
                    status: 'idle'
                };
            }

            let startPage = (syncState.lastProcessedPage || 0) + 1;
            shipmentIdsToFetch = syncState.totalShipmentIds || [];
            let hasMorePages = true;
            let page = startPage;

            if (shipmentIdsToFetch.length === 0) {
                console.log(`[W2G INBOUND] Phase 1: Collecting shipment IDs${startDate ? ` from ${startDate} onwards` : ' (all records)'}...`);
                shipmentIdsToFetch = [];
                page = 1;

                while (hasMorePages && page <= MAX_PAGES) {
                    console.log(`[W2G INBOUND] Fetching shipment list page ${page}...`);

                    let response;
                    let retries = 3;

                    while (retries > 0) {
                        try {
                            const axiosConfig: any = {
                                method: 'get',
                                url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/inbound_shipments`,
                                auth: { username, password },
                                params: { page: page, pageSize: 100 },
                                timeout: 30000
                            };

                            if (startDate) {
                                axiosConfig.data = {
                                    startDate: new Date(startDate).toISOString()
                                };
                            }

                            response = await axios(axiosConfig);
                            break;
                        } catch (apiError: any) {
                            retries--;
                            if (retries === 0) throw apiError;
                            console.warn(`⚠️ API error on page ${page}, retrying... (${apiError.message})`);
                            await new Promise(r => setTimeout(r, (3 - retries) * 2000));
                        }
                    }

                    const shipments = response?.data?.shipments || response?.data?.inboundShipments || [];
                    const link = response?.data?.link;

                    for (const shipment of shipments) {
                        const id = shipment.shipmentId || shipment.id || shipment.inboundShipmentId;
                        if (id) shipmentIdsToFetch.push(id);
                    }

                    await syncMetaCollection.updateOne(
                        { merchantId, type: 'inbound_sync' },
                        {
                            $set: {
                                lastProcessedPage: page,
                                totalShipmentIds: shipmentIdsToFetch,
                                ...(startDate && { startDate: startDate }),
                                updatedAt: new Date()
                            }
                        },
                        { upsert: true }
                    );

                    hasMorePages = !!link && link.includes(`page=${page + 1}`);
                    if (!hasMorePages && shipments.length === 50) {
                        hasMorePages = true;
                    }

                    page++;
                    if (hasMorePages) {
                        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
                    }
                }

                console.log(`[W2G INBOUND] Collected ${shipmentIdsToFetch.length} shipment IDs`);
            }
        }

        // Phase 2: Categorize shipments — check which exist and their status
        console.log(`[W2G INBOUND] Phase 2: Checking ${shipmentIdsToFetch.length} shipments in DB...`);

        const existingShipments = await inboundsCollection.find(
            { shipmentId: { $in: shipmentIdsToFetch } },
            { projection: { shipmentId: 1, status: 1 } }
        ).toArray();

        const existingMap = new Map<string, string>();
        for (const shipment of existingShipments) {
            existingMap.set(shipment.shipmentId, shipment.status);
        }

        const idsToFetchDetails: string[] = [];
        const idsToSkip: string[] = [];
        const idsNew: string[] = [];

        for (const shipmentId of shipmentIdsToFetch) {
            const existingStatus = existingMap.get(shipmentId);

            if (!existingStatus) {
                idsNew.push(shipmentId);
                idsToFetchDetails.push(shipmentId);
            } else {
                const isFinal = FINAL_STATUSES.some(final => 
                    existingStatus.toLowerCase() === final
                );

                if (isFinal) {
                    idsToSkip.push(shipmentId);
                } else {
                    idsToFetchDetails.push(shipmentId);
                }
            }
        }

        console.log(`[W2G INBOUND] Categorized:`);
        console.log(`   New shipments:     ${idsNew.length}`);
        console.log(`   Existing (active): ${idsToFetchDetails.length - idsNew.length}`);
        console.log(`   Existing (final):  ${idsToSkip.length} (skipped)`);

        // Phase 3: Fetch details only for shipments that need it
        console.log(`[W2G INBOUND] Phase 3: Fetching details for ${idsToFetchDetails.length} shipments with ${WORKER_COUNT} workers...`);

        const results = {
            inserted: 0,
            updated: 0,
            skipped: idsToSkip.length,
            errors: 0,
            detailsProcessed: 0,
            failedShipmentIds: [] as string[],
            totalApiTime: 0,
            totalDbTime: 0,
            totalCount: 0
        };

        await syncMetaCollection.updateOne(
            { merchantId, type: 'inbound_sync' },
            { $set: { status: 'running', startedAt: new Date() } },
            { upsert: true }
        );

        async function processBatch(batch: string[], batchIndex: number): Promise<void> {
            for (const shipmentId of batch) {
                const apiStartTime = Date.now();
                let apiTime = 0;
                let dbTime = 0;

                try {
                    // Fetch full shipment details
                    const detailResponse = await axios({
                        method: 'get',
                        url: `https://openapi.ware2go.io/v1/merchants/${merchantId}/inbound_shipments/${shipmentId}`,
                        auth: { username, password },
                        timeout: 30000
                    });

                    apiTime = Date.now() - apiStartTime;

                    const fullShipment = detailResponse.data;

                    // Check rate limit headers if available
                    const rateLimitRemaining = detailResponse.headers['x-ratelimit-remaining'];
                    const rateLimitReset = detailResponse.headers['x-ratelimit-reset'];

                    const dbStartTime = Date.now();

                    let dbSuccess = false;
                    let dbRetries = DB_RETRY_ATTEMPTS;

                    while (!dbSuccess && dbRetries > 0) {
                        try {
                            const dbResult = await inboundsCollection.updateOne(
                                { shipmentId: shipmentId },
                                {
                                    $set: { ...fullShipment, _updatedAt: new Date() },
                                    $setOnInsert: { _createdAt: new Date(), _source: 'ware2go_api' }
                                },
                                { upsert: true }
                            );

                            dbTime = Date.now() - dbStartTime;

                            if (dbResult.upsertedCount) {
                                results.inserted++;
                            } else {
                                results.updated++;
                            }

                            dbSuccess = true;

                        } catch (dbError: any) {
                            dbRetries--;
                            if (dbRetries === 0) {
                                results.failedShipmentIds.push(shipmentId);
                                results.errors++;
                                console.error(`❌ [W${batchIndex}] DB unreachable for ${shipmentId}`);
                                throw dbError;
                            }
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }

                    results.detailsProcessed++;
                    results.totalApiTime += apiTime;
                    results.totalDbTime += dbTime;
                    results.totalCount++;

                    // Log every shipment with timing
                    const avgApiTime = Math.round(results.totalApiTime / results.totalCount);
                    const avgDbTime = Math.round(results.totalDbTime / results.totalCount);
                    
                    console.log(
                        `✅ [W${batchIndex}] ${shipmentId} | ` +
                        `API: ${apiTime}ms | DB: ${dbTime}ms | ` +
                        `Avg API: ${avgApiTime}ms | Avg DB: ${avgDbTime}ms` +
                        `${rateLimitRemaining ? ` | RateLimit: ${rateLimitRemaining}` : ''}`
                    );

                } catch (error: any) {
                    apiTime = Date.now() - apiStartTime;
                    
                    if (error.response?.status === 401) {
                        console.error(`❌ [W${batchIndex}] Auth error (401) for ${shipmentId} — skipping`);
                    }
                    
                    if (!results.failedShipmentIds.includes(shipmentId)) {
                        results.errors++;
                        results.failedShipmentIds.push(shipmentId);
                    }
                    console.error(`❌ [W${batchIndex}] Error with ${shipmentId}:`, error.message);
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
                    { merchantId, type: 'inbound_sync' },
                    {
                        $set: {
                            lastProcessedShipmentIndex: results.detailsProcessed,
                            failedShipmentIds: [...(syncState.failedShipmentIds || []), ...results.failedShipmentIds],
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

        // Print timing summary
        if (results.totalCount > 0) {
            const totalTime = results.totalApiTime + results.totalDbTime;
            console.log(`\n⏱️ Timing Summary:`);
            console.log(`   Total API time: ${results.totalApiTime}ms (avg: ${Math.round(results.totalApiTime / results.totalCount)}ms)`);
            console.log(`   Total DB time:  ${results.totalDbTime}ms (avg: ${Math.round(results.totalDbTime / results.totalCount)}ms)`);
            console.log(`   Total combined: ${totalTime}ms (avg: ${Math.round(totalTime / results.totalCount)}ms)`);
            console.log(`   Throughput:     ${Math.round(results.totalCount / (totalTime / 1000))} shipments/second`);
        }

        const allFailedIds = retryFailedOnly 
            ? results.failedShipmentIds 
            : [...(syncState.failedShipmentIds || []), ...results.failedShipmentIds];

        const hasFailures = allFailedIds.length > 0;

        if (!hasFailures) {
            console.log(`[W2G INBOUND] All shipments processed successfully. Clearing sync metadata...`);
            await syncMetaCollection.deleteOne({ merchantId, type: 'inbound_sync' });
        } else {
            console.log(`[W2G INBOUND] ⚠️ ${allFailedIds.length} shipments failed. Keeping metadata for retry...`);
            await syncMetaCollection.updateOne(
                { merchantId, type: 'inbound_sync' },
                {
                    $set: {
                        status: 'failed',
                        failedShipmentIds: allFailedIds,
                        lastProcessedShipmentIndex: results.detailsProcessed,
                        completedAt: new Date(),
                        updatedAt: new Date()
                    }
                }
            );
        }

        console.log(`\n📊 Inbound Sync Complete:`);
        console.log(`   Total from API:      ${shipmentIdsToFetch.length}`);
        console.log(`   New shipments:       ${idsNew.length}`);
        console.log(`   Active (re-fetched): ${idsToFetchDetails.length - idsNew.length}`);
        console.log(`   Final (skipped):     ${results.skipped}`);
        console.log(`   Inserted:            ${results.inserted}`);
        console.log(`   Updated:             ${results.updated}`);
        console.log(`   Errors:              ${results.errors}`);
        console.log(`   Failed Shipments:    ${allFailedIds.length}`);
        console.log(`   Meta Cleared:        ${!hasFailures ? '✅ Yes' : '❌ No — kept for retry'}`);

        return results;

    } catch (error: any) {
        console.error("\n❌ [W2G INBOUND] Fatal error:", error.message);
        
        const db = await getDb("w2g_inbound");
        await db.collection("w2g_sync_meta").updateOne(
            { merchantId: process.env.W2G_MERCHANT_ID, type: 'inbound_sync' },
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

[
    {
        kitSku:"C3210C0C3210K0C3210M0C3210Y0",
        kitSerialNumber:["123","12121","323231"],
        itemSku:[
            {item:"C3210CO",serialNumber:["1313","32232","32322"]},
            {item:"C3210K0",serialNumber:["1313","32232","32322"]},
            {item:"C3210M0",serialNumber:["1313","32232","32322"]},
        ]
    }
]