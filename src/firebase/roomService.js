/**
 * src/firebase/roomService.js
 * Firebase Realtime Database room management: creation, joining, presence, disconnections.
 */

import { getRoomRef, set, get, update, onDisconnect, runTransaction } from './database.js';
import { normalizeRoomCode } from '../game/roomManager.js';
import { addJoinDiagnosticError, createJoinDiagnostic } from './joinDiagnostics.js';

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

function normalizedCodeForMatch(code) {
  return normalizeRoomCode(code);
}

const ROOM_READ_RETRIES = 3;
const ROOM_READ_BACKOFF_MS = 350;

function isRetryableFirebaseError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return code.includes('network')
    || code.includes('unavailable')
    || code.includes('disconnected')
    || message.includes('network')
    || message.includes('disconnected')
    || message.includes('timeout');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRoomWithRetry(roomRef, { expectedPlayerId, onDiagnostic, stage = 'room-read' } = {}) {
  let lastError;
  for (let attempt = 0; attempt < ROOM_READ_RETRIES; attempt += 1) {
    const attemptNumber = attempt + 1;
    onDiagnostic?.(createJoinDiagnostic({ stage, status: 'attempt', attempt: attemptNumber, detail: `Attempt ${attemptNumber} started.` }));
    try {
      const snapshot = await get(roomRef);
      if (snapshot.exists()) {
        const room = snapshot.val();
        if (!expectedPlayerId || room?.players?.[expectedPlayerId]) {
          onDiagnostic?.(createJoinDiagnostic({ stage, status: 'passed', attempt: attemptNumber, detail: `Attempt ${attemptNumber} succeeded.` }));
          return { snapshot, room };
        }
      }
      if (attempt < ROOM_READ_RETRIES - 1) await wait(ROOM_READ_BACKOFF_MS * (attempt + 1));
    } catch (error) {
      lastError = error;
      onDiagnostic?.(createJoinDiagnostic({ stage, error, attempt: attemptNumber }));
      if (!isRetryableFirebaseError(error) || attempt >= ROOM_READ_RETRIES - 1) throw error;
      await wait(ROOM_READ_BACKOFF_MS * (attempt + 1));
    }
  }
  if (lastError) throw lastError;
  onDiagnostic?.(createJoinDiagnostic({ stage, status: 'failed', error: roomNotFoundError('unknown') }));
  return { snapshot: null, room: null };
}

function roomNotFoundError(code) {
  const error = new Error(`Room ${code} was not confirmed on the server. The connection may have dropped before saving. Please retry.`);
  error.code = 'room/not-confirmed';
  return error;
}

/**
 * Creates a new room in Firebase RTDB.
 * @param {object} params
 * @param {string} params.code
 * @param {object} params.hostPlayer
 * @param {string} params.mode
 * @param {string} params.category
 */
export async function createFirebaseRoom({ code, hostPlayer, mode, category }) {
  const normalizedCode = normalizeRoomCode(code);
  const roomRef = getRoomRef(normalizedCode);
  if (!roomRef) throw new Error('Firebase not configured');

  const roomData = {
    matchId: `${normalizedCodeForMatch(code)}:${Date.now()}`,
    hostId: hostPlayer.id,
    status: 'lobby',
    phase: 'lobby',
    mode,
    category,
    round: 1,
    roundId: null,
    totalRounds: 3,
    currentTurnPlayerId: hostPlayer.id,
    timerEndTimestamp: 0,
    createdAt: Date.now(),
    players: {
      [hostPlayer.id]: {
        id: hostPlayer.id,
        name: hostPlayer.name,
      avatar: hostPlayer.avatar,
      isHost: true,
      connected: true,
      score: 0,
      joinOrder: 1,
      },
    },
    usedTargetIds: [],
    scores: { [hostPlayer.id]: 0 },
    messages: {},
    votes: {},
    roundResult: null,
    roundResults: {},
    bracket: null,
    playerAssignments: {},
    matchResults: {},
    standings: [],
  };

  const result = await runTransaction(roomRef, (current) => current ?? roomData);
  if (!result.committed) {
    throw new Error('Room code already exists. Please try again.');
  }

  // Do not treat a locally generated code as a ready room. Confirm the
  // committed room can be read back from Firebase before the UI shares it.
  const confirmed = await readRoomWithRetry(roomRef, { expectedPlayerId: hostPlayer.id });
  if (!confirmed.room?.players?.[hostPlayer.id] || confirmed.room.hostId !== hostPlayer.id) {
    throw roomNotFoundError(normalizedCode);
  }
  return confirmed.room;
}

