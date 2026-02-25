# HTTP API

Base versioned routes use `/v1`.

## Error format
```json
{ "error": { "code": "STRING_CODE", "message": "Human readable", "details": {} } }
```

## `GET /healthz`
- Returns `200 { "ok": true }`

## `GET /readyz`
- Returns `200 { "ok": true }` when server boot/migrations completed

## `GET /metrics`
- Returns JSON counters (`activeRooms`, `activeConnections`, `wsMessagesReceived`, `wsMessagesSent`, `actionErrors`)

## `POST /v1/rooms`
Create room and host seat.

Request:
```json
{ "displayName": "Alice", "maxPlayers": 4, "rulesVariant": "canonical" }
```

Response `201`:
```json
{ "roomCode": "AB12CD", "playerToken": "...", "wsUrl": "ws://localhost:3000/v1/ws" }
```

## `POST /v1/rooms/:code/join`
Join existing lobby room.

Request:
```json
{ "displayName": "Bob" }
```

Response `200`:
```json
{ "roomCode": "AB12CD", "playerToken": "...", "wsUrl": "ws://localhost:3000/v1/ws" }
```

Status codes:
- `404` room not found
- `409` room full / not joinable

## `GET /v1/rooms/:code`
Returns public room state only (no hidden cards).

Response shape (example):
```json
{
  "roomCode": "AB12CD",
  "status": "IN_ROUND",
  "hostSeatIndex": 0,
  "maxPlayers": 4,
  "rulesVariant": "canonical",
  "players": [
    { "seatIndex": 0, "playerId": "...", "displayName": "Alice", "ready": false, "connected": true }
  ],
  "game": {
    "phase": "PLAYING",
    "currentTurnSeat": 0,
    "turnStage": "AWAITING_ACTION",
    "deckCount": 101,
    "discardTop": 7,
    "players": [
      {
        "seatIndex": 0,
        "layout": [{ "position": 0, "revealed": false, "removed": false, "value": null }]
      }
    ]
  }
}
```

## Rate limiting
- `POST /v1/rooms`
- `POST /v1/rooms/:code/join`
- IP-based rate limiting via Fastify plugin (`CREATE_JOIN_RATE_LIMIT_PER_MINUTE`)
