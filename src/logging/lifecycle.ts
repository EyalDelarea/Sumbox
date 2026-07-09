import { getLogger } from "./log.js";

/** System-state transitions worth recording for the history timeline (data-model.md). */
export type LifecycleEvent =
  | "boot"
  | "ready"
  | "shutdown"
  | "collector.connected"
  | "collector.disconnected"
  | "reconnect.armed"
  | "reconnect.done";

/**
 * Emit a lifecycle event under the 'lifecycle' component. These power the Grafana
 * "System Lifecycle" panel so restarts/connects are visible at a glance.
 */
export function logLifecycle(event: LifecycleEvent, fields: Record<string, unknown> = {}): void {
  getLogger("lifecycle").info({ event, ...fields }, event);
}
