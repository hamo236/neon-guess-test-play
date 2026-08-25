/**
 * GameStateContext.jsx
 * Central game state + Firebase multiplayer bridge.
 *
 * Architecture:
 *   UI â†’ actions â†’ local reducer (game engine) â†’ Firebase sync
 *   Firebase listeners â†’ dispatch â†’ local reducer â†’ UI
 *
 * If Firebase is not configured (missing .env), all Firebase calls become
 * graceful no-ops and the app runs in local-only mode.
 */

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPlayer, normalizeRoomCode } from '../game/roomManager.js';
import {
  buildInitialState,
  initRoom,
  playerJoined,
  playerLeft,
  enterPreview as engineEnterPreview,
  beginPlayingFromPreview as engineBeginPlaying,
  confirmOpponentGuessed as engineConfirmOpponentGuessed,
  resolveKnockoutMatch as engineResolveKnockoutMatch,
  sendChatMessage as engineSendChatMessage,
  submitQuestion as engineSubmitQuestion,
  answerQuestion as engineAnswerQuestion,
  submitGuess as engineSubmitGuess,
  toggleEliminateCard as engineToggleEliminate,
  timerTick as engineTimerTick,
  castVote as engineCastVote,
  resolveVoting as engineResolveVoting,
  advanceRound as engineAdvanceRound,
  resetMatch as engineResetMatch,
  GAME_PHASES,
  GAME_MODES,
} from '../game/gameEngine.js';
import {
  generateRoomCode,
  addMockPlayer,
  canStartGame,
} from '../game/roomManager.js';
import { CATEGORIES } from '../data/gameData.js';
import { isFirebaseConfigured } from '../firebase/config.js';
import { initAuth, getCurrentUserId } from '../firebase/auth.js';
import {
  createFirebaseRoom,
  reconnectOrJoinFirebaseRoom,
  setupPresence,
  handleHostMigration,
  deleteFirebaseRoom,
  removeFirebasePlayer,
} from '../firebase/roomService.js';
import { saveSession, loadSession, clearSession } from '../utils/sessionStorage.js';

function classifyRecoveryFailure(error) {
  const message = error?.message || 'We could not restore the active match.';
  if (/Room not found|removed from this room|Game already in progress|Room is full/i.test(message)) {
    return { status: 'terminal', message };
  }
  if (/Not authenticated|identity|authentication/i.test(message)) {
    return { status: 'identity-error', message: 'We could not verify your player identity for this room.' };
  }
  return { status: 'retryable-error', message };
}


import {
  syncEnterPreview,
  syncBeginPlaying,
  syncStartGame,
  syncSendChatMessage,
  syncSubmitQuestion,
  syncAnswerQuestion,
  syncSubmitGuess,
  syncConfirmOpponentGuess,
  syncDeclareCorrectGuess,
  syncToggleEliminate,
  syncCastVote,
  syncResolveVoting,
  syncAdvanceRound,
  syncResetMatch,
  syncSetCategory,
  syncImpostorAction,
  syncResolveKnockoutMatch,
  subscribeToRoom,
  subscribeToPrivateTarget,
  subscribeToDisplayTarget,
} from '../firebase/gameSync.js';

// â”€â”€â”€ Action Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const A = {

  CREATE_ROOM: 'CREATE_ROOM',
  PLAYER_JOIN: 'PLAYER_JOIN',
  PLAYER_LEAVE: 'PLAYER_LEAVE',
  ADD_MOCK_PLAYER: 'ADD_MOCK_PLAYER',
  SET_CATEGORY: 'SET_CATEGORY',
  SET_MODE: 'SET_MODE',
  START_GAME: 'START_GAME',
  BEGIN_ROUND: 'BEGIN_ROUND',
  CONFIRM_OPPONENT_GUESS: 'CONFIRM_OPPONENT_GUESS',
  SEND_CHAT: 'SEND_CHAT',
  SUBMIT_QUESTION: 'SUBMIT_QUESTION',
  ANSWER_QUESTION: 'ANSWER_QUESTION',
  SUBMIT_GUESS: 'SUBMIT_GUESS',
  TOGGLE_ELIMINATE: 'TOGGLE_ELIMINATE',
  TIMER_TICK: 'TIMER_TICK',
  CAST_VOTE: 'CAST_VOTE',
  RESOLVE_VOTING: 'RESOLVE_VOTING',
  ADVANCE_ROUND: 'ADVANCE_ROUND',
  RESET_MATCH: 'RESET_MATCH',
  SET_TIMER_RUNNING: 'SET_TIMER_RUNNING',
  // Firebase-sourced updates
  FB_ROOM_SYNC: 'FB_ROOM_SYNC',
  FB_MESSAGES_SYNC: 'FB_MESSAGES_SYNC',
  FB_TARGET_RECEIVED: 'FB_TARGET_RECEIVED',
  FB_DISPLAY_TARGET_RECEIVED: 'FB_DISPLAY_TARGET_RECEIVED',
      SET_MY_PLAYER_ID: 'SET_MY_PLAYER_ID',
    ROOM_CLOSED: 'ROOM_CLOSED',

};

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function scoresFromPlayers(playersList) {
  const scores = {};
  playersList.forEach((p) => { scores[p.id] = p.score ?? 0; });
  return scores;
}

