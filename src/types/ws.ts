export interface ClientWsEnvelope<T = Record<string, unknown>> {
  type: string;
  requestId: string;
  payload: T;
}

export interface ServerWsResponseOk<T = Record<string, unknown>> {
  type: 'response';
  requestId: string;
  ok: true;
  payload: T;
}

export interface ServerWsResponseErr {
  type: 'response';
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ServerWsEvent<T = Record<string, unknown>> {
  type: 'event';
  event: string;
  payload: T;
}

export type ServerWsEnvelope = ServerWsResponseOk | ServerWsResponseErr | ServerWsEvent;
