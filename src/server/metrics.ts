export interface MetricsState {
  activeRooms: number;
  activeConnections: number;
  wsMessagesReceived: number;
  wsMessagesSent: number;
  actionErrors: number;
}

export function createMetrics(): MetricsState {
  return {
    activeRooms: 0,
    activeConnections: 0,
    wsMessagesReceived: 0,
    wsMessagesSent: 0,
    actionErrors: 0,
  };
}
