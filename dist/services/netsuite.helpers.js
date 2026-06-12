"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.poExistsInNetSuite = poExistsInNetSuite;
const netsuite_rest_client_1 = require("./netsuite.rest.client");
async function poExistsInNetSuite(poNumber) {
    if (!poNumber)
        return false;
    const q = `otherrefnum IS '${poNumber}'`;
    try {
        const data = await (0, netsuite_rest_client_1.listPurchaseOrders)({ q, limit: 1 });
        // console.log("Po number item found in the net suit ", data);
        const items = Array.isArray(data?.items) ? data.items : (data?.items ? [data.items] : []);
        return items.length > 0;
    }
    catch (err) {
        // console.log("Error in the PO exist in netsuite checking before the bill staging ", err)
        return false;
    }
}
