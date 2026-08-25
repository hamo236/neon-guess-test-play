import { child, get, onDisconnect, onValue, ref, remove, runTransaction, set, update } from 'firebase/database';
import { db } from './config.js';
import { clone } from '../modes/modeTypes.js';
import { normalizeRoomCode } from '../game/roomManager.js';
import { createJoinDiagnostic, addJoinDiagnosticError } from './joinDiagnostics.js';

const ROOTS = { tournament: 'tournamentRooms', team_battle: 'teamRooms' };
const PRIVATE_ROOTS = { tournament: 'tournamentPrivateTargets', team_battle: 'teamBattlePrivateTargets' };

function roomRef(mode, roomId) {
  if (!db) return null;
  const root = ROOTS[mode];
  if (!root) throw new Error(`Unsupported competitive mode: ${mode}`);
  return ref(db, `${root}/${roomId}`);
}

function privateTargetRef(mode, roomId, matchId, playerId) {
  if (!db) return null;
  if (mode === 'team_battle') return ref(db, `${PRIVATE_ROOTS.team_battle}/${roomId}/${playerId}/${matchId}/target`);
  return ref(db, `${PRIVATE_ROOTS.tournament}/${roomId}/${playerId}/${matchId}/target`);
}

function competitiveJoinError(error, stage, fallbackCode = 'room/join-failed') {
  const enriched = error instanceof Error ? error : new Error(String(error || 'Competitive room join failed.'));
  if (!enriched.code) enriched.code = fallbackCode;
  if (!enriched.joinDiagnostic) enriched.joinDiagnostic = createJoinDiagnostic({ stage, error: enriched });
  return addJoinDiagnosticError(enriched, enriched.joinDiagnostic);
}

function policyJoinError(stage, code, message) {
  const error = new Error(message);
  error.code = code;
  return competitiveJoinError(error, stage, code);
}

export function getCompetitiveNamespace(mode) {
  return ROOTS[mode];
}

export function subscribeCompetitiveConnection({ onConnection, onError }) {
  if (!db) {
    onConnection?.(null);
    return () => {};
  }
  return onValue(ref(db, '.info/connected'), (snapshot) => {
    onConnection?.(snapshot.val() === true);
  }, onError);
}

function setupPresence(mode, roomId, playerId) {
  const target = roomRef(mode, roomId);
  if (!target) return;
  const presenceRef = child(target, `players/${playerId}/connected`);
  onDisconnect(presenceRef).set(false);
}

export async function createCompetitiveRoom({ mode, roomId, player, category }) {
  const normalizedRoomId = normalizeRoomCode(roomId);
  const target = roomRef(mode, normalizedRoomId);
  if (!target) throw new Error('Firebase not configured');
  const playerRecord = { ...clone(player), isHost: true, connected: true, joinOrder: 1, teamId: mode === 'team_battle' ? 'team_a' : null };
  const result = await runTransaction(target, (current) => current || {
    roomId: normalizedRoomId,
    mode,
    status: 'lobby',
    phase: 'lobby',
    category,
    roundNumber: 0,
    hostId: player.id,
    players: { [player.id]: playerRecord },
    ...(mode === 'team_battle' ? { teams: { team_a: { teamId: 'team_a', playerIds: [player.id] }, team_b: { teamId: 'team_b', playerIds: [] } } } : {}),
    updatedAt: Date.now(),
  });
  if (!result.committed) throw new Error('Room already exists.');
  setupPresence(mode, normalizedRoomId, player.id);
  return result.snapshot.val();
}