function needsTargetSubscription(phase) {
  return phase === GAME_PHASES.PLAYING || phase === GAME_PHASES.ROUND_END;
}

function hasCurrentRoundResult(state) {
  return Boolean(
    state.roundResult?.roundId
      && state.roundResult.roundId === state.roundId,
  );
}

// â”€â”€â”€ Reducer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function gameReducer(state, action) {
  switch (action.type) {
    case A.CREATE_ROOM:     return initRoom(state, action.payload);
    case A.PLAYER_JOIN:     return playerJoined(state, action.payload);
    case A.PLAYER_LEAVE:    return playerLeft(state, action.payload.playerId);
    case A.ADD_MOCK_PLAYER: {
      const result = addMockPlayer(state.players, action.payload.name);
      if (!result.ok) { console.warn(result.error); return state; }
      return playerJoined(state, result.players[result.players.length - 1]);
    }
    case A.SET_CATEGORY:    return { ...state, category: action.payload.category };
    case A.SET_MODE:        return { ...state, mode: action.payload.mode };
    case A.START_GAME:      return engineEnterPreview(state);
    case A.BEGIN_ROUND:     return engineBeginPlaying(state);
    case A.CONFIRM_OPPONENT_GUESS: return engineConfirmOpponentGuessed(state, action.payload);
    case A.SEND_CHAT:       return engineSendChatMessage(state, action.payload);
    case A.SUBMIT_QUESTION: return engineSubmitQuestion(state, action.payload);
    case A.ANSWER_QUESTION: return engineAnswerQuestion(state, action.payload);
    case A.SUBMIT_GUESS:    return engineSubmitGuess(state, action.payload);
    case A.TOGGLE_ELIMINATE:return engineToggleEliminate(state, action.payload);
    case A.TIMER_TICK:      return engineTimerTick(state);
    case A.CAST_VOTE:       return engineCastVote(state, action.payload);
    case A.RESOLVE_VOTING:  return engineResolveVoting(state);
    case A.ADVANCE_ROUND:   return engineAdvanceRound(state);
    case A.RESET_MATCH:     return engineResetMatch(state);
    case A.SET_TIMER_RUNNING: return { ...state, timerRunning: action.payload.running };

    // Merge Firebase real-time room data into local state
    case A.FB_ROOM_SYNC: {
      const fb = action.payload;
      const isNewRound = fb.round != null && fb.round !== state.round;
      const clearRoundSnapshot = isNewRound || fb.phase === GAME_PHASES.PREVIEW;
      const rawPlayers = fb.players
        ? Object.values(fb.players)
        : state.players;
      // Firebase UID keys are lexicographically enumerated, not in join order.
      // Only full social four-player rooms need persisted seats for bracket seeding.
      const isFourPlayerSocialRoom = (fb.mode ?? state.mode) === GAME_MODES.SOCIAL && rawPlayers.length === 4;
      let playersList = rawPlayers;
      if (isFourPlayerSocialRoom) {
        const allHaveJoinOrder = rawPlayers.every((player) => Number.isFinite(player.joinOrder));
        if (allHaveJoinOrder) {
          playersList = [...rawPlayers].sort((a, b) => a.joinOrder - b.joinOrder);
        } else {
          const existingOrderMap = new Map(state.players.map((p, idx) => [p.id, Number.isFinite(p.joinOrder) ? p.joinOrder : idx + 1]));
          playersList = [...rawPlayers].sort((a, b) => {
            const orderA = Number.isFinite(a.joinOrder) ? a.joinOrder : (existingOrderMap.get(a.id) ?? 999);
            const orderB = Number.isFinite(b.joinOrder) ? b.joinOrder : (existingOrderMap.get(b.id) ?? 999);
            return orderA - orderB;
          });
        }
      }
      const mergedScores = fb.scores
        ?? (playersList.length ? scoresFromPlayers(playersList) : state.scores);
      return {
        ...state,
        roomCode: fb.roomCode ?? state.roomCode,
        matchId: fb.matchId ?? state.matchId,
        roundId: fb.roundId ?? state.roundId,
        phase: fb.phase ?? state.phase,
        round: fb.round ?? state.round,
        totalRounds: fb.totalRounds ?? state.totalRounds,
        currentTurnPlayerId: fb.currentTurnPlayerId ?? state.currentTurnPlayerId,
        players: playersList,
        scores: mergedScores,
        eliminatedCards: fb.eliminatedCards ?? state.eliminatedCards,
        usedTargetIds: fb.usedTargetIds ? (Array.isArray(fb.usedTargetIds) ? fb.usedTargetIds : Object.values(fb.usedTargetIds)) : state.usedTargetIds,
        votes: fb.votes ? Object.values(fb.votes) : state.votes,
        roundResult: state.mode === '1v1' && isNewRound && fb.phase === GAME_PHASES.PLAYING
          ? null
          : (fb.roundResult !== undefined ? fb.roundResult : state.roundResult),
        roundResults: fb.roundResults ?? state.roundResults,
        bracket: fb.bracket !== undefined ? fb.bracket : state.bracket,
        playerAssignments: fb.playerAssignments !== undefined ? fb.playerAssignments : state.playerAssignments,
        matchResults: fb.matchResults !== undefined ? fb.matchResults : state.matchResults,
        standings: fb.standings !== undefined ? fb.standings : state.standings,
        transitionStartedAt: fb.transitionStartedAt ?? state.transitionStartedAt ?? 0,
        transitionEndsAt: fb.transitionEndsAt ?? state.transitionEndsAt ?? 0,
        timerEndTimestamp: fb.timerEndTimestamp ?? 0,
        revealEndTimestamp: fb.revealEndTimestamp ?? state.revealEndTimestamp ?? 0,
        hostId: fb.hostId ?? state.hostId,
        mode: fb.mode ?? state.mode,
        category: fb.category ?? state.category,
        displayTargets: state.displayTargets,
        roundTargets: clearRoundSnapshot ? {} : state.roundTargets,
      };
    }
    case A.FB_MESSAGES_SYNC: {
      return {
        ...state,
        questions: action.payload,
      };
    }
    // When my secret target arrives from private Firebase path (internal â€” not shown in UI)
    case A.FB_TARGET_RECEIVED: {
      const target = action.payload.target;
      if (!target || target.targetReady !== true) return state;
      const isOneVOne = state.mode === '1v1';
      if (target.roundId && target.roundId !== state.roundId && !isOneVOne) return state;
      if (target.round != null && target.round !== state.round && !(isOneVOne && target.round > state.round)) return state;
      const expectedAssignment = state.playerAssignments?.[action.payload.playerId];
      const expectedMatch = state.bracket?.matches?.[expectedAssignment?.matchId];
      if (target.matchId && expectedAssignment?.matchId !== target.matchId) return state;
      if (target.matchRound != null && expectedMatch?.matchRound !== target.matchRound) return state;
      return {
        ...state,
        targets: {
          ...state.targets,
          [action.payload.playerId]: target,
        },
        roundTargets: {
          ...state.roundTargets,
          [action.payload.playerId]: target,
        },
      };
    }
    // When opponent's target arrives for UI display
    case A.FB_DISPLAY_TARGET_RECEIVED: {
      const target = action.payload.target;
      if (!target || target.targetReady !== true) return state;
      const isOneVOne = state.mode === '1v1';
      if (target.roundId && target.roundId !== state.roundId && !isOneVOne) return state;
      if (target.round != null && target.round !== state.round && !(isOneVOne && target.round > state.round)) return state;
      const expectedAssignment = state.playerAssignments?.[action.payload.playerId];
      const expectedMatch = state.bracket?.matches?.[expectedAssignment?.matchId];
      if (target.matchId && expectedAssignment?.matchId !== target.matchId) return state;
      if (target.matchRound != null && expectedMatch?.matchRound !== target.matchRound) return state;
      return {
        ...state,
        displayTargets: {
          ...state.displayTargets,
          [action.payload.playerId]: target,
        },
        ...(isOneVOne ? {
          roundTargets: {
            ...state.roundTargets,
            [action.payload.playerId]: target,
          },
        } : {}),
      };
    }
    case A.SET_MY_PLAYER_ID: {
      return { ...state, myPlayerId: action.payload };
    }
    case A.ROOM_CLOSED:
      return { ...buildInitialState(), myPlayerId: null };
    default: return state;
  }
}