/**
 * Validates and adds a player to a room, or reconnects an existing player.
 * Existing players may rejoin in ANY phase without resetting room state.
 * @returns {{ room: object, isReconnect: boolean }}
 */
export async function reconnectOrJoinFirebaseRoom({ code, player, onDiagnostic }) {
  const normalizedCode = normalizeRoomCode(code);
  const roomRef = getRoomRef(normalizedCode);
  onDiagnostic?.(createJoinDiagnostic({ stage: 'input-normalization', status: 'passed', detail: 'Room code normalized.' }));
  if (!roomRef) {
    const error = new Error('Firebase not configured.');
    error.code = 'firebase/not-configured';
    throw addJoinDiagnosticError(error, createJoinDiagnostic({ stage: 'firebase-config', error }));
  }

  let snapshot;
  let initialRoom;
  try {
    const readResult = await readRoomWithRetry(roomRef, { onDiagnostic, stage: 'room-read' });
    snapshot = readResult.snapshot;
    initialRoom = readResult.room;
  } catch (error) {
    if (isRetryableFirebaseError(error)) {
      const diagnosticError = new Error('We could not reach the room server. Check your connection and try again.');
      diagnosticError.code = error?.code || 'room/network-unreachable';
      throw addJoinDiagnosticError(diagnosticError, createJoinDiagnostic({ stage: 'room-read', error }));
    }
    throw error;
  }
  if (!snapshot?.exists() || !initialRoom) {
    const error = new Error('Room not found. Check the code and try again.');
    error.code = 'room/not-found';
    throw addJoinDiagnosticError(error, createJoinDiagnostic({ stage: 'room-read', error }));
  }
  onDiagnostic?.(createJoinDiagnostic({ stage: 'room-read', status: 'passed', detail: 'Room exists on the server.' }));

  const initialPlayers = initialRoom.players || {};
  if (initialRoom.removedPlayers?.[player.id]) {
    throw new Error('You were removed from this room.');
  }

  const existingPlayer = initialPlayers[player.id];
  const isReconnect = Boolean(existingPlayer);
  if (!isReconnect && initialRoom.phase !== 'lobby' && initialRoom.phase !== 'results') {
    throw new Error('Game already in progress. Only returning players can rejoin with this code.');
  }

  const newPlayer = {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    isHost: false,
    connected: true,
    score: 0,
  };

  onDiagnostic?.(createJoinDiagnostic({ stage: 'join-transaction', status: 'attempt', detail: 'Join transaction started.' }));
  let result;
  try {
    result = await runTransaction(roomRef, (current) => {
    if (!current) return current;
    const players = current.players || {};

    if (current.removedPlayers?.[player.id]) return current;

    // Reconnects are identity-preserving and allowed in every phase.
    if (players[player.id]) {
      return {
        ...current,
        players: {
          ...players,
          [player.id]: {
            ...players[player.id],
            connected: true,
            name: players[player.id].name ?? player.name,
          },
        },
      };
    }

    // New identities can join only before play starts and only below capacity.
    if (current.phase !== 'lobby' && current.phase !== 'results') return current;
    const maxForRoom = current.mode === '1v1' ? 2 : MAX_PLAYERS;
    if (Object.keys(players).length >= maxForRoom) return current;

    return {
      ...current,
      players: {
        ...players,
        [player.id]: {
          ...newPlayer,
          joinOrder: Object.keys(players).length + 1,
        },
      },
      scores: { ...(current.scores || {}), [player.id]: 0 },
    }
    });
  } catch (error) {
    onDiagnostic?.(createJoinDiagnostic({ stage: 'join-transaction', error }));
    throw addJoinDiagnosticError(error, createJoinDiagnostic({ stage: 'join-transaction', error }));
  }

  const finalRoom = result.snapshot.val();
  onDiagnostic?.(createJoinDiagnostic({ stage: 'join-transaction', status: 'passed', detail: 'Firebase acknowledged the join transaction.' }));
  if (!result.committed || !finalRoom?.players?.[player.id]) {
    const latestPhase = finalRoom?.phase ?? initialRoom.phase;
    const latestCount = Object.keys(finalRoom?.players || {}).length;
    if (latestPhase !== 'lobby' && latestPhase !== 'results') {
      throw new Error('Game already in progress. Only returning players can rejoin with this code.');
    }
    const maxForRoom = finalRoom?.mode === '1v1' || initialRoom.mode === '1v1' ? 2 : MAX_PLAYERS;
    if (latestCount >= maxForRoom) {
      throw new Error('Room is full.');
    }
    throw new Error('Unable to join room safely. Please retry.');
  }

  onDiagnostic?.(createJoinDiagnostic({ stage: 'post-join-verify', status: 'passed', detail: 'The player is present in authoritative room state.' }));
  setupPresence(normalizedCode, player.id);
  return {
    room: finalRoom,
    isReconnect,
  };
}

