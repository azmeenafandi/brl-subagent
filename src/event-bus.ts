import type { SubagentEvent, SubagentEventType, SubagentEventListener } from './types';

// Event listeners by type
const listeners = new Map<SubagentEventType, Set<SubagentEventListener>>();

// Global listeners (receive all events)
const globalListeners = new Set<SubagentEventListener>();

/**
 * Subscribe a listener to a specific event type.
 *
 * @param type - The event type to subscribe to
 * @param listener - The listener invoked for each event of this type
 */
export function on(type: SubagentEventType, listener: SubagentEventListener): void {
	let typeListeners = listeners.get(type);
	if (!typeListeners) {
		typeListeners = new Set();
		listeners.set(type, typeListeners);
	}
	typeListeners.add(listener);
}

/**
 * Unsubscribe a listener from a specific event type.
 *
 * @param type - The event type to unsubscribe from
 * @param listener - The listener to remove
 */
export function off(type: SubagentEventType, listener: SubagentEventListener): void {
	const typeListeners = listeners.get(type);
	if (!typeListeners) return;
	typeListeners.delete(listener);
	if (typeListeners.size === 0) listeners.delete(type);
}

/**
 * Emit an event
 * 
 * @param event - The event to emit
 */
export function emit(event: SubagentEvent): void {
  // Notify type-specific listeners
  const typeListeners = listeners.get(event.type);
  if (typeListeners) {
    for (const listener of typeListeners) {
      try {
        listener(event);
      } catch (err) {
        // Don't let listener errors break the event loop
        console.error(`[event-bus] Listener error for ${event.type}:`, err);
      }
    }
  }
  
  // Notify global listeners
  for (const listener of globalListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(`[event-bus] Global listener error:`, err);
    }
  }
}


/**
 * Create a SubagentEvent helper
 * 
 * @param type - The event type
 * @param agentId - The agent ID
 * @param data - Additional event data
 * @returns SubagentEvent object
 */
export function createEvent(
  type: SubagentEventType,
  agentId: string,
  data: Record<string, unknown> = {}
): SubagentEvent {
  return {
    type,
    agentId,
    timestamp: Date.now(),
    data,
  };
}
