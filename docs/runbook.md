# Runbook

## Environment variables
- `HOST`, `PORT`
- `DATABASE_URL`
- `TOKEN_SECRET`
- `LOG_LEVEL`
- `ROOM_IDLE_TTL_MINUTES`
- `RECONNECT_GRACE_SECONDS`
- `WS_HEARTBEAT_SECONDS`
- `WS_MAX_MESSAGE_BYTES`
- `WS_MESSAGES_PER_SECOND`
- `WS_CONNECTION_RATE_LIMIT_PER_MINUTE`
- `ACTION_REQUEST_TTL_SECONDS`
- `CREATE_JOIN_RATE_LIMIT_PER_MINUTE`
- `ROOM_LOOKUP_RATE_LIMIT_PER_MINUTE`
- `METRICS_RATE_LIMIT_PER_MINUTE`
- `GAME_END_SCORE` (test overrides supported; production should stay `100`)
- `ENABLE_DB`
- `RNG_SEED` (optional deterministic shuffles for testing/debug)
- `DEBUG_LOG_HIDDEN_CARDS` (reserved; hidden card logging remains disabled by default)

## Local operations
- Start DB + app: `docker compose up --build`
- Local Node dev server: `npm install && cp .env.example .env && npm run migrate && npm run dev`
- Tests: `npm test`

## Scaling notes
- Rooms are in-memory and processed with a single-writer queue per room.
- Horizontal scaling requires sticky sessions / room affinity (same room routed to same instance).
- Without Redis pubsub/shared room directory, multi-instance room migration is not supported.
- If Redis is added later, use it for room directory + cross-node event fanout only; keep rules engine authoritative per room instance.

## Reliability / cleanup
- WebSocket heartbeats use ping/pong (`WS_HEARTBEAT_SECONDS`). Dead sockets are terminated.
- Reconnect is allowed during `RECONNECT_GRACE_SECONDS` after disconnect.
- Idle rooms are cleaned after `ROOM_IDLE_TTL_MINUTES` with `room.closed` event.

## Metrics / logging
- Structured JSON logs via Pino-compatible logger.
- Periodic metric log includes:
  - `activeRooms`
  - `activeConnections`
  - `wsMessagesReceived`
  - `wsMessagesSent`
  - `actionErrors`
- `GET /metrics` exposes the same counters as JSON.
- WS action logs include `requestId`, `roomCode`, `seatIndex`, `action`.

## Operational cautions
- Run migrations before app startup in production deployments.
- Keep `TOKEN_SECRET` stable across restarts if reconnect tokens must remain valid.
- Protect WS endpoint behind TLS in production (use `wss://`).
