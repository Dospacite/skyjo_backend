export interface CreateRoomResponse {
  roomCode: string;
  playerToken: string;
  wsUrl: string;
}

export interface JoinRoomResponse {
  roomCode: string;
  playerToken: string;
  wsUrl: string;
}
