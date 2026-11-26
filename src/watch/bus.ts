// In-process notification that new watcher events were stored. Live-stream subscribers then
// read events newer than the last one they sent. With more than one API process, replace this
// with Postgres LISTEN/NOTIFY (same interface).
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(10_000);

export const notifyNewEvents = () => bus.emit("new");
export function onNewEvents(fn: () => void): () => void {
  bus.on("new", fn);
  return () => bus.off("new", fn);
}