// â”€â”€â”€ Context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const GameStateContext = createContext(null);

export function GameStateProvider({ children }) {
  const [state, dispatch] = useReducer(gameReducer, {
    ...buildInitialState(),
    myPlayerId: null,
    timerEndTimestamp: 0,
  });

  // Firebase status
  const [fbStatus, setFbStatus] = useState(
    isFirebaseConfigured ? 'initializing' : 'local'
  );
  const [fbError, setFbError] = useState(null);
  const [fbErrorCode, setFbErrorCode] = useState(null);
  const [recovery, setRecovery] = useState({
    status: 'idle',
    session: null,
    message: '',
  });
  const [joinDiagnostic, setJoinDiagnostic] = useState(null);
  const unsubscribeRoomRef = useRef(null);
  const unsubscribeTargetRef = useRef(null);
  const unsubscribeDisplayTargetRef = useRef(null);
  const targetSubscriptionKeyRef = useRef(null);
  const subscribeToMyTargetRef = useRef(null);
  const prevHostIdRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const processedClaimsRef = useRef(new Set());
  const processedActionsRef = useRef(new Set());
  const rejoinAttemptedRef = useRef(false);

  // Track my player id separately for easy access
  const myPlayerId = state.myPlayerId || state.players[0]?.id || null;
  const isHost = state.hostId === myPlayerId;

  // â”€â”€ Initialize Firebase Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    initAuth()
      .then((user) => {
        if (user) {
          dispatch({ type: A.SET_MY_PLAYER_ID, payload: user.uid });
          setFbStatus('ready');
        }
      })
      .catch((err) => {
        console.error('[Firebase] Auth init failed:', err);
setFbError('Firebase authentication failed. Running in local mode.');
        setFbErrorCode(err?.code || 'auth/initialization-failed');
        setFbStatus('error');
      });
  }, []);

  // â”€â”€ Room subscription â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const subscribeToFirebaseRoom = useCallback((roomCode) => {
    if (unsubscribeRoomRef.current) {
      unsubscribeRoomRef.current();
      unsubscribeRoomRef.current = null;
    }

    const unsub = subscribeToRoom(roomCode, {
      onRoomUpdate: (roomData) => {
        const currentUid = getCurrentUserId() || stateRef.current.myPlayerId;
        if (!roomData || roomData.removedPlayers?.[currentUid]) {
          clearSession();
          dispatch({ type: A.ROOM_CLOSED });
          return;
        }
        dispatch({ type: A.FB_ROOM_SYNC, payload: { ...roomData, roomCode } });
        if (currentUid && needsTargetSubscription(roomData.phase)) {
          subscribeToMyTargetRef.current?.(roomCode, currentUid, roomData.mode === GAME_MODES.ONE_V_ONE ? roomData.roundId : null);
        }

        // Host migration: if previous host disconnected and we are next connected player
        if (
          prevHostIdRef.current &&
          roomData.players &&
          roomData.players[prevHostIdRef.current]?.connected === false
        ) {
          const connectedPlayers = Object.values(roomData.players).filter(
            (p) => p.connected && p.id !== prevHostIdRef.current
          );
          // Let the first connected player handle migration
          const currentUid = getCurrentUserId();
          if (connectedPlayers[0]?.id === currentUid) {
            handleHostMigration(roomCode, roomData.players, prevHostIdRef.current);
          }
        }
        prevHostIdRef.current = roomData.hostId;
      },
      onActionsUpdate: async (actionsByRound) => {
        const currentState = stateRef.current;
        if (currentState.mode !== GAME_MODES.SOCIAL || currentState.players.length <= 2) return;
        const roundActions = actionsByRound?.[currentState.roundId] || {};
        const myId = currentState.myPlayerId || currentState.players[0]?.id;
        if (!currentState.hostId || currentState.hostId !== myId || currentState.phase !== GAME_PHASES.PLAYING) return;
        const actions = Object.values(roundActions).flatMap((byMatch) => Object.values(byMatch || {}).flatMap((byRound) => Object.values(byRound || {})));
        const validActions = actions
          .filter((action) => {
            const assignment = currentState.playerAssignments?.[action?.actorId];
            return action?.type === 'confirm_guess'
              && action.roundId === currentState.roundId
              && action.matchId
              && assignment?.matchId === action.matchId
              && assignment.opponentPlayerId === action.targetPlayerId;
          })
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        let workingState = currentState;
        for (const action of validActions) {
          if (processedActionsRef.current.has(action.actionId)) continue;
          processedActionsRef.current.add(action.actionId);
          const claimState = engineResolveKnockoutMatch(workingState, {
            matchId: action.matchId,
            confirmerId: action.actorId,
            guessedPlayerId: action.targetPlayerId,
            roundId: action.roundId,
            matchRound: action.matchRound,
          });
          if (claimState === workingState) continue;
          workingState = claimState;
          dispatch({ type: A.FB_ROOM_SYNC, payload: { ...claimState, roomCode: currentState.roomCode, players: Object.fromEntries(currentState.players.map((p) => [p.id, p])) } });
          await syncResolveKnockoutMatch(currentState.roomCode, claimState, action.matchId, claimState.roundResult);
        }
      },
      onMessagesUpdate: (messages) => {
        const sorted = [...messages].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        dispatch({ type: A.FB_MESSAGES_SYNC, payload: sorted });

        // Host applies opponent-guess confirmations via message relay
        const latestConfirm = sorted.filter((m) => m.type === 'guess_confirm').at(-1);
        const currentState = stateRef.current;
        const hostId = currentState.hostId;
        const myId = currentState.myPlayerId || currentState.players[0]?.id;
        if (
          latestConfirm &&
          !processedClaimsRef.current.has(latestConfirm.id) &&
          hostId === myId &&
          currentState.phase === GAME_PHASES.PLAYING &&
          (currentState.mode === GAME_MODES.ONE_V_ONE
            ? !hasCurrentRoundResult(currentState)
            : !currentState.roundResult)
        ) {
          processedClaimsRef.current.add(latestConfirm.id);
          const claimState = engineConfirmOpponentGuessed(currentState, {
            confirmerId: latestConfirm.confirmerId,
            guessedPlayerId: latestConfirm.winnerId,
          });
          dispatch({
            type: A.CONFIRM_OPPONENT_GUESS,
            payload: {
              confirmerId: latestConfirm.confirmerId,
              guessedPlayerId: latestConfirm.winnerId,
            },
          });
          syncConfirmOpponentGuess(
            currentState.roomCode,
            claimState.scores,
            claimState.roundResult,
            claimState.revealEndTimestamp,
          );
        }
      },
    });

    unsubscribeRoomRef.current = unsub;
  }, []);

  // â”€â”€ Private target subscription â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const subscribeToMyTarget = useCallback((roomCode, playerId, roundId = null) => {
    const subscriptionKey = `${roomCode}:${playerId}:${roundId ?? 'current'}`;
    if (targetSubscriptionKeyRef.current === subscriptionKey) return;
    targetSubscriptionKeyRef.current = subscriptionKey;
    if (unsubscribeTargetRef.current) {
      unsubscribeTargetRef.current();
    }
    if (unsubscribeDisplayTargetRef.current) {
      unsubscribeDisplayTargetRef.current();
    }
    const unsubOwn = subscribeToPrivateTarget(roomCode, playerId, (target) => {
      dispatch({
        type: A.FB_TARGET_RECEIVED,
        payload: { playerId, target },
      });
    });
    const unsubDisplay = subscribeToDisplayTarget(roomCode, playerId, (target) => {
      dispatch({
        type: A.FB_DISPLAY_TARGET_RECEIVED,
        payload: { playerId, target },
      });
    });
    unsubscribeTargetRef.current = unsubOwn;
    unsubscribeDisplayTargetRef.current = unsubDisplay;
  }, []);
  subscribeToMyTargetRef.current = subscribeToMyTarget;

  /** Restore Firebase subscriptions after reconnect */