/** @deprecated Use reconnectOrJoinFirebaseRoom */
export async function joinFirebaseRoom(params) {
  await reconnectOrJoinFirebaseRoom(params);
}

/**
 * Removes one player from a room without deleting the room.
 * The tombstone prevents that player from reconnecting to the old room.
 */
export async function removeFirebasePlayer(code, playerId) {
  const roomRef = getRoomRef(code);
  if (!roomRef || !playerId) return;
  await update(roomRef, {
    [`players/${playerId}`]: null,
    [`private/${playerId}`]: null,
    [`scores/${playerId}`]: null,
    [`eliminatedCards/${playerId}`]: null,
    [`removedPlayers/${playerId}`]: true,
  });
}

/**
 * Sets up presence listeners to monitor disconnection.
 * @param {string} code
 * @param {string} playerId
 */
export async function deleteFirebaseRoom(code) {
  const roomRef = getRoomRef(code);
  if (!roomRef) return;
  const { remove } = await import('./database.js');
  await remove(roomRef);
}

export function setupPresence(code, playerId) {
  const playerConnectedRef = getRoomRef(code, `players/${playerId}/connected`);
  if (!playerConnectedRef) return;

  // Tell Firebase to set player's connection to false if they disconnect
  onDisconnect(playerConnectedRef).set(false);
}

/**
 * Migrates host power if host disconnects.
 * Chooses the first available connected player.
 * @param {string} code
 * @param {object} players
 * @param {string} currentHostId
 */
export async function handleHostMigration(code, players, currentHostId) {
  const connectedPlayers = Object.values(players).filter(
    (p) => p.connected && p.id !== currentHostId
  );

  if (connectedPlayers.length === 0) return; // No active player to take host role

  const newHost = connectedPlayers[0];
  const updates = {};
  updates[`rooms/${code}/hostId`] = newHost.id;
  updates[`rooms/${code}/players/${newHost.id}/isHost`] = true;
  
  // Set current host's host status to false (if still in players map)
  if (players[currentHostId]) {
    updates[`rooms/${code}/players/${currentHostId}/isHost`] = false;
  }

  const { db } = await import('./database.js');
  const { ref, update: dbUpdate } = await import('firebase/database');
  await dbUpdate(ref(db), updates);
}
