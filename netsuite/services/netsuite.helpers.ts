import { listPurchaseOrders } from "./netsuite.rest.client";
export async function poExistsInNetSuite(poNumber: string | number): Promise<boolean> {
    if (!poNumber) return false;
    
    const q = `otherrefnum IS '${poNumber}'`;
    try {
        const data = await listPurchaseOrders({ q, limit: 1 });
        // console.log("Po number item found in the net suit ", data);
        const items = Array.isArray(data?.items) ? data.items : (data?.items ? [data.items] : []);
        return items.length > 0;
    } catch (err) {
        // console.log("Error in the PO exist in netsuite checking before the bill staging ", err)
        return false;
    }
}
