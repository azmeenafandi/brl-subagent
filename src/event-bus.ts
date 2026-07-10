import type { SubagentEvent, SubagentEventType, SubagentEventListener } from './types';

// Event listeners by type
const listeners = new Map<SubagentEventType, Set<SubagentEventListener>>();

// Global listeners (receive all events)
const globalListeners = new Set<SubagentEventListener>();

/**
 * Subscribe to an event type
 * 
 * @param eventType - The event type to subscribe to
 * @param listener - The callback function
 * @returns Unsubscribe function
 */
export function on(eventType: SubagentEventType, listener: SubagentEventListener): () => void {
  if (!listeners.has(eventType)) {
    listeners.set(eventType, new Set());
  }
  listeners.get(eventType)!.add(listener);
  
  return () => {
    listeners.get(eventType)?.delete(listener);
  };
}

/**
 * Subscribe to all events
 * 
 * @param listener - The callback function
 * @returns Unsubscribe function
 */
export function onAny(listener: SubagentEventListener): () => void {
  globalListeners.add(listener);
  
  return () => {
    globalListeners.delete(listener);
  };
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
 * Subscribe to an event type for one emission only
 * 
 * @param eventType - The event type to subscribe to
 * @param listener - The callback function
 * @returns Unsubscribe function
 */
export function once(eventType: SubagentEventType, listener: SubagentEventListener): () => void {
  const wrappedListener: SubagentEventListener = (event) => {
    // Unsubscribe first
    listeners.get(eventType)?.delete(wrappedListener);
    // Then call the original listener
    listener(event);
  };
  
  return on(eventType, wrappedListener);
}

/**
 * Remove all listeners for an event type
 * 
 * @param eventType - The event type to clear
 */
export function off(eventType: SubagentEventType): void {
  listeners.delete(eventType);
}

/**
 * Remove all listeners (including global)
 */
export function offAll(): void {
  listeners.clear();
  globalListeners.clear();
}

/**
 * Get listener count for an event type (for debugging)
 * 
 * @param eventType - The event type to check
 * @returns Number of listeners
 */
export function listenerCount(eventType: SubagentEventType): number {
  return listeners.get(eventType)?.size ?? 0;
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
