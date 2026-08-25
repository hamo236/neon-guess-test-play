import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useGameContext } from '../context/GameStateContext';
import { CATEGORY_META } from '../data/gameData';
import { MAX_PLAYERS, MIN_PLAYERS, createPlayer, generateRoomCode } from '../game/roomManager';
import { getPlayerAvatar, getPlayerAvatarLabel, getRosterAvatarIndex } from '../ui/playerAvatars.js';
import { loadSession } from '../utils/sessionStorage';
import ActiveMatchRecoveryCard from '../components/ActiveMatchRecoveryCard';

const MOCK_NAMES = ['NeonNinja99', 'CyberViper', 'GhostByte', 'ZeroKelvin'];

const LobbyPage = () => {
  const {
    state, actions, GAME_PHASES, GAME_MODES, CATEGORIES,
    fbStatus, fbError, isFirebaseConfigured, isHost, myPlayerId, recovery, joinDiagnostic,
  } = useGameContext();
  const location = useLocation();
  const navigate = useNavigate();

  const [hostName, setHostName] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [roomCreated, setRoomCreated] = useState(false);
  const [addingPlayer, setAddingPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [lobbyMode, setLobbyMode] = useState('create'); // 'create' | 'join'
  const [inviteStatus, setInviteStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [diagnosticCopyStatus, setDiagnosticCopyStatus] = useState('');

  const { phase, players, roomCode, mode: stateMode, category } = state;
  const requestedLobbyMode = new URLSearchParams(location.search).get('mode');
  const isOneVOneRoute = location.pathname === '/one-v-one';
  const handleModeRailSelect = (nextMode) => {
    if (roomCreated || state.roomCode) return;
    if (nextMode === 'one_v_one') {
      actions.setMode(GAME_MODES.ONE_V_ONE);
      navigate('/one-v-one');
      return;
    }
    if (nextMode === 'team_battle') {
      navigate('/team-battle');
      return;
    }
    navigate('/tournament');
  };
  // URL/route intent is presentation-safe only while no room is active; Firebase/state remains authoritative for rooms.
  const isOneVOneIntent = (isOneVOneRoute || requestedLobbyMode === '1v1') && !roomCode;
  // 1V1 is a dedicated entry route. Home must remain the Four gateway even if a stale
  // local mode survives a previous 1V1 visit; the active Firebase room remains authoritative.
  const mode = isOneVOneIntent
    ? GAME_MODES.ONE_V_ONE
    : stateMode === GAME_MODES.ONE_V_ONE && !roomCode
      ? GAME_MODES.SOCIAL
      : stateMode;
  const isOneVOneLobby = mode === GAME_MODES.ONE_V_ONE;
  const isHomeRoute = location.pathname === '/' && !isOneVOneLobby;

  useEffect(() => {
    const session = loadSession();
    if (session?.roomCode && !joinCode) {
      setJoinCode(session.roomCode);
    }
  }, [joinCode]);

  useEffect(() => {
    if (roomCode) setRoomCreated(true);
  }, [roomCode]);

  const handleCreateRoom = async () => {
    if (isCreating || isJoining) return;
    if (!hostName.trim()) { setError('Enter your name.'); return; }
    if (!category) { setError('Please select a category first.'); return; }
    setError('');
    setIsCreating(true);
    try {
      await actions.createRoom({ name: hostName.trim(), mode, category });
      setRoomCreated(true);
    } catch (e) {
      setError(e.message || 'Failed to create room.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleShareInvite = async () => {
    if (!roomCode) return;
    setInviteStatus('');
    const inviteText = `Join my NEON GUESS room: ${roomCode}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Join my NEON GUESS room',
          text: inviteText,
        });
        setInviteStatus('Invite ready to share.');
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = inviteText;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setInviteStatus('Invite copied.');
    } catch (shareError) {
      if (shareError?.name !== 'AbortError') {
        setInviteStatus('Copy the room code below to invite players.');
      }
    }
  };

  const handleCopyRoomCode = async () => {
    if (!roomCode || !isOneVOneRoute) return;
    setCopyStatus('');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomCode);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = roomCode;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopyStatus('Code copied.');
    } catch (copyError) {
      setCopyStatus('Copy failed.');
    }
  };

  const handleCopyJoinDiagnostic = async () => {
    if (!joinDiagnostic) return;
    const report = [
      `NEON GUESS Join diagnostic`,
      `Stage: ${joinDiagnostic.stage}`,
      `Status: ${joinDiagnostic.status}`,
      `Code: ${joinDiagnostic.code}`,
      `Message: ${joinDiagnostic.message}`,
      joinDiagnostic.attempt ? `Attempt: ${joinDiagnostic.attempt}` : '',
      `Correlation: ${joinDiagnostic.correlationId || 'unavailable'}`,
      `Elapsed: ${Number.isFinite(joinDiagnostic.elapsedMs) ? `${joinDiagnostic.elapsedMs}ms` : 'unavailable'}`,
      `Browser online: ${joinDiagnostic.connection?.browserOnline == null ? 'unknown' : joinDiagnostic.connection.browserOnline}`,
      `Network: ${joinDiagnostic.connection?.effectiveType || joinDiagnostic.connection?.connectionType || 'unknown'}`,
      `Time: ${joinDiagnostic.recordedAt || 'unavailable'}`,
    ].filter(Boolean).join('\n');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(report);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = report;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setDiagnosticCopyStatus('Diagnostic copied.');
    } catch {
      setDiagnosticCopyStatus('Copy failed. Take a screenshot of this panel.');
    }
  };

  const handleJoinRoom = async () => {
    if (isCreating || isJoining) return;
    actions.clearJoinDiagnostic?.();
    setDiagnosticCopyStatus('');
    if (!/^\d{3}$/.test(joinCode.trim())) { setError('Enter the 3-digit room code.'); return; }
    if (!joinName.trim()) { setError('Enter your name.'); return; }
    setError('');
    setIsJoining(true);
    try {
      const result = await actions.joinRoom({ code: joinCode.trim(), name: joinName.trim() });
      setRoomCreated(true);
      if (result?.phase === GAME_PHASES.PREVIEW || result?.phase === GAME_PHASES.PLAYING) {
        navigate('/game');
      } else if (
        result?.phase === GAME_PHASES.ROUND_END ||
        result?.phase === GAME_PHASES.RESULTS ||
        result?.phase === GAME_PHASES.VOTING
      ) {
        navigate('/results');
      }
    } catch (e) {
      setError(e.message || 'Failed to join room.');
    } finally {
      setIsJoining(false);
    }
  };

  const handleAddMockPlayer = () => {
    const maxForMode = mode === GAME_MODES.ONE_V_ONE ? 2 : MAX_PLAYERS;
    if (players.length >= maxForMode) {
      setError(`Maximum ${maxForMode} players reached.`);
      return;
    }
    const name = newPlayerName.trim() ||
      MOCK_NAMES.find((n) => !players.some((p) => p.name === n)) ||
      `Player_${players.length + 1}`;
    actions.addMockPlayer(name);
    setNewPlayerName('');
    setError('');
    setAddingPlayer(false);
  };

  const handleRemovePlayer = async (player) => {
    if (!isHost || player.id === myPlayerId) return;
    if (!window.confirm(`Remove ${player.name} from this room?`)) return;
    try {
      await actions.removePlayer(player.id);
    } catch (e) {
      setError(e.message || 'Failed to remove player.');
    }
  };

  const handleStartGame = async () => {
    if (isStarting) return;
    if (players.length < MIN_PLAYERS) {
      setError(`Need at least ${MIN_PLAYERS} players.`);
      return;
    }
    if (mode === GAME_MODES.ONE_V_ONE && players.length !== 2) {
      setError('1v1 mode requires exactly 2 players.');
      return;
    }
    if (!category) { setError('Select a category.'); return; }
    setError('');
    setIsStarting(true);
    try {
      await actions.startGame();
      navigate('/game');
    } catch (e) {
      setError(e.message || 'The game could not start.');
      setIsStarting(false);
    }
  };

  const canStart = mode === GAME_MODES.ONE_V_ONE
    ? players.length === 2 && !!category
    : players.length >= MIN_PLAYERS && !!category;
  const canModifyLobby = !roomCode || !isFirebaseConfigured || isHost;

  // Bottom navigation uses ?mode=1v1 to create a real route transition.
  // Sync that route intent into the existing lobby state without touching room or Firebase logic.
  useEffect(() => {
    const requestedMode = isOneVOneRoute || requestedLobbyMode === '1v1' ? '1v1' : null;
    if (requestedMode !== '1v1') return;
    if (stateMode === GAME_MODES.ONE_V_ONE) return;
    if (!canModifyLobby) return;
    actions.setMode(GAME_MODES.ONE_V_ONE);
  }, [isOneVOneRoute, requestedLobbyMode, stateMode, GAME_MODES.ONE_V_ONE, canModifyLobby, actions]);

  return (
    <main className={`ng-page-shell ng-home-gateway flex-1 w-full max-w-6xl mx-auto px-container-margin pt-24 pb-32 md:pt-32 relative z-10 flex flex-col gap-stack-lg ${isOneVOneLobby ? 'ng-1v1-visual-reset' : ''}`} aria-labelledby="home-gateway-title">
      {/* Full-site visual gateway: presentation-only hierarchy for every mode entry. */}
      <div className="ng-home-gateway__intro" aria-labelledby="home-gateway-title">
        <p className="ng-home-gateway__eyebrow font-label-caps text-label-caps">{isOneVOneLobby ? '1V1 · READY' : 'PLAY MODES'}</p>
        <h2 id="home-gateway-title" className={`ng-home-gateway__title text-on-surface ${isOneVOneLobby ? 'font-display-lg text-display-lg' : 'font-headline-md text-headline-md'}`}>{isOneVOneLobby ? '1V1 GUESS WHO' : 'CHOOSE YOUR MODE'}</h2>
        <p className="ng-home-gateway__subcopy font-body-sm text-body-sm text-on-surface-variant">{isOneVOneLobby ? 'A private duel for two players.' : 'Pick a mode to start.'}</p>
      </div>

      {/* Mobile Title */}
      <div className="md:hidden flex justify-center items-center mb-stack-md">
        <h1 className="font-display-lg text-display-lg text-primary-fixed uppercase tracking-tighter neon-text-glow">
          NEON GUESS
        </h1>
      </div>

      {/* First-class mode entry: presentation-only identity for the selected room flow. */}
      {isOneVOneLobby && !isOneVOneRoute ? null : !isOneVOneRoute ? (
        <div className="contents">
        <section className="ng-home-route-card premium-2v2-hero glass-panel-2 rounded-2xl p-5 sm:p-7 border border-secondary-fixed/35 overflow-hidden" aria-labelledby="team-battle-title">
        <div className="flex flex-col lg:flex-row lg:items-center gap-5">
          <div className="relative shrink-0 w-full lg:w-44 min-h-32 rounded-xl border border-secondary-fixed/30 bg-gradient-to-br from-secondary/35 via-primary/10 to-transparent flex items-center justify-center overflow-hidden" aria-hidden="true">
            <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full bg-secondary-fixed/20 blur-2xl" />
            <div className="absolute -bottom-10 -left-4 w-28 h-28 rounded-full bg-primary-fixed/20 blur-2xl" />
            <span className="material-symbols-outlined text-6xl text-secondary-fixed relative">groups</span>
            <span className="absolute bottom-3 left-3 font-stats-num text-stats-num text-white/80">2 × 2</span>
          </div>
          <div className="flex-1">
            <div className="premium-kicker" style={{ color: '#e9b3ff' }}>Featured team mode</div>
            <h2 id="team-battle-title" className="font-display-lg text-display-lg text-white mt-1">2v2 TEAM BATTLE</h2>
            <p className="text-sm sm:text-base text-on-surface-variant mt-2 max-w-2xl">Build two teams of two, share a target with your teammate, and outguess the opposing pair across three synchronized rounds.</p>
            <div className="flex flex-wrap gap-2 mt-4" aria-label="2v2 Team Battle features">
              <span className="premium-pill">4 players</span>
              <span className="premium-pill">Shared team targets</span>
              <span className="premium-pill">Host starts</span>
            </div>
          </div>
          <button type="button" onClick={() => navigate('/team-battle')} className="premium-cta touch-feedback min-h-12 w-full lg:w-auto shrink-0 bg-secondary-fixed/15 border border-secondary-fixed/50 text-secondary-fixed hover:bg-secondary-fixed/25 transition-colors" aria-label="Open 2v2 Team Battle">
            ENTER TEAM BATTLE
          </button>
        </div>
        </section>
        <section className="ng-home-route-card premium-1v1-hero glass-panel-2 rounded-2xl p-5 sm:p-7 border border-primary-fixed/35 overflow-hidden" aria-labelledby="one-v-one-home-title">
          <div className="flex flex-col lg:flex-row lg:items-center gap-5">
            <div className="relative shrink-0 w-full lg:w-44 min-h-32 rounded-xl border border-primary-fixed/30 bg-gradient-to-br from-primary/25 via-secondary/10 to-transparent flex items-center justify-center overflow-hidden" aria-hidden="true">
              <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full bg-primary-fixed/20 blur-2xl" />
              <div className="absolute -bottom-10 -left-4 w-28 h-28 rounded-full bg-secondary-fixed/20 blur-2xl" />
              <span className="material-symbols-outlined text-6xl text-primary-fixed relative">swords</span>
              <span className="absolute bottom-3 left-3 font-stats-num text-stats-num text-white/80">1 × 1</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="premium-kicker" style={{ color: '#7df4ff' }}>Featured duel mode</div>
              <h2 id="one-v-one-home-title" className="font-display-lg text-display-lg text-white mt-1">1V1 GUESS WHO</h2>
              <p className="text-sm sm:text-base text-on-surface-variant mt-2 max-w-2xl">A focused private duel for two players. Create a room or join a friend without choosing a category on Home.</p>
              <div className="flex flex-wrap gap-2 mt-4" aria-label="1v1 Guess Who features">
                <span className="premium-pill">2 players</span>
                <span className="premium-pill">Private duel</span>
                <span className="premium-pill">Host starts</span>
              </div>
            </div>
            <button type="button" onClick={() => navigate('/one-v-one')} className="premium-cta touch-feedback min-h-12 w-full lg:w-auto shrink-0 bg-primary-fixed/15 border border-primary-fixed/50 text-primary-fixed hover:bg-primary-fixed/25 transition-colors" aria-label="Open 1v1 Guess Who" aria-pressed={mode === GAME_MODES.ONE_V_ONE}>
              ENTER 1V1
            </button>
          </div>
        </section>
        </div>
      ) : null}

      {!isOneVOneLobby && (
      <>
      <section className="ng-home-route-card glass-panel-2 premium-command-card rounded-xl p-stack-lg border border-secondary-fixed/25">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="premium-kicker" style={{ color: '#e9b3ff' }}>Daily drop</div>
            <h2 className="font-headline-md text-headline-md text-white mt-1">One quick challenge, every day</h2>
            <div className="flex flex-wrap gap-2 mt-3" aria-label="Daily Drop details">
              <span className="premium-pill">5 guesses</span>
              <span className="premium-pill">Device-only score</span>
            </div>
            <p className="text-sm text-on-surface-variant mt-1">Five guesses using the same NEON GUESS items. Your score stays on this device and never changes multiplayer rooms.</p>
          </div>
          <button type="button" onClick={() => navigate('/daily')} className="premium-cta touch-feedback shrink-0 w-full sm:w-auto bg-secondary-fixed/15 border border-secondary-fixed/40 text-secondary-fixed hover:bg-secondary-fixed/25 transition-colors">
            PLAY TODAY'S DROP
          </button>
        </div>
      </section>
      <button type="button" onClick={() => navigate('/how-to-play')} className="group mx-auto flex min-h-11 items-center gap-2 rounded-full border border-primary-fixed/25 bg-primary-fixed/5 px-4 py-2.5 text-primary-fixed shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-[transform,background-color,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-primary-fixed/55 hover:bg-primary-fixed/10 hover:shadow-[0_12px_30px_rgba(0,0,0,0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-fixed/70">
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-primary-fixed/35 bg-primary-fixed/10" aria-hidden="true"><span className="material-symbols-outlined text-[16px]">help</span></span>
        <span className="font-label-caps text-[10px] tracking-[0.16em]">HOW TO PLAY</span>
      </button>
      </>
      )}

      {!isHomeRoute && (
      <>
      {/* Firebase Status Banner */}
      <section className="ng-status-stack order-last w-full rounded-full border border-white/10 bg-white/[0.025] px-3 py-2 sm:px-4" aria-labelledby="lobby-status-title">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary-fixed text-[18px]" aria-hidden="true">monitor_heart</span>
          <h2 id="lobby-status-title" className="font-label-caps text-[9px] tracking-[0.14em] text-on-surface-variant">ROOM STATUS</h2>
        </div>
      {isFirebaseConfigured && fbStatus !== 'local' && (
        <div className={`ng-connection-capsule glass-panel-1 rounded-full px-3 py-1.5 flex min-w-0 items-center gap-2 border text-xs font-body-sm leading-snug break-words ${
          fbStatus === 'ready' ? 'border-primary-fixed/30 text-primary-fixed' :
          fbStatus === 'error' ? 'border-error/40 text-error' :
          'border-white/10 text-on-surface-variant'
        }`}>
          <div aria-hidden="true" className={`ng-connection-capsule__dot w-2 h-2 rounded-full ${
            fbStatus === 'ready' ? 'bg-primary-fixed animate-pulse' :
            fbStatus === 'error' ? 'bg-error' : 'bg-on-surface-variant animate-pulse'
          }`} />
          <span className="shrink-0 font-label-caps text-[9px] tracking-[0.12em]">{fbStatus === 'ready' ? 'REAL-TIME READY' : fbStatus === 'error' ? 'CONNECTION ERROR' : 'CONNECTING'}</span>
          {fbStatus === 'ready' ? 'Firebase Connected — Real-time Multiplayer Active' :
           fbStatus === 'error' ? (fbError || 'Firebase connection error') :
           'Connecting to Firebase…'}
        </div>
      )}
      {!isFirebaseConfigured && (
        <div className="ng-connection-capsule glass-panel-1 rounded-full px-3 py-1.5 flex min-w-0 items-center gap-2 border border-secondary/30 text-secondary text-xs font-body-sm leading-snug break-words">
          <span aria-hidden="true" className="ng-connection-capsule__icon material-symbols-outlined text-[16px]">info</span>
          <span className="shrink-0 font-label-caps text-[9px] tracking-[0.12em]">LOCAL MODE</span>
          Local mode — Firebase not configured. Add credentials to .env to enable real-time multiplayer.
        </div>
      )}
      {fbError && (
        <div className="ng-connection-capsule glass-panel-1 rounded-full px-3 py-1.5 flex min-w-0 items-center gap-2 border border-error/40 text-error text-xs font-body-sm leading-snug break-words">
          <span aria-hidden="true" className="ng-connection-capsule__icon material-symbols-outlined text-[16px]">error</span>
          <span className="shrink-0 font-label-caps text-[9px] tracking-[0.12em]">CONNECTION ERROR</span>
          {fbError}
        </div>
      )}
      <div className="mt-3" aria-label="Active match recovery">
      <ActiveMatchRecoveryCard
        recovery={recovery}
        onRetry={actions.retrySessionRecovery}
        onDismiss={() => {
          actions.clearSessionRecovery();
          setJoinCode('');
          setLobbyMode('create');
          setError('');
        }}
      />
      </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter lg:gap-stack-lg">
        {/* ── Left Column ───────────────────────────────────────────────── */}
        <div className="lg:col-span-8 flex flex-col gap-stack-lg">

          {/* Category Selector is intentionally kept out of Home and appears only after a room exists. */}
          {roomCreated && !isOneVOneLobby ? (
          <section className="ng-home-route-card ng-category-spotlight glass-panel-2 rounded-xl p-stack-lg flex flex-col gap-stack-md">
            <h2 className="font-headline-md text-headline-md text-on-surface flex items-center gap-2">
              <span className="material-symbols-outlined text-primary-fixed">category</span>
              Select Category
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-gutter">
              {Object.values(CATEGORY_META).map((cat) => {
                const isActive = category === cat.id;
                return (
                  <button
                    type="button"
                    key={cat.id}
                    aria-pressed={isActive}
                    onClick={() => canModifyLobby && actions.setCategory(cat.id)}
                    disabled={!canModifyLobby}
                    className={`touch-feedback relative overflow-hidden rounded-lg aspect-square sm:aspect-auto sm:h-32 glass-panel-1 flex flex-col justify-end p-4 group transition-all duration-300 motion-reduce:transition-none hover:scale-[1.02] active:scale-[0.98] motion-reduce:hover:scale-100 motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-fixed/80 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim ${
                      isActive ? 'neon-border-glow' : 'border border-white/10 hover:border-white/30'
                    } ${!canModifyLobby ? 'cursor-not-allowed opacity-70' : ''}`}
                  >
                    <div className="absolute inset-0 bg-gradient-to-t from-surface-dim to-transparent z-10" />
                    <div
                      className={`absolute inset-0 bg-cover bg-center mix-blend-screen transition-opacity z-0 ${
                        isActive ? 'opacity-40 group-hover:opacity-60' : 'opacity-30 group-hover:opacity-50'
                      }`}
                      style={{ backgroundImage: `url('${cat.image}')` }}
                    />
                    <div className="relative z-20 flex flex-col items-start gap-1">
                      <span className={`material-symbols-outlined text-3xl mb-1 transition-colors ${
                        isActive ? 'text-primary-fixed drop-shadow-[0_0_8px_rgba(125,244,255,0.8)]' : 'text-on-surface-variant group-hover:text-primary'
                      }`}>{cat.icon}</span>
                      <span className={`font-headline-sm text-headline-sm transition-colors ${
                        isActive ? 'text-white drop-shadow-md' : 'text-on-surface group-hover:text-white'
                      }`}>{cat.label}</span>
                    </div>
                    {isActive && (
                      <div className="absolute top-3 right-3 z-20 w-3 h-3 rounded-full bg-primary-fixed shadow-[0_0_10px_#7df4ff]" />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
          ) : null}

          {/* Shared room-entry composition for 1v1: presentation-only alignment with 2v2/Four. */}
          {isOneVOneLobby && !roomCreated && (
            <section className="ng-home-route-card glass-panel-heavy rounded-xl p-5 sm:p-8 space-y-5 border border-primary-fixed/20" aria-labelledby="one-v-one-room-entry-title">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-label-caps text-label-caps text-primary-fixed">ROOM MODE</p>
                  <h2 id="one-v-one-room-entry-title" className="font-display-lg text-display-lg text-white">PLAY WITH FRIENDS</h2>
                  <p className="text-on-surface-variant mt-2">Create or join a private 1v1 Guess Who room.</p>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-secondary-fixed/25 bg-secondary-fixed/5 px-3 py-1.5 font-label-caps text-[10px] tracking-[0.12em] text-secondary-fixed">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">swords</span>
                  1V1 DUEL
                </span>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="ng-room-name-field rounded-lg border border-secondary-fixed/20 bg-secondary-fixed/[0.035] px-3 py-2.5">
                  <span className="block font-label-caps text-[9px] tracking-[0.14em] text-secondary-fixed">PLAYER NAME</span>
                  <input value={hostName || joinName} onChange={(e) => { setHostName(e.target.value); setJoinName(e.target.value); }} placeholder="Your name" aria-label="Your name" required maxLength={32} autoComplete="nickname" className="mt-1 min-h-8 w-full bg-transparent text-white placeholder:text-on-surface-variant/70 focus-visible:outline-none" />
                </label>
                <label className="ng-room-category-field rounded-lg border border-primary-fixed/20 bg-primary-fixed/[0.035] px-3 py-2.5">
                  <span className="block font-label-caps text-[9px] tracking-[0.14em] text-primary-fixed">PLAY TYPE</span>
                  <select value={category} onChange={(e) => actions.setCategory(e.target.value)} aria-label="Game category" className="mt-1 min-h-8 w-full bg-transparent text-white focus-visible:outline-none">
                    {Object.values(CATEGORY_META).map((cat) => <option key={cat.id} value={cat.id} className="bg-surface-dim text-white">{cat.label}</option>)}
                  </select>
                </label>
                <label className="ng-room-join-field rounded-lg border border-secondary-fixed/20 bg-secondary-fixed/[0.035] px-3 py-2.5">
                  <span className="block font-label-caps text-[9px] tracking-[0.14em] text-secondary-fixed">ROOM JOIN ID</span>
                  <span className="mt-1 flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-primary-fixed/80" aria-hidden="true">key</span>
                    <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="Paste room code" aria-label="Room ID to join" inputMode="numeric" pattern="[0-9]{3}" maxLength={3} autoComplete="one-time-code" className="min-h-8 min-w-0 flex-1 bg-transparent text-white placeholder:text-on-surface-variant/70 focus-visible:outline-none" />
                  </span>
                </label>
              </div>

              <div className="ng-room-entry-actions flex flex-col gap-3 sm:flex-row" role="group" aria-label="Room actions">
                <button type="button" onClick={handleCreateRoom} disabled={fbStatus === 'initializing' || isCreating || isJoining} aria-busy={isCreating} className="ng-create-room-action touch-feedback min-h-11 flex-1 rounded-lg bg-primary-fixed px-4 py-3 font-headline-sm text-on-primary-fixed disabled:opacity-40 active:scale-95">
                  <span className="ng-room-entry-action__index" aria-hidden="true">01</span>
                  <span className="ng-room-entry-action__meta" aria-hidden="true">NEW ROOM</span>
                  <span className="material-symbols-outlined align-middle text-[18px]" aria-hidden="true">add_box</span>
                  <span className="ng-room-entry-action__text">{isCreating ? 'Creating…' : 'Create Room'}</span>
                </button>
                <button type="button" onClick={handleJoinRoom} disabled={!isFirebaseConfigured || fbStatus !== 'ready' || !joinCode.trim() || isCreating || isJoining} aria-busy={isJoining} className="ng-join-room-action touch-feedback min-h-11 flex-1 rounded-lg border border-primary-fixed/50 px-4 py-3 font-headline-sm text-primary-fixed disabled:opacity-40 active:scale-95">
                  <span className="ng-room-entry-action__index" aria-hidden="true">02</span>
                  <span className="ng-room-entry-action__meta" aria-hidden="true">PASTE CODE</span>
                  <span className="material-symbols-outlined align-middle text-[18px]" aria-hidden="true">login</span>
                  <span className="ng-room-entry-action__text">{isJoining ? 'Joining…' : 'Join Room'}</span>
                </button>
              </div>
            </section>
          )}

          {/* Create / Join Toggle + Mode Selector for existing 1v1 room state and legacy-compatible flow. */}
          {(!isOneVOneLobby || roomCreated) && <section className={`ng-home-route-card glass-panel-2 premium-command-card rounded-xl p-stack-lg flex flex-col gap-stack-md border border-primary-fixed/15 ${isOneVOneLobby ? 'ng-1v1-reference-lobby p-3 sm:p-5 gap-stack-sm border-primary-fixed/30 bg-gradient-to-br from-white/[0.06] via-primary-fixed/[0.03] to-transparent' : ''}`}>
            {/* Create / Join tab switcher */}
            <div role="group" aria-label="Lobby setup" className={`ng-lobby-setup-switch ng-segment-control relative flex p-1 glass-panel-1 rounded-lg border border-white/10 w-full sm:max-w-xs mb-2 ${''}`}>
              <div className={`absolute inset-y-1 w-[calc(50%-4px)] bg-primary-fixed/20 backdrop-blur-md rounded-md border border-primary-fixed/50 shadow-[0_0_15px_rgba(125,244,255,0.2)] transition-transform duration-300 ease-out z-0 ${lobbyMode === 'create' ? 'translate-x-0 left-1' : 'translate-x-[calc(100%+4px)] left-1'}`} />
              <button type="button" aria-pressed={lobbyMode === 'create'} onClick={() => setLobbyMode('create')} className={`touch-feedback relative flex-1 min-h-11 py-2 text-center z-10 font-body-sm text-body-sm transition-colors ${lobbyMode === 'create' ? 'text-primary-fixed font-semibold' : 'text-on-surface-variant hover:text-white'}`}>Create Room</button>
              <button type="button" aria-pressed={lobbyMode === 'join'} onClick={() => setLobbyMode('join')} className={`touch-feedback relative flex-1 min-h-11 py-2 text-center z-10 font-body-sm text-body-sm transition-colors ${lobbyMode === 'join' ? 'text-primary-fixed font-semibold' : 'text-on-surface-variant hover:text-white'}`}>Join Room</button>
            </div>

            {lobbyMode === 'create' ? (
              <div className="ng-lobby-mobile-actions flex flex-col sm:flex-row gap-stack-lg items-start sm:items-center justify-between">
                <div className="flex-1 w-full flex flex-col gap-stack-sm">
                  {/* Addition 154: Room Launch Header — presentation-only context for the selected mode. */}
                  <div className="ng-room-launch-header mb-2 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-secondary-fixed/20 bg-secondary-fixed/[0.035] px-3.5 py-3 sm:px-4">
                    <div className="min-w-0">
                      <p className="premium-kicker">ROOM</p>
                      <h2 className="mt-1 flex items-center gap-2 font-headline-md text-headline-md text-on-surface">
                        <span className="material-symbols-outlined text-secondary-fixed" aria-hidden="true">{isOneVOneLobby ? 'swords' : 'tune'}</span>
                        Create Room
                      </h2>
                    </div>
                    <span className="shrink-0 rounded-full border border-primary-fixed/25 bg-primary-fixed/[0.06] px-2.5 py-1 font-label-caps text-label-caps text-primary-fixed" aria-label={`Selected mode: ${mode === GAME_MODES.ONE_V_ONE ? '1v1 Guess Who' : 'Four Impostor'}`}>
                      {mode === GAME_MODES.ONE_V_ONE ? '1V1' : 'FOUR IMPOSTOR'}
                    </span>
                  </div>
                  <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                    <h3 className="font-label-caps text-label-caps text-on-surface-variant">Game mode</h3>
                  </div>
                  {!isOneVOneRoute && (
                    <div className="ng-mode-selector ng-segment-control relative flex p-1 glass-panel-1 rounded-xl border border-white/10 bg-black/10 shadow-[0_0_22px_rgba(125,244,255,0.06)] w-full sm:max-w-md" role="group" aria-label="Choose game mode">
                      <div className="ng-mode-selector__rail relative w-full">
                        <button type="button" data-mode="social" aria-pressed="true" onClick={() => canModifyLobby && actions.setMode(GAME_MODES.SOCIAL)} className="ng-mode-selector__option touch-feedback group relative min-w-0 min-h-12 w-full py-2.5 px-3 text-left sm:text-center font-body-lg text-body-lg text-primary-fixed font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-fixed/80 focus-visible:ring-inset">
                          <span className="ng-mode-selector__option-content flex min-w-0 items-center gap-2 justify-center">
                            <span className="ng-mode-selector__option-icon material-symbols-outlined shrink-0 text-[19px] leading-none text-secondary-fixed/85" aria-hidden="true">groups</span>
                            <span className="min-w-0">
                              <span className="ng-mode-selector__option-title block min-w-0 leading-tight">Four <span className="ng-mode-selector__option-tag">IMPOSTOR</span></span>
                              <span className="ng-mode-selector__option-meta block min-w-0 whitespace-normal text-[11px] leading-tight">Social room strategy</span>
                            </span>
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
                  {mode === GAME_MODES.ONE_V_ONE && !roomCreated && (
                    <fieldset className="ng-1v1-play-type-rail mt-3 w-full" aria-label="Choose play type">
                      <legend className="ng-1v1-play-type-label mb-2 font-label-caps text-label-caps text-primary-fixed">Play type</legend>
                      <div className="ng-1v1-play-type-options grid grid-cols-1 gap-2 sm:grid-cols-3">
                        {Object.values(CATEGORY_META).map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            aria-pressed={category === cat.id}
                            onClick={() => canModifyLobby && actions.setCategory(cat.id)}
                            disabled={!canModifyLobby}
                            className="ng-1v1-play-type-option touch-feedback min-h-11 rounded-lg border px-3 py-2 text-left font-body-sm text-body-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-fixed/70 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <span className="block truncate">{cat.label}</span>
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  {mode === GAME_MODES.SOCIAL && (
                    <p className="font-body-sm text-body-sm text-secondary mt-1 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]">timer</span>
                      8-minute synchronized round timer
                    </p>
                  )}
                </div>

                {!roomCreated ? (
                  /* Addition 155: Host Identity Field — explicit label/helper grouping, same value and change trace. */
                  <div className="ng-lobby-input-guidance ng-host-identity-field w-full sm:w-auto flex flex-col gap-2.5 rounded-xl border border-primary-fixed/20 bg-primary-fixed/[0.04] p-3.5 sm:p-4">
                    <div className="flex items-start gap-2.5">
                      <span className="material-symbols-outlined mt-0.5 text-[18px] text-primary-fixed" aria-hidden="true">badge</span>
                      <div className="min-w-0">
                        <label htmlFor="host-name" className="font-label-caps text-label-caps text-primary-fixed">Host</label>
                      </div>
                    </div>
                    <input
                      id="host-name"
                      value={hostName}
                      onChange={(e) => setHostName(e.target.value)}
                      placeholder="Your name"
                      aria-label="Your name"
                      aria-describedby="host-name-help"
                      className="w-full sm:w-56 bg-white/5 border border-white/10 rounded-lg py-3 px-3.5 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary-fixed/60 focus-visible:ring-2 focus-visible:ring-primary-fixed/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim placeholder-on-surface-variant/50"
                    />
                    {/* Addition 156: Primary Create Action — stronger static emphasis, same handler and disabled truth. */}
                    <button
                      onClick={handleCreateRoom}
                      disabled={fbStatus === 'initializing' || isCreating || isJoining}
                      className="premium-cta touch-feedback min-h-12 bg-primary-fixed text-on-primary-fixed font-headline-sm text-headline-sm px-8 py-3.5 rounded-lg shadow-[0_0_20px_rgba(125,244,255,0.4)] hover:shadow-[0_0_30px_rgba(125,244,255,0.6)] hover:bg-primary transition-all active:scale-95 duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-fixed/80 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim flex items-center justify-center gap-2 w-full whitespace-nowrap disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined font-bold" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden="true">{isCreating ? 'progress_activity' : 'add_circle'}</span>
                      {isCreating ? 'Creating…' : 'Create Room'}
                    </button>
                  </div>
                ) : (
                  <div className="ng-room-created-card w-full sm:w-auto flex flex-col gap-3 items-center rounded-xl border border-primary-fixed/20 bg-primary-fixed/5 px-5 py-4 shadow-[0_0_24px_rgba(125,244,255,0.12)]">
                    <p className="font-label-caps text-label-caps text-primary-fixed neon-text-glow">Room Created!</p>
                    <p className="ng-room-code-label font-label-caps text-label-caps text-on-surface-variant">Invite code</p>
                                         <div className="ng-room-code-row flex w-full items-center justify-center gap-2">
                       <span className="ng-room-code-primary min-w-32 rounded-lg border border-primary-fixed/30 bg-surface-dim/60 px-4 py-2 text-center font-stats-num text-stats-num text-primary-fixed tracking-[0.28em] text-2xl neon-text-glow" aria-label={`Room code ${roomCode}`}>{roomCode}</span>
                       {isOneVOneRoute && (
                         <button
                           type="button"
                           onClick={handleCopyRoomCode}
                           className="ng-room-code-copy touch-feedback inline-flex shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-fixed/80 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim"
                           aria-label="Copy room code"
                           title="Copy room code"
                         >
                           <span className="material-symbols-outlined text-[18px]" aria-hidden="true">content_copy</span>
                         </button>
                       )}
                     </div>
                     <p className="ng-room-share-instruction font-body-sm text-body-sm text-on-surface-variant text-xs">Send this code to your squad to join.</p>
                     {isOneVOneRoute && copyStatus && (
                       <p className="ng-room-copy-status font-body-sm text-body-sm text-primary-fixed text-xs" role="status" aria-live="polite">{copyStatus}</p>
                     )}

                    <button
                      type="button"
                      onClick={handleShareInvite}
                      className="ng-room-share-action premium-cta touch-feedback mt-1 min-h-11 w-full sm:w-auto px-4 py-2 rounded-md border border-primary-fixed/40 text-primary-fixed font-label-caps text-label-caps hover:bg-primary-fixed/10 active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-fixed/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim"
                      aria-label="Share the room invite"
                    >
                      <span className="material-symbols-outlined text-[16px] align-middle mr-1">share</span>
                      SHARE INVITE
                    </button>
                    {inviteStatus && (
                      <p className="ng-invite-status-beacon ng-room-share-status font-body-sm text-body-sm text-primary-fixed text-xs mt-1" role="status" aria-live="polite">
                        {inviteStatus}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
              {/* Join Room panel */}
              <div className="ng-join-room-context mb-1 rounded-lg border border-secondary-fixed/15 bg-secondary-fixed/[0.035] px-3 py-2" role="note">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-secondary-fixed" aria-hidden="true">login</span>
                  <p className="font-label-caps text-label-caps text-secondary-fixed">Join a room</p>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">Use the name and code shared by your host.</p>
              </div>
              <div className="ng-lobby-mobile-actions flex flex-col sm:flex-row gap-4 items-start sm:items-end">
                <div className="ng-lobby-input-guidance flex-1 flex flex-col gap-2">
                  <label htmlFor="join-name" className="font-label-caps text-label-caps text-on-surface-variant">Your Name</label>
                  <input
                    id="join-name"
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="Enter your name"
                    className="w-full bg-white/5 border border-white/10 rounded-lg py-3 px-4 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary-fixed/50 focus-visible:ring-2 focus-visible:ring-primary-fixed/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim placeholder-on-surface-variant/50"
                  />
                </div>
                <div className="ng-lobby-input-guidance flex-1 flex flex-col gap-2">
                  <label htmlFor="join-code" className="ng-join-code-label font-label-caps text-label-caps text-primary-fixed">Room Code <span className="text-on-surface-variant">· 3 digits</span></label>
                  <input
                    id="join-code"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="e.g. 781"
                    maxLength={3}
                    inputMode="numeric"
                    pattern="[0-9]{3}"
                    className="ng-join-code-input w-full bg-white/5 border border-primary-fixed/20 rounded-lg py-3 px-4 font-stats-num text-stats-num text-primary-fixed tracking-widest focus:outline-none focus:border-primary-fixed/50 focus-visible:ring-2 focus-visible:ring-primary-fixed/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim placeholder-on-surface-variant/30"
                    aria-describedby="join-code-help"
                  />
                  <p id="join-code-help" className="ng-join-code-help font-body-sm text-body-sm text-on-surface-variant text-xs">Enter the 3-digit room code.</p>
                </div>
                <button
                  type="button"
                  onClick={handleJoinRoom}
                  disabled={!isFirebaseConfigured || fbStatus !== 'ready' || isJoining || isCreating}
                  className="ng-join-room-action premium-cta touch-feedback min-h-12 w-full sm:w-auto px-8 py-3 rounded-lg bg-secondary text-on-secondary font-headline-sm text-headline-sm shadow-[0_0_15px_rgba(233,179,255,0.3)] hover:shadow-[0_0_25px_rgba(233,179,255,0.5)] transition-all active:scale-95 duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-45 disabled:grayscale disabled:shadow-none disabled:bg-surface-container disabled:text-on-surface-variant disabled:border disabled:border-white/10 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>{isJoining ? 'progress_activity' : 'login'}</span>
                  {isJoining ? 'Joining…' : 'Join Room'}
                </button>
                  {!isFirebaseConfigured && (
                  <p className="ng-join-requirement-note ng-lobby-action-explanation font-body-sm text-body-sm text-on-surface-variant text-xs">Firebase required to join rooms.</p>
                )}
              </div>
              </>
            )}
          </section>}

          {joinDiagnostic && joinDiagnostic.status === 'failed' && (
            <div
              role="status"
              className="ng-join-diagnostic-frame mb-3 rounded-xl border border-amber-300/30 bg-amber-300/5 px-4 py-3 text-amber-100 shadow-[0_0_24px_rgba(251,191,36,0.08)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-label-caps text-label-caps text-amber-200">Join diagnostic</p>
                  <p className="mt-1 font-body-sm text-body-sm">The first failed step was recorded. Send this code to the game owner.</p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyJoinDiagnostic}
                  className="shrink-0 rounded-lg border border-amber-200/30 px-3 py-2 font-label-caps text-label-caps text-amber-100 hover:bg-amber-200/10"
                >
                  Copy report
                </button>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-1 font-mono text-xs sm:grid-cols-2">
                <div><dt className="inline text-amber-200/70">Stage: </dt><dd className="inline break-all">{joinDiagnostic.stage}</dd></div>
                <div><dt className="inline text-amber-200/70">Code: </dt><dd className="inline break-all font-bold">{joinDiagnostic.code}</dd></div>
                <div><dt className="inline text-amber-200/70">Correlation: </dt><dd className="inline break-all">{joinDiagnostic.correlationId || 'unavailable'}</dd></div>
                <div><dt className="inline text-amber-200/70">Elapsed: </dt><dd className="inline">{Number.isFinite(joinDiagnostic.elapsedMs) ? `${joinDiagnostic.elapsedMs}ms` : 'unavailable'}</dd></div>
                <div><dt className="inline text-amber-200/70">Browser online: </dt><dd className="inline">{joinDiagnostic.connection?.browserOnline == null ? 'unknown' : String(joinDiagnostic.connection.browserOnline)}</dd></div>
                <div><dt className="inline text-amber-200/70">Network: </dt><dd className="inline">{joinDiagnostic.connection?.effectiveType || joinDiagnostic.connection?.connectionType || 'unknown'}</dd></div>
                <div className="sm:col-span-2"><dt className="inline text-amber-200/70">Message: </dt><dd className="inline break-words">{joinDiagnostic.message}</dd></div>
              </dl>
              {diagnosticCopyStatus && <p className="mt-2 text-xs text-amber-200" role="status">{diagnosticCopyStatus}</p>}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="ng-lobby-error-frame flex items-start gap-3 rounded-xl border border-error/30 bg-error/5 px-4 py-3 text-error shadow-[0_0_24px_rgba(255,100,140,0.08)]"
            >
              <span
                className="material-symbols-outlined mt-0.5 shrink-0 text-[18px]"
                aria-hidden="true"
              >
                error
              </span>
              <p className="min-w-0 font-body-sm text-body-sm leading-relaxed text-error">
                {error}
              </p>
            </div>
          )}
        </div>

        {/* ── Right Column: Lobby ──────────────────────────────────────── */}
        <div className={`lg:col-span-4 flex flex-col gap-stack-lg ${isOneVOneLobby ? 'ng-1v1-waiting-column' : ''}`}>
          <section className="glass-panel-2 rounded-xl p-stack-lg flex-1 flex flex-col relative overflow-hidden">
            <div className="absolute -top-20 -right-20 w-64 h-64 bg-primary-fixed/10 rounded-full blur-[80px] pointer-events-none" />

            <div className="flex justify-between items-start mb-stack-md relative z-10">
              <div className="min-w-0">
                {mode === GAME_MODES.SOCIAL && (
                  <p className="ng-social-lobby-kicker font-label-caps text-label-caps text-secondary-fixed mb-1">Social deduction room</p>
                )}
                <h2 className="font-headline-md text-headline-md text-on-surface flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary-fixed" aria-hidden="true">groups</span>
                  <span aria-label="Waiting room">WAITING ROOM</span>
                </h2>
                <div className="ng-social-lobby-count-row flex flex-wrap items-center gap-2 mt-1">
                  <p className="font-body-sm text-body-sm text-on-surface-variant">Players ({players.length}/{mode === GAME_MODES.ONE_V_ONE ? 2 : MAX_PLAYERS})</p>
                  {mode === GAME_MODES.SOCIAL && (
                    <span className="ng-social-capacity-pill font-label-caps text-label-caps" aria-label="Social mode supports 2 to 4 players">2–4 players</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-start justify-end gap-2">
                {mode === GAME_MODES.SOCIAL && (
                  <div className="ng-social-timer-capsule glass-panel-1 px-3 py-2 rounded-md border border-secondary-fixed/25 flex items-center gap-2" role="note">
                    <span className="material-symbols-outlined text-[16px] text-secondary-fixed" aria-hidden="true">timer</span>
                    <span className="font-label-caps text-label-caps text-secondary-fixed">8 min rounds</span>
                  </div>
                )}
                {roomCode && (
                  <div className="ng-room-code-spotlight glass-panel-1 px-3 py-2 rounded-md border border-white/20 flex flex-col items-end">
                    <span className="font-label-caps text-label-caps text-on-surface-variant mb-1">Code</span>
                    <span className="font-stats-num text-stats-num text-primary-fixed tracking-widest neon-text-glow">{roomCode}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Player list */}
            <div className="ng-presence-ledger flex flex-col gap-3 flex-1 relative z-10 mb-stack-lg">
              {players.map((player, index) => (
                <div key={player.id} className={`ng-player-row glass-panel-1 touch-feedback group rounded-xl p-3 flex items-center gap-3 border transition-all duration-200 ${player.isHost ? 'border-primary-fixed/30 bg-primary-fixed/5 shadow-[0_0_18px_rgba(125,244,255,0.08)]' : 'border-white/10 hover:border-primary-fixed/20 hover:bg-white/[0.04]'}`}>
                  {mode === GAME_MODES.SOCIAL && (
                    <span className="ng-roster-seat-badge shrink-0 font-stats-num text-stats-num" aria-label={`Roster seat ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
                  )}
                  <div className="relative">
                    <img src={getPlayerAvatar(player, getRosterAvatarIndex(players, player))} alt={getPlayerAvatarLabel(player, getRosterAvatarIndex(players, player))} className={`w-10 h-10 rounded-full object-cover border-2 ${player.isHost ? 'border-primary-fixed' : 'border-white/30'}`} loading="lazy" />
                    {player.isHost && (
                      <div className="absolute -top-1 -right-1 bg-surface-dim rounded-full p-[2px]">
                        <span className="material-symbols-outlined text-[12px] text-secondary-fixed" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                      </div>
                    )}
                    {/* Connection indicator */}
                    <div className={`ng-player-connection-dot absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-surface-dim ${player.connected === false ? 'bg-error' : 'bg-primary'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`font-body-lg text-body-lg truncate ${player.isHost ? 'text-white' : 'text-on-surface'}`}>{player.name}{player.id === myPlayerId ? ' (You)' : ''}</p>
                    <p className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 font-label-caps text-label-caps mt-1 ${player.isHost ? 'border-primary-fixed/25 bg-primary-fixed/10 text-primary-fixed' : player.connected === false ? 'border-error/30 bg-error/10 text-error' : 'border-white/10 bg-white/[0.04] text-on-surface-variant'}`}>
                      {player.isHost ? 'Host' : player.connected === false ? 'Disconnected' : (player.status || 'Ready')}
                    </p>
                  </div>
                  <span className={`material-symbols-outlined ${player.connected === false ? 'text-error' : player.isHost ? 'text-primary-fixed' : 'text-on-surface-variant'}`}>
                    {player.connected === false ? 'wifi_off' : 'check_circle'}
                  </span>
                  {roomCreated && phase === GAME_PHASES.LOBBY && isHost && player.id !== myPlayerId && (
                    <button
                      type="button"
                      onClick={() => handleRemovePlayer(player)}
                      className="touch-feedback min-h-10 font-label-caps text-[10px] text-error border border-error/50 rounded-md px-2.5 py-1.5 hover:bg-error/10 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dim"
                    >
                      <span className="material-symbols-outlined mr-1 align-middle text-[14px]" aria-hidden="true">person_remove</span>
                      REMOVE PLAYER
                    </button>
                  )}
                </div>
              ))}

              {Array.from({ length: Math.max(0, MIN_PLAYERS - players.length) }).map((_, i) => (
                <div key={`empty-${i}`} className="ng-lobby-empty-slot rounded-xl p-3 flex items-center gap-3 border border-dashed border-primary-fixed/20 bg-primary-fixed/5 opacity-60">
                  <div className="w-10 h-10 rounded-full border border-dashed border-white/40 flex items-center justify-center bg-black/20">
                    <span className="material-symbols-outlined text-white/40">person_add</span>
                  </div>
                  <div className="flex-1"><p className="font-label-caps text-label-caps text-primary-fixed/70">Waiting for player</p><p className="font-body-sm text-body-sm text-white/40 mt-0.5">Open slot</p></div>
                </div>
              ))}
            </div>

            {roomCreated && mode === GAME_MODES.SOCIAL && players.length < MIN_PLAYERS && (
              <div className="ng-social-waiting-explainer relative z-10 mb-3 rounded-lg border px-3 py-2" role="status" aria-live="polite">
                <div className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[18px] text-secondary-fixed" aria-hidden="true">hourglass_top</span>
                  <div className="min-w-0">
                    <p className="font-label-caps text-label-caps text-secondary-fixed">Room is collecting players</p>
                    <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">Join the open seat to unlock the existing start requirement.</p>
                  </div>
                </div>
              </div>
            )}

            {roomCreated && mode === GAME_MODES.SOCIAL && (
              <div className="ng-social-readiness-lane relative z-10 mb-3 rounded-lg border px-3 py-2" role="group" aria-label={`Social room readiness: ${players.length} of ${MIN_PLAYERS} minimum players`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-label-caps text-label-caps text-on-surface-variant">Readiness</span>
                  <span className="font-stats-num text-stats-num text-primary-fixed">{Math.min(players.length, MIN_PLAYERS)}/{MIN_PLAYERS}</span>
                </div>
                <div className="ng-social-readiness-track mt-2" aria-hidden="true">
                  <span className="ng-social-readiness-fill" style={{ width: `${Math.min(100, (players.length / MIN_PLAYERS) * 100)}%` }} />
                </div>
              </div>
            )}

            {roomCreated && mode === GAME_MODES.ONE_V_ONE && players.length < 2 && (
              <div className="ng-1v1-waiting-state mb-3 relative z-10" role="status" aria-live="polite">
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">hourglass_top</span>
                <span>Waiting for player · 1/2</span>
              </div>
            )}

            {/* Add mock player (local mode or host in firebase mode) */}
            {roomCreated && players.length < (mode === GAME_MODES.ONE_V_ONE ? 2 : MAX_PLAYERS) && canModifyLobby && !isFirebaseConfigured && (
              <div className="mb-3 relative z-10">
                {addingPlayer ? (
                  <div className="flex gap-2">
                    <input value={newPlayerName} onChange={(e) => setNewPlayerName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddMockPlayer()} placeholder="Player name…" className="flex-1 bg-white/5 border border-white/10 rounded-lg py-2 px-3 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary-fixed/50 placeholder-on-surface-variant/50" autoFocus />
                    <button onClick={handleAddMockPlayer} className="px-3 py-2 rounded-lg bg-primary-fixed/20 border border-primary-fixed/40 text-primary-fixed text-sm active:scale-95 transition-transform">Add</button>
                    <button onClick={() => setAddingPlayer(false)} className="px-2 py-2 rounded-lg bg-white/5 border border-white/10 text-on-surface-variant text-sm">✕</button>
                  </div>
                ) : (
                  <button onClick={() => setAddingPlayer(true)} className="w-full py-2 rounded-lg glass-panel-1 border border-dashed border-white/30 text-on-surface-variant font-body-sm text-body-sm hover:border-primary-fixed/40 hover:text-primary-fixed transition-colors flex items-center justify-center gap-2 active:scale-95">
                    <span className="material-symbols-outlined text-[18px]">person_add</span>
                    Add Mock Player
                  </button>
                )}
              </div>
            )}

            {/* Lobby Actions */}
            <div className="ng-lobby-action-dock ng-action-surface ng-start-gate-clarity ng-start-readiness-rail flex flex-col gap-3 mt-auto relative z-10">
              <button
                type="button"
                onClick={handleStartGame}
                disabled={!canStart || !roomCreated || (!canModifyLobby)}
                className={`touch-feedback button-click-motion font-headline-sm text-headline-sm py-4 rounded-lg transition-all active:scale-95 duration-150 flex items-center justify-center gap-2 ${canStart && roomCreated && canModifyLobby ? 'bg-surface-tint text-on-primary-fixed shadow-[0_0_15px_rgba(0,219,233,0.3)] hover:shadow-[0_0_25px_rgba(0,219,233,0.5)]' : 'bg-surface-container text-on-surface-variant opacity-50 cursor-not-allowed'}`}
              >
                <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>{isStarting ? 'progress_activity' : 'play_arrow'}</span>
                {isStarting ? 'Starting…' : canModifyLobby ? 'Start Game' : 'Waiting for host to start…'}
              </button>
              {roomCreated && mode === GAME_MODES.SOCIAL && (
                <p className="ng-social-action-note text-center font-label-caps text-label-caps text-on-surface-variant text-[10px] mt-1" role="note">
                  {isStarting ? 'Room transition in progress.' : canStart ? (canModifyLobby ? 'Host can start when ready.' : 'Waiting for the host to start.') : 'The start button unlocks when the room minimum is met.'}
                </p>
              )}
              {roomCreated && mode === GAME_MODES.ONE_V_ONE && players.length !== 2 && (
                <p className="text-center font-label-caps text-label-caps text-error text-[10px] mt-1">
                  1v1 requires exactly 2 players ({players.length}/2)
                </p>
              )}
              {roomCreated && mode !== GAME_MODES.ONE_V_ONE && players.length < MIN_PLAYERS && (
                <p className="text-center font-label-caps text-label-caps text-error text-[10px] mt-1">
                  Requires {MIN_PLAYERS - players.length} more player{MIN_PLAYERS - players.length > 1 ? 's' : ''}
                </p>
              )}

            </div>
          </section>
        </div>
      </div>
      </>
      )}
    </main>
  );
};

export default LobbyPage;
