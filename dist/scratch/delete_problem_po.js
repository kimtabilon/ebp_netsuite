"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_client_1 = require("../services/netsuite.client");
async function run() {
    try {
        const poId = "457907";
        console.log(`Checking related records for PO ID: ${poId}...`);
        const audit = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["record_inspect"],
            recordType: "purchaseorder",
            id: poId
        });
        const related = audit.record_inspect.related_records || [];
        for (const rel of related) {
            if (rel.type === "VendBill") {
                console.log(`Deleting Vendor Bill ${rel.id}...`);
                await (0, netsuite_client_1.callDiagnostic)({ sections: ["delete_record"], recordType: "vendorbill", id: rel.id });
            }
        }
        console.log(`Deleting Purchase Order ${poId}...`);
        const delPo = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["delete_record"],
            recordType: "purchaseorder",
            id: poId
        });
        console.log("PO delete result:", delPo.delete_record);
    }
    catch (e) {
        console.error("Error:", e.message);
    }
}
run();
