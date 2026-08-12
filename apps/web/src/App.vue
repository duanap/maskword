<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { io, type Socket } from "socket.io-client";
import {
  PhArrowLeft as ArrowLeft,
  PhArrowRight as ArrowRight,
  PhCaretDown as CaretDown,
  PhCheckCircle as CheckCircle,
  PhCrown as Crown,
  PhDoorOpen as DoorOpen,
  PhEye as Eye,
  PhEyeSlash as EyeSlash,
  PhGearSix as GearSix,
  PhInfo as Info,
  PhMaskHappy as MaskHappy,
  PhMoon as Moon,
  PhPlay as Play,
  PhSignOut as SignOut,
  PhShareNetwork as ShareNetwork,
  PhSparkle as Sparkle,
  PhSun as Sun,
  PhSpinnerGap as SpinnerGap,
  PhUser as User,
  PhWarningCircle as WarningCircle,
  PhWifiHigh as WifiHigh,
  PhWifiSlash as WifiSlash,
} from "@phosphor-icons/vue";
import { AVATAR_IDS, DEFAULT_ROLE_CONFIGS, roleConfigError } from "@maskword/shared";
import type {
  Ack,
  AvatarId,
  ClientToServerEvents,
  ErrorCode,
  Role,
  RoomConfig,
  RoomSnapshot,
  ServerToClientEvents,
  SessionCredentials,
  VoteSubmission,
} from "@maskword/shared";
import AvatarBadge from "./components/AvatarBadge.vue";
import VictoryHero from "./components/VictoryHero.vue";
import undercoverMarkUrl from "./assets/undercover-mark.webp";
import offlineHeroUrl from "./assets/maskword-offline-hero.webp";
import { buildRoomInviteUrl, extractRoomCode, normalizeRoomCodeInput } from "./online-utils";
import { createThemeController } from "./theme";

type LandingScreen = "modes" | "online" | "create" | "join" | "offline";
type ConfirmAction = "leave" | "dissolve" | "finish-runoff" | null;
type ConnectionState = "connecting" | "recovering" | "online" | "offline";

const SESSION_KEY = "maskword-session-v1";
const ROUND_RESULT_DURATION_MS = 5_000;
const ROOM_RECOVERY_ACK_TIMEOUT_MS = 8_000;
const ROOM_RECOVERY_RETRY_DELAY_MS = 1_500;
const TERMINAL_RECOVERY_ERRORS = new Set<ErrorCode>(["RECOVERY_FAILED", "ROOM_NOT_FOUND", "ROOM_CLOSED"]);
const savedSession = localStorage.getItem(SESSION_KEY);
const initialInviteRoomCode = savedSession
  ? null
  : extractRoomCode(new URL(window.location.href).searchParams.get("room"));
const OfflineGame = defineAsyncComponent(() => import("./offline/OfflineGame.vue"));
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ autoConnect: false });
const screen = ref<LandingScreen>(
  initialInviteRoomCode
    ? "join"
    : localStorage.getItem("maskword-offline-v2") && !savedSession
      ? "offline"
      : "modes",
);
const snapshot = ref<RoomSnapshot | null>(null);
const nickname = ref(localStorage.getItem("maskword-nickname") ?? "");
const roomCode = ref(initialInviteRoomCode ?? "");
const roomCodeInput = ref<HTMLInputElement | null>(null);
const nicknameInput = ref<HTMLInputElement | null>(null);
const connectionState = ref<ConnectionState>("offline");
const busy = ref(false);
const roleVisible = ref(false);
const selectedVoteTarget = ref<string | null | undefined>(undefined);
const selfDestructGuess = ref("");
const customCivilianWord = ref("");
const customUndercoverWord = ref("");
const now = ref(Date.now());
const toast = ref<{ message: string; tone: "info" | "success" | "error" } | null>(null);
const modal = ref<{ title: string; body: string; type: "info" | "warning" } | null>(null);
const confirmAction = ref<ConfirmAction>(null);
const roomManagementOpen = ref(false);
const advancedConfigOpen = ref(false);
const joinNicknameEditing = ref(!nickname.value.trim());
const participantCount = ref(6);
const roleTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const toastTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const recoveryTimeout = ref<ReturnType<typeof setTimeout> | null>(null);
const recoveryRetryTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const recoveryPending = ref(false);
let recoveryAttempt = 0;
const pwaUpdateReady = ref(false);
const ticker = setInterval(() => (now.value = Date.now()), 1_000);
const theme = createThemeController();

const roomConfig = ref<RoomConfig>({
  ...DEFAULT_ROLE_CONFIGS[6]!,
  hostParticipates: true,
});

const totalConfigured = computed(
  () => roomConfig.value.civilianCount + roomConfig.value.undercoverCount + roomConfig.value.blankCount + roomConfig.value.doubleAgentCount,
);
const self = computed(() => snapshot.value?.players.find((player) => player.id === snapshot.value?.selfId) ?? null);
const isHost = computed(() => snapshot.value?.hostId === snapshot.value?.selfId);
const playerById = computed(() => new Map(snapshot.value?.players.map((player) => [player.id, player]) ?? []));
const occupiedAvatarIds = computed(
  () => new Set(snapshot.value?.players.filter((player) => player.id !== snapshot.value?.selfId).map((player) => player.avatarId) ?? []),
);
const aliveCount = computed(() => snapshot.value?.players.filter((player) => player.isParticipating && player.isAlive).length ?? 0);
const voteSeconds = computed(() => {
  const deadline = snapshot.value?.voting?.deadlineAt;
  return deadline ? Math.max(0, Math.ceil((deadline - now.value) / 1_000)) : null;
});
const roundResultSeconds = computed(() => {
  const deadline = snapshot.value?.roundResultEndsAt;
  return deadline ? Math.max(0, Math.ceil((deadline - now.value) / 1_000)) : 0;
});
const roundResultProgress = computed(() => {
  const deadline = snapshot.value?.roundResultEndsAt;
  if (!deadline) return 0;
  return Math.max(0, Math.min(100, ((deadline - now.value) / ROUND_RESULT_DURATION_MS) * 100));
});
const canSubmitVote = computed(
  () => connectionState.value === "online" && snapshot.value?.voting?.canVote && selectedVoteTarget.value !== undefined && !busy.value,
);
const speakingSeconds = computed(() => {
  const deadline = snapshot.value?.speaking?.deadlineAt;
  return deadline ? Math.max(0, Math.ceil((deadline - now.value) / 1_000)) : null;
});
const normalizedNickname = computed(() => nickname.value.trim().replace(/\s+/g, " "));
const nicknameValid = computed(() => {
  const length = [...normalizedNickname.value].length;
  return length >= 1 && length <= 12;
});
const roomCodeValid = computed(() => /^\d{6}$/.test(roomCode.value));
const runoffTallyById = computed(
  () => new Map(snapshot.value?.voting?.runoffTallies?.map((item) => [item.playerId, item.votes]) ?? []),
);
const configError = computed(() => {
  const difference = participantCount.value - totalConfigured.value;
  if (difference > 0) return `当前已分配 ${totalConfigured.value} 人，还需增加 ${difference} 人`;
  if (difference < 0) return `当前已分配 ${totalConfigured.value} 人，需要减少 ${Math.abs(difference)} 人`;
  return roleConfigError(roomConfig.value);
});
const configValid = computed(() => configError.value === null);
const attendanceSummary = computed(() =>
  roomConfig.value.hostParticipates
    ? `参赛 ${participantCount.value} 人，还需邀请 ${participantCount.value - 1} 名玩家`
    : `参赛 ${participantCount.value} 人，现场共 ${participantCount.value + 1} 人，还需邀请 ${participantCount.value} 名玩家`,
);
const selectedVoteLabel = computed(() => {
  if (selectedVoteTarget.value === undefined) return "尚未选择";
  if (selectedVoteTarget.value === null) return "弃权";
  return playerName(selectedVoteTarget.value);
});
const canShowPwaUpdate = computed(
  () => pwaUpdateReady.value && screen.value === "modes" && !snapshot.value && !localStorage.getItem("maskword-offline-v2"),
);
const roomConnectionReady = computed(() => socket.connected && connectionState.value === "online");
const connectionLabel = computed(() => {
  if (connectionState.value === "online") return "已连接";
  if (connectionState.value === "connecting") return "连接中";
  if (connectionState.value === "recovering") return "正在同步房间";
  return "重连中";
});

