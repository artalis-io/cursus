import type { Plan, Selection } from '../types';
/** Historical label-only selections are usable only when unambiguous. */
export function selectedUnassigned(orders:Plan['unassigned'],selection:Extract<Selection,{kind:'unassigned'}>){
  if(selection.requestId!==undefined)return orders.find(order=>order.requestId===selection.requestId&&order.orderNo===selection.orderNo);
  const matches=orders.filter(order=>order.orderNo===selection.orderNo);
  return matches.length===1?matches[0]:undefined;
}