export async function joinCompetitiveRoom({ mode, roomId, player }) {
  const normalizedRoomId = normalizeRoomCode(roomId);
  const target = roomRef(mode, normalizedRoomId);
  if (!target) throw policyJoinError('firebase-config', 'firebase/not-configured', 'Firebase is not configured for this mode.');

  let initialSnapshot;
  try {
    initialSnapshot = await get(target);
  } catch (error) {
    throw competitiveJoinError(error, 'room-read', error?.code || 'room/network-unreachable');
  }
  if (!initialSnapshot.exists()) throw policyJoinError('room-read', 'room/not-found', `Room ${normalizedRoomId} was not found on the server. Check the code and try again.`);
  const initialRoom = initialSnapshot.val();
  if (initialRoom.removedPlayers?.[player.id]) throw policyJoinError('room-policy', 'room/player-removed', 'You were removed from this room.');

  const existingPlayer = initialRoom.players?.[player.id];
  const isReconnect = Boolean(existingPlayer);
  if (!isReconnect && (initialRoom.status !== 'lobby' || initialRoom.phase !== 'lobby')) throw policyJoinError('room-policy', 'room/game-in-progress', 'This room has already started. Only returning players can reconnect.');
  if (!isReconnect && Object.keys(initialRoom.players || {}).length >= 4) throw policyJoinError('room-policy', 'room/full', 'Room is full. Ask the host to create a new room.');

  if (isReconnect) {
    try {
      await update(child(target, `players/${player.id}`), { connected: true });
      const reconnectedSnapshot = await get(target);
      setupPresence(mode, normalizedRoomId, player.id);
      return { room: reconnectedSnapshot.val(), isReconnect: true };
    } catch (error) {
      throw competitiveJoinError(error, 'post-join-verify', error?.code || 'room/reconnect-failed');
    }
  }

  let result;
  try {
    result = await runTransaction(target, (current) => {
      if (!current || current.removedPlayers?.[player.id]) return current;
      const players = current.players || {};
      if (players[player.id]) return { ...current, players: { ...players, [player.id]: { ...players[player.id], connected: true } }, updatedAt: Date.now() };
      if (current.status !== 'lobby' || current.phase !== 'lobby' || Object.keys(players).length >= 4) return current;
      const nextJoinOrder = Object.values(players).reduce((maxOrder, existing) => Math.max(maxOrder, Number(existing.joinOrder) || 0), 0) + 1;
      const assignedTeam = current.mode === 'team_battle' ? (nextJoinOrder <= 2 ? 'team_a' : 'team_b') : null;
      const nextPlayer = { ...clone(player), isHost: false, connected: true, joinOrder: nextJoinOrder, teamId: assignedTeam };
      const nextTeams = current.mode === 'team_battle' ? { team_a: { ...(current.teams?.team_a || { teamId: 'team_a', playerIds: [] }), playerIds: assignedTeam === 'team_a' ? [...(current.teams?.team_a?.playerIds || []), player.id] : [...(current.teams?.team_a?.playerIds || [])] }, team_b: { ...(current.teams?.team_b || { teamId: 'team_b', playerIds: [] }), playerIds: assignedTeam === 'team_b' ? [...(current.teams?.team_b?.playerIds || []), player.id] : [...(current.teams?.team_b?.playerIds || [])] } } : current.teams;
      return { ...current, players: { ...players, [player.id]: nextPlayer }, ...(nextTeams ? { teams: nextTeams } : {}), updatedAt: Date.now() };
    });
  } catch (error) {
    throw competitiveJoinError(error, 'join-transaction', error?.code || 'room/join-transaction-failed');
  }

  const finalRoom = result.snapshot.val();
  if (!result.committed || !finalRoom?.players?.[player.id]) {
    if (!finalRoom) throw policyJoinError('post-join-verify', 'room/not-found', `Room ${normalizedRoomId} was not found on the server. Check the code and try again.`);
    if (finalRoom.status !== 'lobby' || finalRoom.phase !== 'lobby') throw policyJoinError('post-join-verify', 'room/game-in-progress', 'This room has already started. Only returning players can reconnect.');
    if (Object.keys(finalRoom.players || {}).length >= 4) throw policyJoinError('post-join-verify', 'room/full', 'Room is full. Ask the host to create a new room.');
    throw policyJoinError('post-join-verify', 'room/join-not-committed', 'The server did not confirm your join. Please retry.');
  }

  setupPresence(mode, normalizedRoomId, player.id);
  return { room: finalRoom, isReconnect };
}

export async function setCompetitiveTeam({ mode, roomId, playerId, teamId }) {
  if (mode !== 'team_battle' || !['team_a', 'team_b'].includes(teamId)) throw new Error('Team switching is only available in 2v2 lobby.');
  const target = roomRef(mode, roomId);
  if (!target) throw new Error('Firebase not configured');
  const result = await runTransaction(target, (current) => {
    if (!current || current.status !== 'lobby' || current.phase !== 'lobby') return current;
    const player = current.players?.[playerId];
    if (!player) return current;
    const currentTeamId = player.teamId || Object.keys(current.teams || {}).find((id) => (current.teams?.[id]?.playerIds || []).includes(playerId));
    if (currentTeamId === teamId) return current;
    const destination = current.teams?.[teamId]?.playerIds || [];
    if (destination.length >= 3) return current;
    const nextTeams = Object.fromEntries(['team_a', 'team_b'].map((id) => [id, { ...(current.teams?.[id] || { teamId: id, playerIds: [] }), playerIds: (current.teams?.[id]?.playerIds || []).filter((id) => id !== playerId).concat(id === teamId ? [playerId] : []) }]));
    return { ...current, players: { ...current.players, [playerId]: { ...player, teamId } }, teams: nextTeams, updatedAt: Date.now() };
  });
  const next = result.snapshot.val();
  if (!result.committed || next?.players?.[playerId]?.teamId !== teamId) throw new Error('That team is full or the room has already started.');
  return next;
}