const phaseTitle = computed(() => {
  const phase = snapshot.value?.phase;
  if (phase === "WAITING") return "房间大厅";
  if (phase === "SPEAKING") return `第${snapshot.value?.round}轮 · 发言阶段`;
  if (phase === "VOTING") return `第${snapshot.value?.round}轮 · 匿名投票`;
  if (phase === "RUNOFF") return `第${snapshot.value?.round}轮 · 平票重投`;
  if (phase === "ROUND_RESULT") return `第${snapshot.value?.round}轮 · 投票结果`;
  if (phase === "ENDED") return "游戏结束";
  return "谁是卧底";
});

const roleLabels: Record<Role, string> = {
  CIVILIAN: "平民",
  UNDERCOVER: "卧底",
  BLANK: "白板",
  DOUBLE_AGENT: "双面间谍",
};

const modeLabels: Record<RoomConfig["mode"], string> = {
  CLASSIC_REVEALED: "经典明牌",
  CLASSIC_HIDDEN: "经典暗牌",
  EXPLOSIVE_REVEALED: "明牌自爆",
  EXPLOSIVE_HIDDEN: "暗牌自爆",
};

const categoryOptions = [
  ["GENERAL", "全民精选"], ["FUNNY", "欢乐搞笑"], ["IDIOM", "成语文化"], ["FOOD", "食物饮品"],
  ["ANIMAL_NATURE", "动物自然"], ["DAILY", "日常生活"], ["SCHOOL_WORK", "校园职场"], ["TRAVEL", "旅行出行"],
  ["ENTERTAINMENT", "影视综艺"], ["TECH", "数码互联网"], ["MEDICAL", "医学健康"], ["GAME", "游戏通用"],
  ["HONOR_OF_KINGS", "王者荣耀英雄"], ["CAR", "汽车"], ["SCIENCE", "轻科普"],
] as const;
const snapshotCategoryLabel = computed(() => {
  const category = snapshot.value?.config.wordCategory;
  return category === "GENERAL" ? "全民精选" : categoryOptions.find((item) => item[0] === category)?.[1] ?? "全民精选";
});

function showToast(message: string, tone: "info" | "success" | "error" = "info") {
  toast.value = { message, tone };
  if (toastTimer.value) clearTimeout(toastTimer.value);
  toastTimer.value = setTimeout(() => (toast.value = null), 3_200);
}

function clearToast() {
  toast.value = null;
  if (toastTimer.value) clearTimeout(toastTimer.value);
  toastTimer.value = null;
}

function getSession(): SessionCredentials | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionCredentials) : null;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(credentials: SessionCredentials) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
  localStorage.setItem("maskword-nickname", nickname.value.trim());
}

function clearSession() {
  cancelRoomRecovery();
  localStorage.removeItem(SESSION_KEY);
  snapshot.value = null;
  roleVisible.value = false;
  selectedVoteTarget.value = undefined;
}

function clearRecoveryTimers() {
  if (recoveryTimeout.value) clearTimeout(recoveryTimeout.value);
  if (recoveryRetryTimer.value) clearTimeout(recoveryRetryTimer.value);
  recoveryTimeout.value = null;
  recoveryRetryTimer.value = null;
}

function cancelRoomRecovery() {
  recoveryAttempt += 1;
  recoveryPending.value = false;
  clearRecoveryTimers();
}

function scheduleRoomRecovery() {
  if (recoveryRetryTimer.value || !getSession()) return;
  recoveryRetryTimer.value = setTimeout(() => {
    recoveryRetryTimer.value = null;
    synchronizeRoomConnection();
  }, ROOM_RECOVERY_RETRY_DELAY_MS);
}

function handleRecoveryTimeout(attempt: number) {
  if (attempt !== recoveryAttempt) return;
  recoveryPending.value = false;
  recoveryTimeout.value = null;
  connectionState.value = socket.connected ? "recovering" : "offline";
  scheduleRoomRecovery();
}

function synchronizeRoomConnection() {
  const session = getSession();
  if (!session) {
    cancelRoomRecovery();
    connectionState.value = socket.connected ? "online" : "offline";
    return;
  }
  if (!socket.connected) {
    connectionState.value = "connecting";
    socket.connect();
    return;
  }
  if (recoveryPending.value) return;

  clearRecoveryTimers();
  recoveryPending.value = true;
  connectionState.value = "recovering";
  const attempt = ++recoveryAttempt;
  recoveryTimeout.value = setTimeout(() => handleRecoveryTimeout(attempt), ROOM_RECOVERY_ACK_TIMEOUT_MS);
  socket.emit("room:resume", session, (result) => {
    if (attempt !== recoveryAttempt) return;
    if (recoveryTimeout.value) clearTimeout(recoveryTimeout.value);
    recoveryTimeout.value = null;
    if (!result.ok) {
      recoveryPending.value = false;
      if (TERMINAL_RECOVERY_ERRORS.has(result.code)) {
        clearSession();
        connectionState.value = "online";
        screen.value = "online";
        showToast(result.message, "error");
        return;
      }
      scheduleRoomRecovery();
      return;
    }
    recoveryPending.value = true;
    if (recoveryRetryTimer.value) clearTimeout(recoveryRetryTimer.value);
    recoveryRetryTimer.value = null;
    // 传输层已连接不代表房间状态已恢复；必须等待服务端的全量快照。
    recoveryTimeout.value = setTimeout(() => handleRecoveryTimeout(attempt), ROOM_RECOVERY_ACK_TIMEOUT_MS);
  });
}

