/* Drag-and-drop for manual re-assignment: drag an order (an unassigned order or
 * a stop on a route) onto a vehicle to pin it there. Native HTML5 DnD, no dep.
 * The payload retains the delivery ID and display reference; a custom MIME type lets drop targets
 * accept only OTTO order drags and ignore everything else. */
import type { DragEvent } from 'react';
export const DRAG_ORDER_MIME = 'application/x-otto-order';
export function deliveryToken(orderNo:string,requestId?:number):string{
 if(requestId!==undefined&&(!Number.isSafeInteger(requestId)||requestId<0))throw new Error('Invalid delivery identity');
 return requestId===undefined?(orderNo.startsWith('@')?`@ref:${encodeURIComponent(orderNo)}`:orderNo):`@delivery:${requestId}:${encodeURIComponent(orderNo)}`;
}
export function deliveryReference(token:string):{orderNo:string;requestId?:number}{
 if(token.startsWith('@ref:'))return {orderNo:decodeURIComponent(token.slice(5))};
 const m=/^@delivery:([0-9]+):(.*)$/.exec(token);
 if(token.startsWith('@delivery:')&&!m)throw new Error('Invalid delivery identity');
 if(!m)return {orderNo:token};
 const requestId=Number(m[1]);if(!Number.isSafeInteger(requestId))throw new Error('Invalid delivery identity');
 return {orderNo:decodeURIComponent(m[2]),requestId};
}

export function setDraggedOrder(e: DragEvent, orderNo: string,requestId?:number): void {
  e.dataTransfer.setData(DRAG_ORDER_MIME, deliveryToken(orderNo,requestId));
  e.dataTransfer.setData('text/plain', orderNo); // fallback for inspectors/tooling
  e.dataTransfer.effectAllowed = 'move';
}

/** True if a drag event is carrying an OTTO order (for dragover/drop guards). */
export function isOrderDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(DRAG_ORDER_MIME);
}

/** The dragged order number on drop, or null if the drag is not an OTTO order. */
export function readDraggedOrder(e: DragEvent): string | null {
  const v = e.dataTransfer.getData(DRAG_ORDER_MIME);
  return v ? v : null;
}