const attachToRoom = useCallback((roomCode, playerId, roomPhase, roundId = null) => {
    subscribeToFirebaseRoom(roomCode);
    if (playerId && needsTargetSubscription(roomPhase)) {
      subscribeToMyTarget(roomCode, playerId, roundId);
    }
  }, [subscribeToFirebaseRoom, subscribeToMyTarget]);

  // Auto-rejoin after refresh (sessionStorage + stable Firebase UID).
  // The roomService remains the authority; this layer only projects recovery status.
  const retryAutoRejoin = useCallback(async () => {
    if (!isFirebaseConfigured || fbStatus !== 'ready' || state.roomCode || rejoinAttemptedRef.current) return;

    const session = loadSession();
    const uid = getCurrentUserId();
    if (!session?.roomCode || !uid || session.playerId !== uid) {
      setRecovery({
        status: 'identity-error',
        session,
        message: 'We could not verify your player identity for this room.',
      });
      return;
    }

    setRecovery({ status: 'restoring', session, message: '' });
    rejoinAttemptedRef.current = true;

    const player = createPlayer({
      id: uid,
      name: session.playerName || '',
      isHost: false,
    });

    try {
      const { room, isReconnect } = await reconnectOrJoinFirebaseRoom({
        code: session.roomCode,
        player,
      });
      dispatch({ type: A.SET_MY_PLAYER_ID, payload: uid });
      dispatch({
        type: A.FB_ROOM_SYNC,
        payload: { ...room, roomCode: session.roomCode.toUpperCase() },
      });
      if (!isReconnect) {
        dispatch({ type: A.PLAYER_JOIN, payload: player });
      }
      saveSession({
        roomCode: session.roomCode,
        playerId: uid,
        playerName: room.players?.[uid]?.name ?? session.playerName,
      });
      attachToRoom(session.roomCode.toUpperCase(), uid, room.phase, room.roundId ?? null);
      setRecovery({ status: 'restored', session, message: '' });
    } catch (err) {
      const failure = classifyRecoveryFailure(err);
      console.warn('[Session] Auto-rejoin failed:', err.message);
      if (failure.status === 'terminal') clearSession();
      setRecovery({ status: failure.status, session, message: failure.message });
      rejoinAttemptedRef.current = false;
    }
  }, [fbStatus, state.roomCode, attachToRoom]);

  useEffect(() => {
    if (!isFirebaseConfigured || fbStatus !== 'ready' || rejoinAttemptedRef.current || state.roomCode) return;
    const session = loadSession();
    if (!session?.roomCode) return;
    retryAutoRejoin();
  }, [fbStatus, state.roomCode, retryAutoRejoin]);

  const clearSessionRecovery = useCallback(() => {
    clearSession();
    rejoinAttemptedRef.current = false;
    setRecovery({ status: 'dismissed', session: null, message: '' });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRoomRef.current) unsubscribeRoomRef.current();
      if (unsubscribeTargetRef.current) unsubscribeTargetRef.current();
      if (unsubscribeDisplayTargetRef.current) unsubscribeDisplayTargetRef.current();
    };
  }, []);

  // â”€â”€ Action Creators â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const actions = {
    createRoom: useCallback(async ({ name, mode, category }) => {
      const activeMode = mode ?? GAME_MODES.ONE_V_ONE;
      // Try Firebase first
      if (isFirebaseConfigured && fbStatus === 'ready') {
        const uid = getCurrentUserId();
        if (!uid) throw new Error('Not authenticated');
        let code;
        let attempts = 0;
        // Ensure unique code
        do {
          code = generateRoomCode();
          attempts++;
          if (attempts > 10) throw new Error('Could not generate unique room code.');
        } while (false); // Uniqueness check could do a Firebase get() here but kept simple

        const trimmedName = String(name || '').trim();
        if (!trimmedName) throw new Error('Enter your name before creating a room.');
        const hostPlayer = createPlayer({ id: uid, name: trimmedName, isHost: true });
        await createFirebaseRoom({ code, hostPlayer, mode: activeMode, category });
        dispatch({
          type: A.CREATE_ROOM,
          payload: { roomCode: code, hostPlayer, mode: activeMode, category },
        });
        dispatch({ type: A.SET_MY_PLAYER_ID, payload: uid });
        subscribeToFirebaseRoom(code);
        saveSession({ roomCode: code, playerId: uid, playerName: hostPlayer.name });
        setupPresence(code, uid);
        return code;
      }

      // Local fallback
      const code = generateRoomCode();
      const trimmedName = String(name || '').trim();
      if (!trimmedName) throw new Error('Enter your name before creating a room.');
      const hostPlayer = createPlayer({
        id: `host_${Date.now()}`,
        name: trimmedName,
        isHost: true,
      });
      dispatch({
        type: A.CREATE_ROOM,
        payload: { roomCode: code, hostPlayer, mode: activeMode, category },
      });
      return code;
    }, [fbStatus, subscribeToFirebaseRoom]),

    joinRoom: useCallback(async ({ code, name, onDiagnostic }) => {
      setJoinDiagnostic(null);
      const report = (diagnostic) => {
        setJoinDiagnostic(diagnostic);
        onDiagnostic?.(diagnostic);
      };
      report({ stage: 'auth-ready', status: 'passed', code: 'ok', message: 'Firebase Auth session is ready.' });
      if (!isFirebaseConfigured || fbStatus !== 'ready') {
        const error = new Error(fbError || 'Firebase is not ready. Please retry the connection.');
        error.code = fbErrorCode || 'firebase/not-ready';
        report({ stage: 'auth-ready', status: 'failed', code: error.code, message: error.message });
        throw error;
      }
      const uid = getCurrentUserId();
      if (!uid) {
        const error = new Error('Not authenticated');
        error.code = 'auth/not-authenticated';
        report({ stage: 'auth-ready', status: 'failed', code: error.code, message: error.message });
        throw error;
      }

      const normalizedCode = normalizeRoomCode(code);
      const trimmedName = String(name || '').trim();
      if (!trimmedName) throw new Error('Enter your name before joining a room.');
      const player = createPlayer({ id: uid, name: trimmedName, isHost: false });
      const { room, isReconnect } = await reconnectOrJoinFirebaseRoom({
        code: normalizedCode,
        player,
        onDiagnostic: report,
      });

      dispatch({ type: A.SET_MY_PLAYER_ID, payload: uid });

      if (!isReconnect) {
        dispatch({ type: A.PLAYER_JOIN, payload: player });
      }

      dispatch({
        type: A.FB_ROOM_SYNC,
        payload: { ...room, roomCode: normalizedCode },
      });

      saveSession({
        roomCode: normalizedCode,
        playerId: uid,
        playerName: room.players?.[uid]?.name ?? name,
      });

      attachToRoom(normalizedCode, uid, room.phase, room.roundId ?? null);

      return { isReconnect, phase: room.phase };
    }, [fbStatus, attachToRoom]),

    addMockPlayer: useCallback((name) => {
      dispatch({ type: A.ADD_MOCK_PLAYER, payload: { name } });
    }, []),

    removePlayer: useCallback(async (playerId) => {
      if (!playerId || playerId === myPlayerId || !isHost) return;
      if (isFirebaseConfigured && state.roomCode) {
        await removeFirebasePlayer(state.roomCode, playerId);
      } else {
        dispatch({ type: A.PLAYER_LEAVE, payload: { playerId } });
      }
    }, [isHost, isFirebaseConfigured, myPlayerId, state.roomCode]),

    setCategory: useCallback(async (category) => {
      dispatch({ type: A.SET_CATEGORY, payload: { category } });
      if (isFirebaseConfigured && state.roomCode) {
        await syncSetCategory(state.roomCode, category);
      }
    }, [state.roomCode]),

    setMode: useCallback((mode) => {
      dispatch({ type: A.SET_MODE, payload: { mode } });
    }, []),

    startGame: useCallback(async () => {
      // Starting a Firebase room is authoritative: only the host may enter preview.
      if (!isHost && isFirebaseConfigured) {
        throw new Error('Only the host can start the game.');
      }
      const nextState = engineEnterPreview(state);
      dispatch({ type: A.START_GAME });

      if (isFirebaseConfigured && state.roomCode) {
        await syncEnterPreview(state.roomCode, nextState);
      }
    }, [state, isHost, isFirebaseConfigured]),

    beginRound: useCallback(async () => {
      if (!isHost && isFirebaseConfigured) return;
      const nextState = engineBeginPlaying(state);
      dispatch({ type: A.BEGIN_ROUND });

      if (isFirebaseConfigured && state.roomCode) {
        await syncBeginPlaying(
          state.roomCode,
          nextState,
          nextState.targets,
          nextState.displayTargets,
        );
        const pid = getCurrentUserId() || myPlayerId;
        if (pid) subscribeToMyTarget(state.roomCode, pid, nextState.roundId ?? null);
      }
    }, [state, isHost, myPlayerId, subscribeToMyTarget]),

    confirmOpponentGuess: useCallback(async () => {
      if (state.phase !== GAME_PHASES.PLAYING) return;
      const activeIds = state.players.map((p) => p.id);
      const isKnockout = state.mode === GAME_MODES.SOCIAL && activeIds.length === 4;
      const assignment = isKnockout
        ? state.playerAssignments?.[myPlayerId]
        : null;
      if (isKnockout
        ? (assignment?.matchId && state.matchResults?.[assignment.matchId])
        : hasCurrentRoundResult(state)) return;

      const opponentId = assignment?.opponentPlayerId ?? activeIds.find((id) => id !== myPlayerId);
      const opponent = state.players.find((p) => p.id === opponentId);
      if (assignment?.matchId && state.matchResults?.[assignment.matchId]) return;
      if (!opponent) return;

      const nextState = engineConfirmOpponentGuessed(state, {
        confirmerId: myPlayerId,
        guessedPlayerId: opponent.id,
      });
      if (state.mode === GAME_MODES.SOCIAL && activeIds.length > 2) {
        await syncImpostorAction(state.roomCode, {
          actionId: `action_${state.roundId}_${assignment?.matchId || "match"}_${state.bracket?.matches?.[assignment?.matchId]?.matchRound || 1}_${myPlayerId}`,
          actorUid: getCurrentUserId() || myPlayerId,
          type: 'confirm_guess',
          actorId: myPlayerId,
          targetPlayerId: opponent.id,
          opponentUid: opponent.id,
          matchId: assignment?.matchId ?? state.matchId,
          matchRound: state.bracket?.matches?.[assignment?.matchId]?.matchRound || 1,
          roundId: state.roundId,
          createdAt: Date.now(),
        });
        return;
      }

      const confirmEntry = {
        id: `confirm_${Date.now()}`,
        type: 'guess_confirm',
        confirmerId: myPlayerId,
        winnerId: opponent.id,
        playerId: myPlayerId,
        playerName: state.players.find((p) => p.id === myPlayerId)?.name ?? 'Player',
        timestamp: Date.now(),
      };

      if (isFirebaseConfigured && state.roomCode) {
        await syncSendChatMessage(state.roomCode, confirmEntry);
        if (isHost) {
          processedClaimsRef.current.add(confirmEntry.id);
          dispatch({
            type: A.CONFIRM_OPPONENT_GUESS,
            payload: { confirmerId: myPlayerId, guessedPlayerId: opponent.id },
          });
          await syncConfirmOpponentGuess(
            state.roomCode,
            nextState.scores,
            nextState.roundResult,
            nextState.revealEndTimestamp,
          );
        }
      } else {
        dispatch({
          type: A.CONFIRM_OPPONENT_GUESS,
          payload: { confirmerId: myPlayerId, guessedPlayerId: opponent.id },
        });
      }
    }, [state, myPlayerId, isHost]),

    sendChatMessage: useCallback(async (text) => {
      if (state.phase !== GAME_PHASES.PLAYING) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const playerName = state.players.find((p) => p.id === myPlayerId)?.name ?? 'Player';
      dispatch({
        type: A.SEND_CHAT,
        payload: { playerId: myPlayerId, playerName, text: trimmed },
      });

      if (isFirebaseConfigured && state.roomCode) {
        const msg = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          playerId: myPlayerId,
          playerName,
          message: trimmed,
          timestamp: Date.now(),
          type: 'chat',
        };
        await syncSendChatMessage(state.roomCode, msg);
      }
    }, [state, myPlayerId]),

    submitQuestion: useCallback(async (text) => {
      if (state.phase !== GAME_PHASES.PLAYING) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const playerName = state.players.find((p) => p.id === myPlayerId)?.name ?? 'Player';
      dispatch({
        type: A.SEND_CHAT,
        payload: { playerId: myPlayerId, playerName, text: trimmed },
      });

      if (isFirebaseConfigured && state.roomCode) {
        const msg = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          playerId: myPlayerId,
          playerName,
          message: trimmed,
          timestamp: Date.now(),
          type: 'chat',
        };
        await syncSendChatMessage(state.roomCode, msg);
      }
    }, [state, myPlayerId]),

    answerQuestion: useCallback(async (questionId, answer) => {
      dispatch({ type: A.ANSWER_QUESTION, payload: { questionId, answer } });
      if (isFirebaseConfigured && state.roomCode) {
        await syncAnswerQuestion(state.roomCode, questionId, answer);
      }
    }, [state]),

    submitGuess: useCallback(async (guessedItemId) => {
      const activePlayerId = state.currentTurnPlayerId;
      // Compute next state locally first
      const nextState = engineSubmitGuess(state, { guessedItemId, activePlayerId });
      dispatch({ type: A.SUBMIT_GUESS, payload: { guessedItemId, activePlayerId } });

      if (isFirebaseConfigured && state.roomCode) {
        const guessEntry = nextState.questions[nextState.questions.length - 1];
        await syncSubmitGuess(
          state.roomCode,
          guessEntry,
          nextState.scores,
          nextState.eliminatedCards,
          nextState.phase,
          nextState.currentTurnPlayerId,
          nextState.roundResult,
        );
      }
    }, [state]),

    toggleEliminateCard: useCallback(async (playerId, itemId) => {
      dispatch({ type: A.TOGGLE_ELIMINATE, payload: { playerId, itemId } });

      if (isFirebaseConfigured && state.roomCode) {
        const current = state.eliminatedCards[playerId] || [];
        const isElim = current.includes(itemId);
        const updated = isElim ? current.filter((id) => id !== itemId) : [...current, itemId];
        await syncToggleEliminate(state.roomCode, playerId, updated);
      }
    }, [state]),

    timerTick: useCallback(() => {
      dispatch({ type: A.TIMER_TICK });
    }, []),

    castVote: useCallback(async (voterId, targetId) => {
      dispatch({ type: A.CAST_VOTE, payload: { voterId, targetId } });
      if (isFirebaseConfigured && state.roomCode) {
        await syncCastVote(state.roomCode, voterId, targetId);
      }
    }, [state]),

    resolveVoting: useCallback(async () => {
      // Only host resolves to prevent duplicate resolution
      if (!isHost && isFirebaseConfigured) return;
      const nextState = engineResolveVoting(state);
      dispatch({ type: A.RESOLVE_VOTING });
      if (isFirebaseConfigured && state.roomCode) {
        await syncResolveVoting(state.roomCode, nextState.scores);
      }
    }, [state, isHost]),

    advanceRound: useCallback(async () => {
      // Only host advances round
      if (!isHost && isFirebaseConfigured) return;
      const nextState = engineAdvanceRound(state);
      dispatch({ type: A.ADVANCE_ROUND });
      if (isFirebaseConfigured && state.roomCode) {
        await syncAdvanceRound(state.roomCode, nextState);
        const pid = getCurrentUserId() || myPlayerId;
        if (pid && nextState.phase === GAME_PHASES.PLAYING) {
          subscribeToMyTarget(state.roomCode, pid, nextState.roundId ?? null);
        }
      }
    }, [state, isHost, myPlayerId, subscribeToMyTarget]),

    resetMatch: useCallback(async () => {
      // Rematch/reset is authoritative: only the host may reset a Firebase room.
      if (!isHost && isFirebaseConfigured) {
        throw new Error('Only the host can reset the match.');
      }
      dispatch({ type: A.RESET_MATCH });
      if (isFirebaseConfigured && state.roomCode) {
        const playersMap = {};
        state.players.forEach((p) => { playersMap[p.id] = p; });
        await syncResetMatch(state.roomCode, playersMap, state.category);
      }
    }, [state, isHost, isFirebaseConfigured]),

    leaveRoom: useCallback(async () => {
      const roomCode = state.roomCode;
      if (unsubscribeRoomRef.current) {
        unsubscribeRoomRef.current();
        unsubscribeRoomRef.current = null;
      }
      if (unsubscribeTargetRef.current) {
        unsubscribeTargetRef.current();
        unsubscribeTargetRef.current = null;
      }
      if (unsubscribeDisplayTargetRef.current) {
        unsubscribeDisplayTargetRef.current();
        unsubscribeDisplayTargetRef.current = null;
      }
      clearSession();
      dispatch({ type: A.ROOM_CLOSED });
      if (isFirebaseConfigured && roomCode) {
        await deleteFirebaseRoom(roomCode);
      }
    }, [state.roomCode]),

    setTimerRunning: useCallback((running) => {
      dispatch({ type: A.SET_TIMER_RUNNING, payload: { running } });
    }, []),

    canStart: useCallback(() => canStartGame(state.players), [state.players]),
    retrySessionRecovery: retryAutoRejoin,
    clearSessionRecovery,
    clearJoinDiagnostic: useCallback(() => setJoinDiagnostic(null), []),
  };

  // Derived values
  const myPlayer = state.players.find((p) => p.id === myPlayerId) ?? null;
  const latestUnansweredQuestion = state.questions
    .filter((q) => !q.isGuess && q.answer === null)
    .at(-1) ?? null;

  const value = {
    state: { ...state, roomCode: state.roomCode },
    actions,
    myPlayerId,
    myPlayer,
    isHost,
    isMyTurn: state.currentTurnPlayerId === myPlayerId,
    latestUnansweredQuestion,
    fbStatus,
    fbError,
    fbErrorCode,
    isFirebaseConfigured,
    recovery,
    joinDiagnostic,
    GAME_PHASES,
    GAME_MODES,
    CATEGORIES,
  };

  return (
    <GameStateContext.Provider value={value}>
      {children}
    </GameStateContext.Provider>
  );
}

export function useGameContext() {
  const ctx = useContext(GameStateContext);
  if (!ctx) throw new Error('useGameContext must be used within GameStateProvider');
  return ctx;
}

export const useGameState = useGameContext;