function ensureRoomConnectionReady(): boolean {
  if (socket.connected && connectionState.value === "online") return true;
  synchronizeRoomConnection();
  showToast("正在恢复房间，请稍候");
  return false;
}

function handleAck(result: Ack, success?: () => void) {
  busy.value = false;
  if (!result.ok) {
    showToast(result.message, "error");
    return;
  }
  success?.();
}

function ensureNickname(): boolean {
  const clean = normalizedNickname.value;
  if (!clean || [...clean].length > 12) {
    showToast("请输入 1–12 个字符的昵称", "error");
    return false;
  }
  nickname.value = clean;
  localStorage.setItem("maskword-nickname", clean);
  return true;
}

function ensureSocketConnected() {
  if (socket.connected) {
    if (getSession() && connectionState.value !== "online") synchronizeRoomConnection();
    return;
  }
  if (socket.active) {
    connectionState.value = "connecting";
    return;
  }
  connectionState.value = "connecting";
  socket.connect();
}

function openOnline() {
  screen.value = "online";
  ensureSocketConnected();
}

async function openRoomPath(nextScreen: "create" | "join") {
  if (!ensureNickname()) return;
  ensureSocketConnected();
  screen.value = nextScreen;
  if (nextScreen === "join") {
    joinNicknameEditing.value = false;
    await nextTick();
    roomCodeInput.value?.focus();
  }
}

function createRoom() {
  if (!ensureNickname() || !configValid.value) {
    if (!configValid.value) showToast("身份配置不满足开局条件", "error");
    return;
  }
  ensureSocketConnected();
  busy.value = true;
  const customWords = !roomConfig.value.hostParticipates && customCivilianWord.value.trim() && customUndercoverWord.value.trim()
    ? { civilian: customCivilianWord.value.trim(), undercover: customUndercoverWord.value.trim() }
    : undefined;
  socket.emit("room:create", { nickname: nickname.value, config: roomConfig.value, ...(customWords ? { customWords } : {}) }, (result) => {
    handleAck(result, () => {
      if (result.ok && "data" in result) saveSession(result.data);
    });
  });
}

function joinRoom() {
  if (!ensureNickname()) return;
  const code = extractRoomCode(roomCode.value);
  if (!code) {
    showToast("请输入 6 位房间号", "error");
    return;
  }
  ensureSocketConnected();
  busy.value = true;
  socket.emit("room:join", { nickname: nickname.value, roomCode: code }, (result) => {
    handleAck(result, () => {
      if (result.ok && "data" in result) saveSession(result.data);
    });
  });
}

function simpleAction(
  action: "room:leave" | "room:dissolve" | "game:start" | "game:startSpeaking" | "game:endSpeaking" | "game:beginVote" | "game:advanceRound" | "vote:finishRunoff" | "game:rematch",
) {
  if (!ensureRoomConnectionReady()) return;
  busy.value = true;
  const ack = (result: Ack) =>
    handleAck(result, () => {
      if (action === "room:leave" || action === "room:dissolve") {
        clearSession();
        screen.value = "online";
      }
      confirmAction.value = null;
      roomManagementOpen.value = false;
    });
  if (action === "room:leave") socket.emit("room:leave", ack);
  else if (action === "room:dissolve") socket.emit("room:dissolve", ack);
  else if (action === "game:start") socket.emit("game:start", ack);
  else if (action === "game:startSpeaking") socket.emit("game:startSpeaking", ack);
  else if (action === "game:endSpeaking") socket.emit("game:endSpeaking", ack);
  else if (action === "game:beginVote") socket.emit("game:beginVote", ack);
  else if (action === "game:advanceRound") socket.emit("game:advanceRound", ack);
  else if (action === "vote:finishRunoff") socket.emit("vote:finishRunoff", ack);
  else socket.emit("game:rematch", ack);
}

function submitVote() {
  if (!ensureRoomConnectionReady() || !canSubmitVote.value) return;
  const submittedPhase = snapshot.value?.phase;
  busy.value = true;
  const submission: VoteSubmission = {
    targetPlayerId: selectedVoteTarget.value ?? null,
    ...(snapshot.value?.voting?.canGuess && selfDestructGuess.value.trim() ? { guess: selfDestructGuess.value.trim() } : {}),
  };
  socket.emit("vote:submit", submission, (result) => {
    handleAck(result, () => {
      selectedVoteTarget.value = undefined;
      selfDestructGuess.value = "";
      if (snapshot.value?.phase === submittedPhase) showToast("投票已匿名提交", "success");
    });
  });
}

function transferHost(targetId: string) {
  if (!ensureRoomConnectionReady()) return;
  busy.value = true;
  socket.emit("room:transferHost", targetId, (result) => handleAck(result, () => showToast("房主已转移", "success")));
}

function changeAvatar(avatarId: AvatarId) {
  if (!snapshot.value?.permissions.canChangeAvatar || busy.value || !ensureRoomConnectionReady()) return;
  busy.value = true;
  socket.emit("room:changeAvatar", avatarId, (result) => handleAck(result));
}