export async function removeCompetitivePlayer({ mode, roomId, playerId }) {
  const target = roomRef(mode, roomId);
  if (!target) throw new Error('Firebase not configured');
  if (mode === 'team_battle') {
    const result = await runTransaction(target, (current) => {
      if (!current || current.status !== 'lobby' || current.phase !== 'lobby') return current;
      const players = { ...(current.players || {}) };
      delete players[playerId];
      const teams = Object.fromEntries(Object.entries(current.teams || {}).map(([teamId, team]) => [teamId, { ...team, playerIds: (team.playerIds || []).filter((id) => id !== playerId) }]));
      return { ...current, players, teams, removedPlayers: { ...(current.removedPlayers || {}), [playerId]: true }, updatedAt: Date.now() };
    });
    const next = result.snapshot.val();
    if (!result.committed || next?.players?.[playerId]) throw new Error('Player removal was rejected because the lobby changed. Refresh and try again.');
  } else {
    await update(target, { [`players/${playerId}`]: null, [`removedPlayers/${playerId}`]: true });
  }
  if (db) await remove(ref(db, `${PRIVATE_ROOTS[mode]}/${roomId}/${playerId}`));
}

export async function leaveCompetitiveRoom({ mode, roomId, playerId, isHost }) {
  const target = roomRef(mode, roomId);
  if (!target) return;
  if (isHost || mode === 'tournament') {
    await remove(target);
    if (db) await remove(ref(db, `${PRIVATE_ROOTS[mode]}/${roomId}`));
    return;
  }
  const result = await runTransaction(target, (current) => {
    if (!current || !current.players?.[playerId]) return current;
    if (mode === 'tournament') return { ...current, status: 'closed', phase: 'lobby', players: { ...current.players, [playerId]: null }, leftPlayers: { ...(current.leftPlayers || {}), [playerId]: true }, updatedAt: Date.now() };
    return { ...current, players: { ...current.players, [playerId]: null }, leftPlayers: { ...(current.leftPlayers || {}), [playerId]: true }, updatedAt: Date.now() };
  });
  const next = result.snapshot.val();
  if (!result.committed || next?.players?.[playerId]) throw new Error('Leaving the lobby was rejected because the match changed. Refresh and try again.');
  if (db) await remove(ref(db, `${PRIVATE_ROOTS[mode]}/${roomId}/${playerId}`));
}

export function sanitizePublicState(state) {
  const safe = clone(state);
  // Legacy tournament rooms stored private targets under the public room node; never write that payload again.
  delete safe.private;
  if (safe?.matches) {
    safe.matches = Object.fromEntries(Object.entries(safe.matches).map(([matchId, match]) => {
      const safeMatch = { ...match };
      delete safeMatch.targets;
      if (safeMatch.guesses) safeMatch.guesses = Object.fromEntries(Object.entries(safeMatch.guesses).map(([playerId, guess]) => { const { targetId: _targetId, ...safeGuess } = guess || {}; return [playerId, safeGuess]; }));
      if (safeMatch.result) { const { targets: _targets, ...safeResult } = safeMatch.result; safeMatch.result = safeResult; }
      return [matchId, safeMatch];
    }));
  }
  if (safe?.playerStats) {
    safe.playerStats = Object.fromEntries(Object.entries(safe.playerStats).map(([playerId, stats]) => [playerId, { ...stats, roundHistory: Array.isArray(stats?.roundHistory) ? stats.roundHistory.map((entry) => { const { target: _target, guess: rawGuess, ...safeEntry } = entry || {}; const { targetId: _targetId, ...guess } = rawGuess || {}; return { ...safeEntry, ...(rawGuess ? { guess } : {}) }; }) : stats?.roundHistory }]));
  }
  if (safe?.match) {
    delete safe.match.targets;
    delete safe.match.teamTargets;
    if (safe.match.status === 'playing' && safe.match.roundSnapshot) { const { target: _target, ...safeRoundSnapshot } = safe.match.roundSnapshot; safe.match.roundSnapshot = safeRoundSnapshot; }
    if (safe.match.guesses) safe.match.guesses = Object.fromEntries(Object.entries(safe.match.guesses).map(([playerId, guess]) => { const { targetId: _targetId, ...safeGuess } = guess || {}; return [playerId, safeGuess]; }));
    if (safe.match.confirmations) safe.match.confirmations = Object.fromEntries(Object.entries(safe.match.confirmations).map(([teamId, entries]) => [teamId, Object.fromEntries(Object.entries(entries || {}).map(([playerId, confirmation]) => { const { targetSnapshot: _targetSnapshot, ...safeConfirmation } = confirmation || {}; return [playerId, safeConfirmation]; }))]));
  }
  if (Array.isArray(safe?.roundHistory)) safe.roundHistory = safe.roundHistory.map((result) => { const safeGuesses = result?.guesses ? Object.fromEntries(Object.entries(result.guesses).filter(([, guess]) => guess != null).map(([playerId, guess]) => { const { targetId: _targetId, ...safeGuess } = guess || {}; return [playerId, safeGuess]; })) : null; const { completedRoundTarget: _completedRoundTarget, guesses: _guesses, ...safeResult } = result || {}; return safeGuesses ? { ...safeResult, guesses: safeGuesses } : safeResult; });
  return safe;
}

