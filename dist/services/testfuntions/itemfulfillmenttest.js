"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteItemReceiptsInNetSuite = deleteItemReceiptsInNetSuite;
const mongdodb_config_1 = require("../../config/mongdodb.config");
const dotenv_1 = __importDefault(require("dotenv"));
const netsuite_rest_client_1 = require("../netsuite.rest.client");
const axios_1 = __importDefault(require("axios"));
dotenv_1.default.config();
const ACCOUNT = process.env.NS_ACCOUNT_ID;
const BASE_URL = `https://${ACCOUNT.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
const delay = (ms) => new Promise(res => setTimeout(res, ms));
const array2 = [
    230758, 230712, 233720, 233718, 233719, 233323, 233045, 233053, 233055, 233063,
    232958, 232957, 232971, 232956, 232955, 232954, 232953, 232952, 232773, 232743,
    232425, 232453, 232451, 231762, 231353, 230937, 230911, 230791, 230871, 230600,
    230425, 230324, 230325, 230085, 230084, 230087, 230086, 230083, 229890, 229769,
    229607, 229659, 229469, 229268, 229271, 228997, 229105, 228675, 228386, 228359,
    228080, 227962, 227884, 227712, 227704, 227759, 227719, 227580, 227602, 227508,
    227339, 227217, 227218, 227190, 227122, 227032, 227028, 227121, 227123, 227006,
    226948, 226993, 226912, 226835, 226836, 226732, 226733, 226644, 226536, 226533,
    226534, 226361, 226252, 226160, 226100, 226105, 226057, 226029, 226047, 226032,
    226019, 226034, 225989, 225991, 225992, 225950, 225967, 225899, 225945, 225951,
    225963, 225985, 225843, 225778, 225735, 225621, 225716, 225569, 231898, 225523,
    225603, 225653, 225477, 225476, 225483, 225434, 225458, 225411, 225451, 225299,
    225310, 225323, 225388, 225293, 225387, 225319, 225386, 225389, 225272, 225258,
    225276, 225214, 225227, 225233, 225229, 225243, 225235, 225237, 225032, 225038,
    225033, 225154, 225145, 225165, 225042, 225043, 225077, 225104, 225110, 225136,
    225133, 225162, 225023, 225134, 225155, 225153, 225010, 225009, 224958, 224962,
    225018, 224952, 224957, 224940, 224911, 224928, 224840, 224864, 224842, 224826,
    224843, 224850, 224801, 224776, 224759, 224785, 224811, 224761, 224766, 224779,
    224800, 224760, 224786, 224780, 224715, 224700, 224697, 224699, 224708, 224701,
    224705, 224716, 224714, 224704, 224729, 224750, 224756, 224734, 224693, 224725,
    224727, 224740, 224744, 224499, 224498, 224519, 224598, 224592, 224590, 224599,
    224613, 224614, 224492, 224494, 224491, 224523, 224536, 224527, 224561, 224583,
    224588, 224597, 224596, 224685, 224630, 224625, 224624, 224502, 224497, 224567,
    224534, 224604, 224386, 224405, 224404, 224412, 224440, 224442, 224416, 224454,
    224477, 224484, 224388, 224446, 224479, 224400, 224385, 224394, 224406, 224374,
    224381, 224399, 224407, 224408, 224424, 224410, 224434, 224436, 224487, 224481,
    224482, 224372, 224403, 224392, 224423, 224438, 224463, 224466, 224301, 224322,
    224315, 224318, 224346, 224299, 224303, 224359, 224296, 224307, 224302
];
const itemReceiptToDelete = [
    "IR00115", "IR00263", "IR00268", "IR00325", "IR00326", "IR00324", "IR00118", "IR00119", "IR00267", "IR00321",
    "IR00172", "IR00319", "IR00320", "IR00327", "IR00328", "IR00329", "IR00330", "IR00331", "IR00117", "IR00266",
    "IR00171", "IR00265", "IR00318", "IR00170", "IR00275", "IR00169", "IR00116", "IR00316", "IR00317", "IR00262",
    "IR00261", "IR00167", "IR00168", "IR00114", "IR00259", "IR00274", "IR00315", "IR00323", "IR00258", "IR00257",
    "IR00165", "IR00166", "IR00255", "IR00313", "IR00314", "IR00173", "IR00254", "IR00113", "IR00164", "IR00312",
    "IR00163", "IR00112", "IR00162", "IR00110", "IR00111", "IR00253", "IR00311", "IR00108", "IR00109", "IR00161",
    "IR00160", "IR00159", "IR00252", "IR00273", "IR00107", "IR00157", "IR00158", "IR00250", "IR00251", "IR00106",
    "IR00309", "IR00310", "IR00105", "IR00248", "IR00249", "IR00103", "IR00104", "IR00156", "IR00306", "IR00307",
    "IR00308", "IR00247", "IR00246", "IR00245", "IR00155", "IR00244", "IR00100", "IR00101", "IR00102", "IR00243",
    "IR00271", "IR00272", "IR00154", "IR00240", "IR00242", "IR00098", "IR00099", "IR00236", "IR00237", "IR00238",
    "IR00239", "IR00241", "IR00153", "IR00097", "IR00305", "IR00094", "IR00096", "IR00093", "IR00095", "IR00152",
    "IR00234", "IR00235", "IR00091", "IR00092", "IR00151", "IR00232", "IR00233", "IR00304", "IR00333", "IR00087",
    "IR00088", "IR00089", "IR00090", "IR00149", "IR00150", "IR00229", "IR00230", "IR00231", "IR00086", "IR00228",
    "IR00303", "IR00148", "IR00224", "IR00225", "IR00226", "IR00227", "IR00302", "IR00322", "IR00081", "IR00082",
    "IR00083", "IR00084", "IR00085", "IR00147", "IR00216", "IR00217", "IR00218", "IR00219", "IR00220", "IR00221",
    "IR00222", "IR00223", "IR00298", "IR00299", "IR00300", "IR00301", "IR00214", "IR00215", "IR00144", "IR00145",
    "IR00146", "IR00296", "IR00297", "IR00080", "IR00142", "IR00143", "IR00078", "IR00079", "IR00141", "IR00211",
    "IR00212", "IR00213", "IR00076", "IR00077", "IR00138", "IR00139", "IR00140", "IR00207", "IR00208", "IR00209",
    "IR00210", "IR00293", "IR00294", "IR00295", "IR00070", "IR00071", "IR00072", "IR00073", "IR00074", "IR00075",
    "IR00131", "IR00132", "IR00133", "IR00134", "IR00135", "IR00136", "IR00137", "IR00206", "IR00288", "IR00289",
    "IR00290", "IR00291", "IR00292", "IR00066", "IR00067", "IR00068", "IR00069", "IR00126", "IR00127", "IR00128",
    "IR00129", "IR00130", "IR00191", "IR00192", "IR00193", "IR00194", "IR00195", "IR00196", "IR00197", "IR00198",
    "IR00199", "IR00200", "IR00201", "IR00202", "IR00203", "IR00204", "IR00205", "IR00283", "IR00284", "IR00285",
    "IR00286", "IR00287", "IR00056", "IR00057", "IR00058", "IR00059", "IR00060", "IR00061", "IR00062", "IR00063",
    "IR00064", "IR00065", "IR00123", "IR00124", "IR00125", "IR00176", "IR00177", "IR00178", "IR00179", "IR00180",
    "IR00181", "IR00182", "IR00183", "IR00184", "IR00185", "IR00186", "IR00187", "IR00188", "IR00189", "IR00190",
    "IR00270", "IR00276", "IR00277", "IR00278", "IR00279", "IR00280", "IR00281", "IR00282", "IR00051", "IR00052",
    "IR00053", "IR00054", "IR00055", "IR00120", "IR00121", "IR00122", "IR00174", "IR00175", "IR00269"
];
async function deleteItemReceiptsInNetSuite() {
    console.log(`Targeting ${itemReceiptToDelete.length} Item Receipts for deletion...`);
    try {
        const db = await (0, mongdodb_config_1.getDb)("netsuite");
        const collection = db.collection("dump_items_receipt");
        // Fetch the internal IDs for these tranids from the local dump
        const receipts = await collection.find({ tranid: { $in: itemReceiptToDelete } }, { projection: { tranid: 1, ns_internal_id: 1 } }).toArray();
        console.log(`Found ${receipts.length} matching internal IDs in MongoDB.`);
        let successCount = 0;
        let failCount = 0;
        for (let i = 0; i < receipts.length; i++) {
            const doc = receipts[i];
            const internalId = doc.ns_internal_id;
            const url = `${BASE_URL}/services/rest/record/v1/itemreceipt/${internalId}`;
            try {
                await axios_1.default.delete(url, {
                    headers: {
                        Authorization: (0, netsuite_rest_client_1.buildOAuthHeader)(url, "DELETE"),
                        "Content-Type": "application/json"
                    }
                });
                console.log(`[${i + 1}/${receipts.length}] ✅ Deleted ${doc.tranid} (ID: ${internalId})`);
                successCount++;
                // Optionally remove it from the local dump
                await collection.deleteOne({ _id: doc._id });
            }
            catch (err) {
                console.error(`[${i + 1}/${receipts.length}] ❌ Failed to delete ${doc.tranid} (ID: ${internalId}):`, err.response?.data || err.message);
                failCount++;
            }
            // Sleep to avoid rate limits
            await delay(300);
        }
        console.log(`\n==========================================`);
        console.log(`🏁 DELETION COMPLETE`);
        console.log(`✅ Successfully deleted: ${successCount}`);
        console.log(`❌ Failed to delete: ${failCount}`);
        console.log(`==========================================`);
    }
    catch (error) {
        console.error("Critical error during deletion process:", error);
    }
    finally {
        process.exit(0);
    }
}
