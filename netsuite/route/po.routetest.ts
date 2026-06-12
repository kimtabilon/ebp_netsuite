import { Router } from "express";
import log from "../config/logger.config";
 
 
import {
    listPurchaseOrders, 
    fetchAllPurchaseOrders,
    hydratePurchaseOrdersFromListRows, 
    normalizePurchaseOrderListItems,
    restListWantDetails,
    nsRestFetchUntilExhaustedCap,
    PURCHASE_ORDER_FETCH_ALL_DEFAULT_MAX,
    PURCHASE_ORDER_FETCH_ALL_ABS_MAX,
    PURCHASE_ORDER_LIST_DEFAULT_LIMIT,
    PURCHASE_ORDER_LIST_ABS_MAX,
} from "../services/netsuite.rest.client";
 
import {   shouldRunBaselineCompareWithPersist } from "../services/ns_rest_compare.service";
 
 
const router = Router();