export async function submitTournamentGuess({ roomId, matchId, playerId, roundNumber }) {
  const target = roomRef('tournament', roomId);
  if (!target) throw new Error('Firebase not configured');
  const guessRef = child(target, `matches/${matchId}/guesses/${playerId}`);
  const result = await runTransaction(guessRef, (current) => current || {
    playerId,
    roundNumber: Number(roundNumber),
    confirmed: true,
    correct: true,
    timestamp: Date.now(),
  });
  if (!result.committed) throw new Error('Guess confirmation was rejected because the round changed.');
  return result.snapshot.val();
}

export async function submitTeamConfirmation({ roomId, matchId, teamId, playerId, roundNumber }) {
  const target = roomRef('team_battle', roomId);
  if (!target) throw new Error('Firebase not configured');
  const confirmationRef = child(target, `match/confirmations/${teamId}/${playerId}`);
  const result = await runTransaction(confirmationRef, (current) => current || {
    playerId,
    teamId,
    matchId,
    roundNumber: Number(roundNumber),
    confirmedAt: Date.now(),
  });
  if (!result.committed) throw new Error('Team confirmation was rejected because the round changed.');
  return result.snapshot.val();
}

export async function mutateCompetitiveState({ mode, roomId, mutate }) {
  const target = roomRef(mode, roomId);
  if (!target) throw new Error('Firebase not configured');
  const result = await runTransaction(target, (current) => (current ? sanitizePublicState(mutate(clone(current))) : current));
  return result.snapshot.val();
}

export async function writeCompetitiveState({ mode, roomId, state }) {
  const target = roomRef(mode, roomId);
  if (!target) throw new Error('Firebase not configured');
  await set(target, { ...sanitizePublicState(state), roomId, mode, updatedAt: Date.now() });
}

export async function writeCompetitiveTarget({ mode, roomId, matchId, playerId, target }) {
  const targetRef = privateTargetRef(mode, roomId, matchId, playerId);
  if (!targetRef) throw new Error('Firebase not configured');
  await set(targetRef, clone({ ...target, playerId, targetId: target.targetId || target.id, matchId, targetReady: true }));
}

export function subscribeCompetitiveTarget({ mode, roomId, matchId, playerId, onTarget, onError }) {
  const target = privateTargetRef(mode, roomId, matchId, playerId);
  if (!target) return () => {};
  return onValue(target, (snapshot) => onTarget(snapshot.exists() ? snapshot.val() : null), onError);
}

export function subscribeCompetitiveRoom({ mode, roomId, onState, onError }) {
  const target = roomRef(mode, roomId);
  if (!target) return () => {};
  return onValue(target, (snapshot) => onState(snapshot.exists() ? snapshot.val() : null), onError);
}


export function subscribeCompetitiveChat({ mode, roomId, onMessages, onError }) {
  const target = roomRef(mode, roomId);
  if (!target) { onMessages?.([]); return () => {}; }
  const messagesTarget = child(target, 'messages');
  return onValue(messagesTarget, (snapshot) => {
    const messages = Object.values(snapshot.val() || {})
      .filter((message) => message && message.type === 'chat' && typeof message.message === 'string')
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-100);
    onMessages?.(messages);
  }, onError);
}

export async function sendCompetitiveChatMessage({ mode, roomId, playerId, playerName, message }) {
  const target = roomRef(mode, roomId);
  const trimmed = String(message || '').trim();
  if (!target) throw new Error('Firebase not configured');
  if (!playerId || !trimmed) return;
  if (trimmed.length > 500) throw new Error('Message is too long.');
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await set(child(target, `messages/${messageId}`), {
    id: messageId,
    playerId,
    playerName: String(playerName || 'Player').slice(0, 40),
    message: trimmed,
    timestamp: Date.now(),
    type: 'chat',
  });
}