async function inviteRoom() {
  if (!snapshot.value) return;
  const code = snapshot.value.roomCode;
  const url = buildRoomInviteUrl(window.location.origin, code);
  if (navigator.share) {
    try {
      await navigator.share({ title: "谁是卧底", text: `加入我的谁是卧底房间 ${code}`, url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(code);
    showToast("房间号已复制", "success");
  } catch {
    showToast(`房间号：${code}`);
  }
}

function toggleRole() {
  if (!snapshot.value?.privateIdentity) return;
  roleVisible.value = !roleVisible.value;
  if (roleTimer.value) clearTimeout(roleTimer.value);
  if (roleVisible.value) roleTimer.value = setTimeout(() => (roleVisible.value = false), 5_000);
}

function hideRole() {
  roleVisible.value = false;
  if (roleTimer.value) clearTimeout(roleTimer.value);
}

function handleVisibilityChange() {
  hideRole();
  if (document.visibilityState === "visible" && getSession()) synchronizeRoomConnection();
}

function handlePageShow() {
  hideRole();
  if (getSession()) synchronizeRoomConnection();
}

function handleNetworkOnline() {
  if (getSession()) synchronizeRoomConnection();
  else ensureSocketConnected();
}

function handlePwaUpdate() {
  pwaUpdateReady.value = true;
}

function applyPwaUpdate() {
  if (localStorage.getItem("maskword-offline-v2") || snapshot.value || screen.value !== "modes") return;
  void window.maskwordApplyUpdate?.();
}

function adjustConfig(key: "civilianCount" | "undercoverCount" | "blankCount" | "doubleAgentCount", delta: number) {
  const limits: readonly [number, number] = key === "blankCount" || key === "doubleAgentCount" ? [0, 2] : [1, participantCount.value - 1];
  roomConfig.value[key] = Math.min(limits[1], Math.max(limits[0], roomConfig.value[key] + delta));
}

function adjustParticipantCount(delta: number) {
  participantCount.value = Math.min(12, Math.max(3, participantCount.value + delta));
  const preset = DEFAULT_ROLE_CONFIGS[participantCount.value];
  if (!preset) return;
  roomConfig.value = { ...preset, hostParticipates: roomConfig.value.hostParticipates, resultAdvance: roomConfig.value.resultAdvance };
}

function handleRoomCodeInput(event: Event) {
  roomCode.value = normalizeRoomCodeInput((event.target as HTMLInputElement).value);
}

function handleRoomCodePaste(event: ClipboardEvent) {
  event.preventDefault();
  roomCode.value = normalizeRoomCodeInput(event.clipboardData?.getData("text") ?? "");
}

async function editJoinNickname() {
  joinNicknameEditing.value = true;
  await nextTick();
  nicknameInput.value?.focus();
}

function consumeInviteParameter() {
  if (!initialInviteRoomCode) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function goBack() {
  if (screen.value === "create" || screen.value === "join") screen.value = "online";
  else if (screen.value === "online") screen.value = "modes";
}

function playerName(playerId: string | null): string {
  if (!playerId) return "无人";
  return playerById.value.get(playerId)?.nickname ?? "已退出玩家";
}

function confirmCurrentAction() {
  if (confirmAction.value === "leave") simpleAction("room:leave");
  else if (confirmAction.value === "dissolve") simpleAction("room:dissolve");
  else if (confirmAction.value === "finish-runoff") simpleAction("vote:finishRunoff");
}

socket.on("connect", () => {
  if (getSession()) synchronizeRoomConnection();
  else connectionState.value = "online";
});
socket.on("disconnect", () => {
  cancelRoomRecovery();
  connectionState.value = "offline";
  busy.value = false;
  hideRole();
});
socket.on("connect_error", () => {
  connectionState.value = "offline";
});
socket.io.on("reconnect_attempt", () => {
  connectionState.value = "connecting";
});
socket.on("room:snapshot", (nextSnapshot) => {
  const phaseChanged = snapshot.value !== null && snapshot.value.phase !== nextSnapshot.phase;
  if (phaseChanged) {
    clearToast();
    selectedVoteTarget.value = undefined;
  }
  snapshot.value = nextSnapshot;
  if (socket.connected && (recoveryPending.value || connectionState.value !== "online")) {
    cancelRoomRecovery();
    connectionState.value = "online";
  }
  if (nextSnapshot.phase !== "VOTING" && nextSnapshot.phase !== "RUNOFF") selectedVoteTarget.value = undefined;
});
socket.on("room:closed", ({ reason }) => {
  clearSession();
  screen.value = "online";
  modal.value = {
    title: reason === "EXPIRED" ? "房间已过期" : "房间已解散",
    body: reason === "EXPIRED" ? "房间长时间没有活动，已被自动清理。" : "房主已解散当前房间，所有成员已退出。",
    type: "warning",
  };
});
socket.on("notice", ({ message, tone }) => showToast(message, tone === "ERROR" ? "error" : tone === "SUCCESS" ? "success" : "info"));

watch(
  () => snapshot.value?.privateIdentity,
  () => hideRole(),
);

onMounted(() => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", hideRole);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("online", handleNetworkOnline);
  window.addEventListener("maskword:pwa-update", handlePwaUpdate);
  consumeInviteParameter();
  if (getSession() || screen.value === "join") ensureSocketConnected();
  void nextTick(() => {
    if (screen.value !== "join") return;
    if (nicknameValid.value) roomCodeInput.value?.focus();
    else nicknameInput.value?.focus();
  });
});

onBeforeUnmount(() => {
  clearInterval(ticker);
  theme.stop();
  cancelRoomRecovery();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("blur", hideRole);
  window.removeEventListener("pageshow", handlePageShow);
  window.removeEventListener("online", handleNetworkOnline);
  window.removeEventListener("maskword:pwa-update", handlePwaUpdate);
  if (roleTimer.value) clearTimeout(roleTimer.value);
  if (toastTimer.value) clearTimeout(toastTimer.value);
  socket.close();
});
</script>

<template>
  <main class="app-shell">
    <button v-if="!snapshot" class="theme-toggle" :aria-label="theme.effective.value === 'NIGHT' ? '切换到日间模式' : '切换到夜间模式'" @click="theme.toggle()">
      <Sun v-if="theme.effective.value === 'NIGHT'" :size="19" />
      <Moon v-else :size="19" />
    </button>
    <Suspense v-if="screen === 'offline' && !snapshot">
      <OfflineGame @exit="screen = 'modes'" @toggle-theme="theme.toggle()" />
      <template #fallback>
        <section class="phone-page offline-loading" aria-busy="true">
          <SpinnerGap class="spin" :size="32" />
          <strong>正在准备线下玩法…</strong>
          <small>首次打开会加载离线游戏资源</small>
        </section>
      </template>
    </Suspense>
    <section v-else-if="!snapshot" class="phone-page landing-page" :class="{ 'mode-home-page': screen === 'modes' }">
      <header v-if="screen !== 'modes'" class="topbar">
        <button class="icon-button" aria-label="返回" @click="goBack"><ArrowLeft :size="22" /></button>
        <h1>{{ screen === 'create' ? '创建房间' : screen === 'join' ? '加入房间' : '线上联机' }}</h1>
        <span class="topbar-spacer" />
      </header>

      <template v-if="screen === 'modes'">
        <div class="brand-lockup">
          <div class="brand-mark"><img :src="undercoverMarkUrl" alt="" /></div>
          <h1>谁是卧底</h1>
          <p>聚会必备推理游戏</p>
        </div>

        <button class="mode-card mode-card-primary" @click="openOnline">
          <img src="/assets/maskword-party-hero.webp" alt="两位朋友拿着手机进行猜词游戏" />
          <span class="mode-copy">
            <strong>线上联机</strong>
            <small>和朋友一起线上玩</small>
            <em>开始游戏 <ArrowRight :size="17" weight="bold" /></em>
          </span>
        </button>

        <button class="mode-card mode-card-muted offline-mode-card" @click="screen = 'offline'">
          <img class="mode-card-art" :src="offlineHeroUrl" alt="四位朋友围坐在一部手机旁玩线下游戏" />
          <span class="mode-copy">
            <strong>线下同屏</strong>
            <small>一台手机轮流查看身份</small>
            <em>本机开始 <ArrowRight :size="17" weight="bold" /></em>
          </span>
        </button>
      </template>

      <template v-else-if="screen === 'online'">
        <div class="section-intro">
          <div class="avatar-large"><User :size="38" weight="fill" /></div>
          <h2>先告诉大家怎么称呼你</h2>
          <p>创建或加入房间都会使用这个昵称</p>
        </div>
        <label class="field-label" for="nickname">昵称</label>
        <div class="input-shell"><User :size="20" /><input id="nickname" v-model="nickname" maxlength="12" placeholder="请输入昵称" /></div>
        <p class="field-support">昵称会保存在本机，下次打开可直接使用。</p>

        <div class="entry-choice-grid">
          <button class="entry-choice create" :disabled="!nicknameValid" @click="openRoomPath('create')">
            <span><Sparkle :size="24" weight="fill" /></span>
            <strong>创建房间</strong>
            <small>设置人数与身份</small>
            <ArrowRight :size="18" weight="bold" />
          </button>
          <button class="entry-choice join" :disabled="!nicknameValid" @click="openRoomPath('join')">
            <span><DoorOpen :size="24" /></span>
            <strong>加入房间</strong>
            <small>输入朋友的房间号</small>
            <ArrowRight :size="18" weight="bold" />
          </button>
        </div>
        <p v-if="!nicknameValid" class="action-hint">输入 1–12 个字符的昵称后选择操作</p>
      </template>

      <template v-else-if="screen === 'create'">
        <div class="nickname-summary">
          <span class="avatar-small"><User :size="18" weight="fill" /></span>
          <span><small>使用昵称</small><strong>{{ nickname }}</strong></span>
          <button class="text-button" aria-label="修改创建房间使用的昵称" @click="screen = 'online'">修改</button>
        </div>
        <div class="config-summary participant-summary">
          <span>本局参赛人数</span>
          <div class="participant-stepper" aria-label="调整参赛人数">
            <button aria-label="参赛人数减一" :disabled="participantCount <= 3" @click="adjustParticipantCount(-1)">−</button>
            <strong>{{ participantCount }}</strong>
            <button aria-label="参赛人数加一" :disabled="participantCount >= 12" @click="adjustParticipantCount(1)">＋</button>
          </div>
          <small>支持 3–12 人</small>
        </div>
        <p class="attendance-summary">{{ attendanceSummary }}</p>
        <div class="config-card v2-config-grid">
          <label><strong>对局模式</strong><select v-model="roomConfig.mode"><option v-for="(label, value) in modeLabels" :key="value" :value="value">{{ label }}</option></select></label>
          <p class="play-tip">{{ roomConfig.mode.includes('HIDDEN') ? '开局只知道词语，需要同时推测自己的身份。' : '开局可以看到自己的身份与词语。' }} {{ roomConfig.mode.includes('EXPLOSIVE') ? `第 ${roomConfig.selfDestructRound} 轮普通投票起可密封猜词。` : '本模式无自爆。' }}</p>
          <label><strong>词组分类</strong><select v-model="roomConfig.wordCategory"><option v-for="item in categoryOptions" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
          <label><strong>难度</strong><select v-model="roomConfig.wordDifficulty"><option value="EASY">轻松</option><option value="STANDARD">标准</option><option value="HARD">烧脑</option></select></label>
        </div>
        <button class="config-disclosure" :aria-expanded="advancedConfigOpen" @click="advancedConfigOpen = !advancedConfigOpen">
          <span><strong>高级设置</strong><small>{{ roomConfig.civilianCount }} 平民 · {{ roomConfig.undercoverCount }} 卧底 · {{ roomConfig.blankCount }} 白板 · {{ roomConfig.doubleAgentCount }} 间谍</small></span>
          <CaretDown :size="18" :class="{ rotated: advancedConfigOpen }" />
        </button>
        <div v-if="advancedConfigOpen" class="config-card">
          <div v-for="item in [
            { key: 'civilianCount', label: '平民数量', hint: '至少 1 人' },
            { key: 'undercoverCount', label: '卧底数量', hint: '至少 1 人' },
            { key: 'blankCount', label: '白板数量', hint: '可选 0–2 人' },
            { key: 'doubleAgentCount', label: '双面间谍', hint: '只限自爆模式' },
          ]" :key="item.key" class="config-row">
            <div><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></div>
            <div class="stepper">
              <button :aria-label="`${item.label}减一`" @click="adjustConfig(item.key as 'civilianCount' | 'undercoverCount' | 'blankCount' | 'doubleAgentCount', -1)">−</button>
              <span>{{ roomConfig[item.key as keyof RoomConfig] }}</span>
              <button :aria-label="`${item.label}加一`" @click="adjustConfig(item.key as 'civilianCount' | 'undercoverCount' | 'blankCount' | 'doubleAgentCount', 1)">＋</button>
            </div>
          </div>
          <label class="config-select-row"><strong>自爆提示轮</strong><select v-model.number="roomConfig.selfDestructRound"><option :value="2">第 2 轮</option><option :value="3">第 3 轮</option><option :value="4">第 4 轮</option></select></label>
          <label class="config-select-row"><strong>发言计时</strong><select v-model.number="roomConfig.speakingSeconds"><option :value="0">关闭</option><option :value="30">30 秒</option><option :value="45">45 秒</option><option :value="60">60 秒</option></select></label>
          <label class="config-select-row"><strong>结果推进</strong><select v-model="roomConfig.resultAdvance"><option value="AUTO">自动 5 秒</option><option value="MANUAL">房主手动</option></select></label>
        </div>
        <div class="config-card">
          <div class="host-toggle">
            <div><strong>房主参与游戏</strong><small>关闭后只负责主持</small></div>
            <button class="switch" :class="{ active: roomConfig.hostParticipates }" role="switch" aria-label="房主参与游戏" :aria-checked="roomConfig.hostParticipates" @click="roomConfig.hostParticipates = !roomConfig.hostParticipates"><span /></button>
          </div>
        </div>
        <div v-if="!roomConfig.hostParticipates" class="config-card custom-words-card">
          <strong>主持人自定义词语（可选）</strong><small>仅服务端保存，不会出现在房间摘要中</small>
          <input v-model="customCivilianWord" maxlength="12" placeholder="平民词" /><input v-model="customUndercoverWord" maxlength="12" placeholder="卧底词" />
        </div>
        <p v-if="configError" class="validation-message"><WarningCircle :size="18" /> {{ configError }}</p>
        <button class="primary-button bottom-action" :disabled="busy || !configValid" @click="createRoom">
          <SpinnerGap v-if="busy" class="spin" :size="20" />
          <Sparkle v-else :size="20" weight="fill" />
          创建房间
        </button>
      </template>

      <template v-else>
        <div class="section-intro join-intro">
          <div class="avatar-large"><DoorOpen :size="38" /></div>
          <h2>输入朋友分享的房间号</h2>
          <p>房间号由 6 位数字组成</p>
        </div>
        <div v-if="!joinNicknameEditing && nicknameValid" class="nickname-summary">
          <span class="avatar-small"><User :size="18" weight="fill" /></span>
          <span><small>使用昵称</small><strong>{{ nickname }}</strong></span>
          <button class="text-button" aria-label="修改加入房间使用的昵称" @click="editJoinNickname">修改</button>
        </div>
        <template v-else>
          <label class="field-label" for="join-nickname">昵称</label>
          <div class="input-shell"><User :size="20" /><input id="join-nickname" ref="nicknameInput" v-model="nickname" maxlength="12" autocomplete="nickname" placeholder="请输入昵称" /></div>
          <p class="field-support">输入 1–12 个字符，加入成功后会保存在本机。</p>
        </template>
        <label class="field-label" for="room-code">6 位房间号</label>
        <div class="input-shell code-input">
          <input ref="roomCodeInput" id="room-code" :value="roomCode" inputmode="numeric" autocomplete="one-time-code" placeholder="例如 277360" @input="handleRoomCodeInput" @paste="handleRoomCodePaste" @keyup.enter="joinRoom" />
        </div>
        <button class="primary-button bottom-action" :disabled="busy || !roomCodeValid || !nicknameValid" @click="joinRoom">
          <SpinnerGap v-if="busy" class="spin" :size="20" />
          <DoorOpen v-else :size="20" />
          加入房间
        </button>
      </template>
    </section>

    <section v-else class="phone-page room-page">
      <header class="topbar room-topbar">
        <div class="connection-pill" :class="connectionState">
          <WifiHigh v-if="connectionState === 'online'" :size="16" />
          <SpinnerGap v-else-if="connectionState === 'connecting' || connectionState === 'recovering'" class="spin" :size="16" />
          <WifiSlash v-else :size="16" />
          {{ connectionLabel }}
        </div>
        <h1>{{ phaseTitle }}</h1>
        <button class="icon-button" aria-label="房间操作" @click="roomManagementOpen = true"><GearSix :size="21" /></button>
      </header>

      <template v-if="snapshot.phase === 'WAITING'">
        <div class="room-code-card">
          <span>房间号</span>
          <strong>{{ snapshot.roomCode }}</strong>
          <button aria-label="邀请朋友加入房间" @click="inviteRoom"><ShareNetwork :size="18" />邀请</button>
        </div>
        <div class="rules-summary card-surface"><strong>{{ modeLabels[snapshot.config.mode] }}</strong><span>{{ snapshotCategoryLabel }} · {{ snapshot.config.wordDifficulty === 'EASY' ? '轻松' : snapshot.config.wordDifficulty === 'HARD' ? '烧脑' : '标准' }}</span><small>白板 {{ snapshot.config.blankCount }} · 间谍 {{ snapshot.config.doubleAgentCount }} · 发言计时 {{ snapshot.config.speakingSeconds || '关闭' }}</small></div>
        <div v-if="self && snapshot.permissions.canChangeAvatar" class="avatar-picker card-surface"><strong>选择你的固定头像</strong><div><button v-for="avatarId in AVATAR_IDS" :key="avatarId" :disabled="!roomConnectionReady || occupiedAvatarIds.has(avatarId)" :class="{ selected: self.avatarId === avatarId }" @click="changeAvatar(avatarId)"><AvatarBadge :avatar-id="avatarId" size="small" /></button></div></div>
        <div class="lobby-progress">
          <span>{{ snapshot.participatingPlayerCount === snapshot.requiredPlayerCount ? '人员已到齐，可以开始' : '等待其他玩家加入…' }}</span>
          <strong>{{ snapshot.participatingPlayerCount }} / {{ snapshot.requiredPlayerCount }}</strong>
        </div>
        <div class="player-list card-surface">
          <article v-for="(player, index) in snapshot.players" :key="player.id" class="player-row">
            <span class="player-index">{{ index + 1 }}</span>
            <AvatarBadge :avatar-id="player.avatarId" size="small" />
            <span class="player-details">
              <strong>{{ player.nickname }} <em v-if="player.id === snapshot.selfId">我</em></strong>
              <small>{{ player.isParticipating ? (player.isOnline ? '在线' : '离线') : '仅主持' }}</small>
            </span>
            <Crown v-if="player.isHost" class="crown" :size="21" weight="fill" />
            <button v-else-if="isHost && player.isOnline" class="text-button" :disabled="!roomConnectionReady" :aria-label="`转移房主给${player.nickname}`" @click="transferHost(player.id)">转移房主</button>
          </article>
        </div>
        <div class="room-actions">
          <button v-if="snapshot.permissions.canStart" class="primary-button" :disabled="busy || !roomConnectionReady" @click="simpleAction('game:start')"><Play :size="20" weight="fill" /> 开始游戏</button>
          <p v-else-if="isHost" class="action-hint">人数需与身份配置完全一致后才能开始</p>
          <button class="secondary-button danger-soft" @click="confirmAction = isHost ? 'dissolve' : 'leave'"><SignOut :size="19" /> {{ isHost ? '解散房间' : '退出房间' }}</button>
        </div>
      </template>

      <template v-else-if="snapshot.phase === 'SPEAKING'">
        <button v-if="snapshot.privateIdentity" class="identity-card" :class="{ revealed: roleVisible }" @click="toggleRole">
          <template v-if="roleVisible">
            <EyeSlash :size="28" />
            <span>我的身份</span>
            <strong>{{ snapshot.privateIdentity.role ? roleLabels[snapshot.privateIdentity.role] : '身份尚未揭示' }}</strong>
            <small>{{ snapshot.privateIdentity.role === 'BLANK' ? '你没有词语' : `词语：${snapshot.privateIdentity.word}` }}</small>
            <em>点击立即隐藏</em>
          </template>
          <template v-else>
            <Eye :size="32" />
            <strong>点击查看我的身份</strong>
            <small>展开 5 秒后自动隐藏</small>
          </template>
        </button>
        <p v-else class="spectator-banner"><Eye :size="20" /> 你本局只负责主持，可以查看并推进流程。</p>

        <div class="section-heading"><div><span>发言顺序</span><small>所有描述在线下完成</small></div><em>{{ aliveCount }} 人存活</em></div>
        <div class="speaking-list card-surface">
          <article v-for="(playerId, index) in snapshot.speakingOrder" :key="playerId" class="speaker-row" :class="{ self: playerId === snapshot.selfId }">
            <span>{{ index + 1 }}</span>
            <AvatarBadge :avatar-id="playerById.get(playerId)?.avatarId ?? 'robot'" size="small" />
            <strong>{{ playerName(playerId) }} <em v-if="playerId === snapshot.selfId">我</em></strong>
            <small>{{ snapshot.speaking?.completedPlayerIds.includes(playerId) ? '已发言' : snapshot.speaking?.currentPlayerId === playerId ? '当前' : '等待中' }}</small>
          </article>
        </div>
        <p class="play-tip">描述要足够有信息用于分辨身份，但不要直接说出词语，避免卧底猜中。</p>
        <button v-if="snapshot.permissions.canStartSpeaking" class="secondary-button" :disabled="!roomConnectionReady" @click="simpleAction('game:startSpeaking')"><Play :size="19" />开始发言</button>
        <button v-if="snapshot.permissions.canEndSpeaking" class="secondary-button" :disabled="!roomConnectionReady" @click="simpleAction('game:endSpeaking')"><CheckCircle :size="19" />完成当前发言<span v-if="speakingSeconds !== null"> · {{ speakingSeconds }}s</span></button>
        <button v-if="snapshot.permissions.canBeginVote" class="primary-button bottom-action" :disabled="busy || !roomConnectionReady" @click="simpleAction('game:beginVote')"><CheckCircle :size="20" /> 结束发言，进入匿名投票</button>
        <p v-else class="action-hint">等待房主结束发言并开启投票</p>
      </template>

      <template v-else-if="snapshot.phase === 'VOTING' || snapshot.phase === 'RUNOFF'">
        <p v-if="snapshot.phase === 'RUNOFF'" class="phase-notice"><Info :size="18" /> 出现平票，请重新投票</p>
        <div class="vote-hero">
          <span class="phase-icon"><MaskHappy :size="32" weight="fill" /></span>
          <h2>{{ snapshot.phase === 'RUNOFF' ? '平票玩家再次发言' : '选出你怀疑的玩家' }}</h2>
          <p>{{ snapshot.phase === 'RUNOFF' ? '讨论结束后重新投票，不限制时间' : '投票关系全程保密，不能投给自己' }}</p>
        </div>
        <div class="speaking-recap" aria-label="本轮发言顺序"><AvatarBadge v-for="playerId in snapshot.speakingOrder" :key="playerId" :avatar-id="playerById.get(playerId)?.avatarId ?? 'robot'" size="small" /></div>
        <div class="vote-grid">
          <button
            v-for="targetId in snapshot.voting?.candidateIds ?? []"
            :key="targetId"
            class="vote-player"
            :class="{
              selected: selectedVoteTarget === targetId,
              'self-candidate': targetId === snapshot.selfId,
              locked: !snapshot.voting?.allowedTargetIds.includes(targetId),
            }"
            :disabled="!roomConnectionReady || !snapshot.voting?.canVote || !snapshot.voting?.allowedTargetIds.includes(targetId)"
            :aria-label="targetId === snapshot.selfId ? `${playerName(targetId)}，我，不能投给自己` : `选择${playerName(targetId)}`"
            :title="playerName(targetId)"
            @click="selectedVoteTarget = targetId"
          >
            <AvatarBadge :avatar-id="playerById.get(targetId)?.avatarId ?? 'robot'" size="medium" />
            <strong>{{ playerName(targetId) }} <em v-if="targetId === snapshot.selfId">我</em></strong>
            <small v-if="snapshot.phase === 'RUNOFF'">上轮 {{ runoffTallyById.get(targetId) ?? 0 }} 票</small>
            <small v-else-if="targetId === snapshot.selfId">不能投给自己</small>
            <CheckCircle v-if="selectedVoteTarget === targetId" :size="20" weight="fill" />
          </button>
        </div>
        <button v-if="snapshot.voting?.canAbstain" class="abstain-button" :disabled="!roomConnectionReady" :class="{ selected: selectedVoteTarget === null }" @click="selectedVoteTarget = null">本轮弃权</button>
        <label v-if="snapshot.voting?.canGuess" class="self-destruct-box">
          <strong>自爆猜词（可选，仅一次）</strong>
          <small>与选票一起锁定；本轮最终结算后才揭晓。若平票，重投时不能新增或修改。</small>
          <input v-model="selfDestructGuess" maxlength="12" placeholder="输入你猜的平民词" />
        </label>
        <div class="vote-submit-bar">
          <div class="vote-status">
            <span>已提交：<strong>{{ snapshot.voting?.submittedCount }} / {{ snapshot.voting?.eligibleCount }}</strong></span>
            <span v-if="voteSeconds !== null">剩余 <strong>{{ voteSeconds }}s</strong></span>
            <span v-else>重投不限时</span>
          </div>
          <p v-if="snapshot.voting?.canVote" class="vote-selection">已选择：<strong>{{ selectedVoteLabel }}</strong></p>
          <button v-if="snapshot.voting?.canVote" class="primary-button" :disabled="!canSubmitVote" @click="submitVote">确认匿名投票</button>
          <p v-else class="action-hint">你的投票已提交，等待其他玩家</p>
          <button v-if="snapshot.permissions.canFinishRunoff" class="secondary-button" :disabled="!roomConnectionReady" @click="confirmAction = 'finish-runoff'">结束重投并结算</button>
        </div>
      </template>

      <template v-else-if="snapshot.phase === 'ROUND_RESULT' && snapshot.roundResult">
        <div class="result-hero">
          <span class="result-icon"><WarningCircle :size="36" weight="fill" /></span>
          <h2>{{ snapshot.roundResult.eliminatedPlayerIds.length ? `${snapshot.roundResult.eliminatedPlayerIds.map(playerName).join('、')} 已被淘汰` : '本轮无人淘汰' }}</h2>
          <p>{{ snapshot.config.resultAdvance === 'AUTO' ? `下一轮将在 ${roundResultSeconds} 秒后开始` : '等待房主进入下一轮' }}</p>
        </div>
        <div v-if="snapshot.config.resultAdvance === 'AUTO'" class="round-progress" role="progressbar" aria-label="进入下一轮倒计时" :aria-valuenow="roundResultProgress" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${roundResultProgress}%` }" /></div>
        <div v-for="result in snapshot.roundResult.selfDestructResults" :key="result.playerId" class="self-destruct-result" :class="{ correct: result.correct }"><strong>{{ result.correct ? `${playerName(result.playerId)} 猜中平民词` : `${result.role === 'DOUBLE_AGENT' ? '间谍' : '卧底'}玩家猜词失败，${playerName(result.playerId)} 已被淘汰` }}</strong><small>猜测：{{ result.guess }}</small></div>
        <div class="tally-card card-surface">
          <article v-for="item in snapshot.roundResult.tallies" :key="item.playerId">
            <span class="avatar-small"><User :size="18" weight="fill" /></span>
            <strong>{{ playerName(item.playerId) }}</strong>
            <span>{{ item.votes }} 票</span>
          </article>
          <article><span class="avatar-small muted"><SignOut :size="18" /></span><strong>弃权</strong><span>{{ snapshot.roundResult.abstainCount }} 票</span></article>
        </div>
        <button v-if="snapshot.permissions.canAdvanceRound" class="primary-button" :disabled="!roomConnectionReady" @click="simpleAction('game:advanceRound')">进入下一轮</button>
      </template>

      <template v-else-if="snapshot.phase === 'ENDED' && snapshot.finalResult">
        <VictoryHero
          :title="snapshot.finalResult.winner === 'CIVILIAN' ? '平民阵营胜利！' : '卧底阵营胜利！'"
          :subtitle="snapshot.finalResult.winner === 'CIVILIAN' ? '所有卧底已被找出' : '卧底已掌控场上局势'"
        />
        <div class="word-reveal card-surface"><div><span>平民词</span><strong>{{ snapshot.finalResult.civilianWord }}</strong></div><div><span>卧底词</span><strong>{{ snapshot.finalResult.undercoverWord }}</strong></div></div>
        <div class="final-list card-surface">
          <article v-for="player in snapshot.finalResult.players" :key="player.id">
            <AvatarBadge :avatar-id="player.avatarId" size="small" />
            <strong>{{ player.nickname }}</strong>
            <span class="role-badge" :class="player.role.toLowerCase()">{{ roleLabels[player.role] }}</span>
            <small>{{ player.hasLeft ? '已退出' : player.isAlive ? '存活' : '已淘汰' }}</small>
          </article>
        </div>
        <div class="recap-card card-surface"><strong>对局复盘</strong><article v-for="round in snapshot.finalResult.rounds" :key="round.round"><span>第 {{ round.round }} 轮</span><small>{{ round.eliminatedPlayerIds.length ? `淘汰：${round.eliminatedPlayerIds.map(playerName).join('、')}` : '无人淘汰' }}<template v-if="round.selfDestructResults.length"> · 自爆 {{ round.selfDestructResults.length }} 次</template></small></article></div>
        <button v-if="snapshot.permissions.canRematch" class="primary-button" :disabled="busy || !roomConnectionReady" @click="simpleAction('game:rematch')"><Sparkle :size="20" weight="fill" /> 再来一局</button>
        <p v-else class="action-hint">等待房主发起下一局</p>
        <button class="secondary-button" @click="confirmAction = isHost ? 'dissolve' : 'leave'">退出房间</button>
      </template>
    </section>

    <Transition name="toast">
      <div v-if="toast" class="toast" :class="toast.tone" role="status">
        <CheckCircle v-if="toast.tone === 'success'" :size="20" weight="fill" />
        <WarningCircle v-else-if="toast.tone === 'error'" :size="20" weight="fill" />
        <Info v-else :size="20" weight="fill" />
        {{ toast.message }}
      </div>
    </Transition>

    <div v-if="canShowPwaUpdate" class="pwa-update" role="status">
      <span><strong>新版本已准备好</strong><small>现在更新不会影响进行中的游戏</small></span>
      <button @click="applyPwaUpdate">立即更新</button>
    </div>

    <div v-if="modal" class="modal-backdrop" @click.self="modal = null">
      <section class="modal-card" role="dialog" aria-modal="true">
        <span class="modal-icon" :class="modal.type"><Info v-if="modal.type === 'info'" :size="32" weight="fill" /><WarningCircle v-else :size="32" weight="fill" /></span>
        <h2>{{ modal.title }}</h2><p>{{ modal.body }}</p>
        <button class="primary-button" @click="modal = null">知道了</button>
      </section>
    </div>

    <div v-if="confirmAction" class="modal-backdrop" @click.self="confirmAction = null">
      <section class="modal-card" role="dialog" aria-modal="true">
        <span class="modal-icon warning"><WarningCircle :size="32" weight="fill" /></span>
        <h2>{{ confirmAction === 'dissolve' ? '确认解散房间？' : confirmAction === 'leave' ? '确认退出房间？' : '结束本次重投？' }}</h2>
        <p>{{ confirmAction === 'dissolve' ? '本局将立即结束，所有玩家都会返回首页。' : confirmAction === 'leave' ? '退出后无法恢复当前对局。' : '尚未提交的玩家将自动视为弃权。' }}</p>
        <div class="modal-actions"><button class="secondary-button" @click="confirmAction = null">取消</button><button class="danger-button" :disabled="busy" @click="confirmCurrentAction">确认</button></div>
      </section>
    </div>

    <div v-if="roomManagementOpen && snapshot" class="modal-backdrop" @click.self="roomManagementOpen = false">
      <section class="modal-card management-card" role="dialog" aria-modal="true" aria-label="房间操作">
        <h2>房间操作</h2>
        <p>房主可随时转移主持权限；主动退出后不能恢复当前对局。</p>
        <div class="management-list">
          <article v-for="player in snapshot.players" :key="player.id">
            <span class="avatar-small"><User :size="18" weight="fill" /></span>
            <span><strong>{{ player.nickname }}</strong><small>{{ player.isOnline ? '在线' : '离线' }} · {{ player.isAlive ? '存活' : '观战' }}</small></span>
            <Crown v-if="player.isHost" class="crown" :size="20" weight="fill" />
            <button v-else-if="isHost && player.isOnline" class="text-button" :disabled="!roomConnectionReady" @click="transferHost(player.id); roomManagementOpen = false">转移</button>
          </article>
        </div>
        <button class="secondary-button" @click="theme.toggle()"><Sun v-if="theme.effective.value === 'NIGHT'" :size="18" /><Moon v-else :size="18" />切换{{ theme.effective.value === 'NIGHT' ? '日间' : '夜间' }}模式</button>
        <button class="danger-button" @click="confirmAction = isHost ? 'dissolve' : 'leave'; roomManagementOpen = false">{{ isHost ? '解散房间' : '退出房间' }}</button>
        <button class="secondary-button" @click="roomManagementOpen = false">返回游戏</button>
      </section>
    </div>
  </main>
</template>
