/* Drag-and-drop for manual re-assignment: drag an order (an unassigned order or
 * a stop on a route) onto a vehicle to pin it there. Native HTML5 DnD, no dep.
 * The payload is just the order number; a custom MIME type lets drop targets
 * accept only OTTO order drags and ignore everything else. */
export const DRAG_ORDER_MIME = 'application/x-otto-order';

export function setDraggedOrder(e: React.DragEvent, orderNo: string): void {
  e.dataTransfer.setData(DRAG_ORDER_MIME, orderNo);
  e.dataTransfer.setData('text/plain', orderNo); // fallback for inspectors/tooling
  e.dataTransfer.effectAllowed = 'move';
}

/** True if a drag event is carrying an OTTO order (for dragover/drop guards). */
export function isOrderDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(DRAG_ORDER_MIME);
}

/** The dragged order number on drop, or null if the drag is not an OTTO order. */
export function readDraggedOrder(e: React.DragEvent): string | null {
  const v = e.dataTransfer.getData(DRAG_ORDER_MIME);
  return v ? v : null;
}
