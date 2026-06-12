"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_client_1 = require("../services/netsuite.client");
async function deletePOs() {
    // 1. Paste the POs you want to delete here (excluding the 14 with vendor bills)
    const targetPOs = [
        "PO231938",
        "PO231937",
        "PO231936",
        "PO231941",
        "PO231940",
        "PO231939",
        "PO228007",
        "PO228006",
        "PO228005",
        "PO226631",
        "PO226628",
        "PO226627",
        "PO226630",
        "PO226626",
        "PO226629",
        "PO225748",
        "PO225747",
        "PO225746",
        "PO233280",
        "PO233279",
        "PO233278",
        "PO233273",
        "PO233272",
        "PO233274",
        "PO233271",
        "PO233268",
        "PO233267",
        "PO233266",
        "PO233388",
        "PO233277",
        "PO233276",
        "PO233275",
        "PO233270",
        "PO233269",
        "PO233265",
        "PO233264",
        "PO228202",
        "PO227681",
        "PO227804",
        "PO228037",
        "PO228036",
        "PO227510",
        "PO227483",
        "PO225459",
        "PO225458",
        "PO224649",
        "PO224646",
        "PO224648",
        "PO224645",
        "PO224647",
        "PO224643",
        "PO224642",
        "PO224641",
        "PO224640",
        "PO233083",
        "PO233077",
        "PO233082",
        "PO233065",
        "PO233078",
        "PO233064",
        "PO233059",
        "PO232423",
        "PO229308",
        "PO227704",
        "PO225899",
        "PO227580",
        "PO225477",
        "PO225411",
        "PO227121",
        "PO228590",
        "PO228476",
        "PO225545",
        "PO225463",
        "PO225548",
        "PO224655",
        "PO224652",
        "PO224654",
        "PO224651",
        "PO224653",
        "PO224650",
        "PO224639",
        "PO224638",
        "PO231279",
        "PO233102",
        "PO233085",
        "PO233084",
        "PO228359",
        "PO225243",
        "PO224466",
        "PO225233",
        "PO224442",
        "PO224785",
        "PO233387"
    ];
    if (targetPOs.length === 0) {
        console.log("No POs provided. Exiting.");
        return;
    }
    try {
        console.log(`Sending delete request to NetSuite for ${targetPOs.length} POs...`);
        // Break into batches of 10 to avoid timeouts
        const BATCH_SIZE = 10;
        let successCount = 0;
        let failCount = 0;
        for (let i = 0; i < targetPOs.length; i += BATCH_SIZE) {
            const batch = targetPOs.slice(i, i + BATCH_SIZE);
            // Construct the payload required by our new cleanup RESTlet action
            const payload = {
                action: "delete_pos_by_number",
                poNumbers: batch
            };
            console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(targetPOs.length / BATCH_SIZE)}...`);
            const response = await (0, netsuite_client_1.callCleanup)(payload);
            // Handle response
            if (response && response.success && response.data) {
                const data = response.data;
                successCount += data.summary.deletedCount;
                failCount += data.summary.errorCount;
                if (data.deletedList && data.deletedList.length > 0) {
                    data.deletedList.forEach((del) => {
                        console.log(`✅ Deleted: ${del.number} (Internal ID: ${del.id})`);
                    });
                }
                if (data.failedList && data.failedList.length > 0) {
                    data.failedList.forEach((err) => {
                        console.log(`❌ Failed: ${err.number || err.id} - ${err.error}`);
                    });
                }
            }
            else {
                console.log("⚠️ Unexpected response format or error:", response);
            }
        }
        console.log(`\n🎉 Deletion Complete!`);
        console.log(`Successfully deleted: ${successCount}`);
        console.log(`Failed to delete: ${failCount}`);
        console.log(`\nNext Step: Run 'npx tsx netsuite/scratch/reset_pos_for_sync.ts' to reset MongoDB flags.`);
    }
    catch (error) {
        console.error("❌ Error deleting POs:", error);
    }
    finally {
        process.exit(0);
    }
}
deletePOs();
