<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { io, type Socket } from "socket.io-client";
import {
  PhArrowLeft as ArrowLeft,
  PhArrowRight as ArrowRight,
  PhCheckCircle as CheckCircle,
  PhClipboard as Clipboard,
  PhCrown as Crown,
  PhDoorOpen as DoorOpen,
  PhEye as Eye,
  PhEyeSlash as EyeSlash,
  PhGearSix as GearSix,
  PhInfo as Info,
  PhMaskHappy as MaskHappy,
  PhPlay as Play,
  PhSignOut as SignOut,
  PhSparkle as Sparkle,
  PhSpinnerGap as SpinnerGap,
  PhUser as User,
  PhUsersThree as UsersThree,
  PhWarningCircle as WarningCircle,
  PhWifiHigh as WifiHigh,
  PhWifiSlash as WifiSlash,
} from "@phosphor-icons/vue";
import type {
  Ack,
  ClientToServerEvents,
  Role,
  RoomConfig,
  RoomSnapshot,
  ServerToClientEvents,
  SessionCredentials,
} from "@maskword/shared";

type LandingScreen = "modes" | "online" | "create" | "join" | "offline";
type ConfirmAction = "leave" | "dissolve" | "finish-runoff" | null;

const SESSION_KEY = "maskword-session-v1";
const OfflineGame = defineAsyncComponent(() => import("./offline/OfflineGame.vue"));
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ autoConnect: false });
const screen = ref<LandingScreen>(
  localStorage.getItem("maskword-offline-v1") && !localStorage.getItem(SESSION_KEY) ? "offline" : "modes",
);
const snapshot = ref<RoomSnapshot | null>(null);
const nickname = ref(localStorage.getItem("maskword-nickname") ?? "");
const roomCode = ref("");
const roomCodeInput = ref<HTMLInputElement | null>(null);
const connectionState = ref<"connecting" | "online" | "offline">("offline");
const busy = ref(false);
const roleVisible = ref(false);
const selectedVoteTarget = ref<string | null | undefined>(undefined);
const now = ref(Date.now());
const toast = ref<{ message: string; tone: "info" | "success" | "error" } | null>(null);
const modal = ref<{ title: string; body: string; type: "info" | "warning" } | null>(null);
const confirmAction = ref<ConfirmAction>(null);
const roomManagementOpen = ref(false);
const roleTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const toastTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const pwaUpdateReady = ref(false);
const ticker = setInterval(() => (now.value = Date.now()), 1_000);

const roomConfig = ref<RoomConfig>({
  civilianCount: 4,
  undercoverCount: 1,
  blankCount: 1,
  hostParticipates: true,
});

const totalConfigured = computed(
  () => roomConfig.value.civilianCount + roomConfig.value.undercoverCount + roomConfig.value.blankCount,
);
const self = computed(() => snapshot.value?.players.find((player) => player.id === snapshot.value?.selfId) ?? null);
const isHost = computed(() => snapshot.value?.hostId === snapshot.value?.selfId);
const playerById = computed(() => new Map(snapshot.value?.players.map((player) => [player.id, player]) ?? []));
const aliveCount = computed(() => snapshot.value?.players.filter((player) => player.isParticipating && player.isAlive).length ?? 0);
const voteSeconds = computed(() => {
  const deadline = snapshot.value?.voting?.deadlineAt;
  return deadline ? Math.max(0, Math.ceil((deadline - now.value) / 1_000)) : null;
});
const canSubmitVote = computed(
  () => snapshot.value?.voting?.canVote && selectedVoteTarget.value !== undefined && !busy.value,
);
const normalizedNickname = computed(() => nickname.value.trim().replace(/\s+/g, " "));
const nicknameValid = computed(() => {
  const length = [...normalizedNickname.value].length;
  return length >= 1 && length <= 12;
});
const roomCodeValid = computed(() => roomCode.value.replace(/\D/g, "").length === 6);
const runoffTallyById = computed(
  () => new Map(snapshot.value?.voting?.runoffTallies?.map((item) => [item.playerId, item.votes]) ?? []),
);
const configValid = computed(() => {
  const config = roomConfig.value;
  return (
    totalConfigured.value >= 3 &&
    totalConfigured.value <= 12 &&
    config.civilianCount >= 1 &&
    config.undercoverCount >= 1 &&
    config.blankCount >= 0 &&
    config.blankCount <= 2 &&
    config.undercoverCount < config.civilianCount + config.blankCount
  );
});
const canShowPwaUpdate = computed(
  () => pwaUpdateReady.value && screen.value === "modes" && !snapshot.value && !localStorage.getItem("maskword-offline-v1"),
);

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
};

function showToast(message: string, tone: "info" | "success" | "error" = "info") {
  toast.value = { message, tone };
  if (toastTimer.value) clearTimeout(toastTimer.value);
  toastTimer.value = setTimeout(() => (toast.value = null), 3_200);
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
  localStorage.removeItem(SESSION_KEY);
  snapshot.value = null;
  roleVisible.value = false;
  selectedVoteTarget.value = undefined;
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
  if (socket.connected || socket.active) return;
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
  socket.emit("room:create", { nickname: nickname.value, config: roomConfig.value }, (result) => {
    handleAck(result, () => {
      if (result.ok && "data" in result) saveSession(result.data);
    });
  });
}

function joinRoom() {
  if (!ensureNickname()) return;
  const code = roomCode.value.replace(/\D/g, "").slice(0, 6);
  if (code.length !== 6) {
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
  action: "room:leave" | "room:dissolve" | "game:start" | "game:beginVote" | "vote:finishRunoff" | "game:rematch",
) {
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
  else if (action === "game:beginVote") socket.emit("game:beginVote", ack);
  else if (action === "vote:finishRunoff") socket.emit("vote:finishRunoff", ack);
  else socket.emit("game:rematch", ack);
}

function submitVote() {
  if (!canSubmitVote.value) return;
  busy.value = true;
  socket.emit("vote:submit", selectedVoteTarget.value ?? null, (result) => {
    handleAck(result, () => {
      selectedVoteTarget.value = undefined;
      showToast("投票已匿名提交", "success");
    });
  });
}

function transferHost(targetId: string) {
  busy.value = true;
  socket.emit("room:transferHost", targetId, (result) => handleAck(result, () => showToast("房主已转移", "success")));
}

async function copyRoom() {
  if (!snapshot.value) return;
  const shareText = `谁是卧底房间号：${snapshot.value.roomCode}`;
  try {
    await navigator.clipboard.writeText(shareText);
    showToast("房间号已复制", "success");
  } catch {
    showToast(`房间号：${snapshot.value.roomCode}`);
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

function handlePwaUpdate() {
  pwaUpdateReady.value = true;
}

function applyPwaUpdate() {
  if (localStorage.getItem("maskword-offline-v1") || snapshot.value || screen.value !== "modes") return;
  void window.maskwordApplyUpdate?.();
}

function adjustConfig(key: "civilianCount" | "undercoverCount" | "blankCount", delta: number) {
  const limits: readonly [number, number] = key === "blankCount" ? [0, 2] : key === "undercoverCount" ? [1, 5] : [1, 10];
  roomConfig.value[key] = Math.min(limits[1], Math.max(limits[0], roomConfig.value[key] + delta));
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
  connectionState.value = "online";
  const session = getSession();
  if (!session || snapshot.value) return;
  socket.emit("room:resume", session, (result) => {
    if (!result.ok) {
      clearSession();
      screen.value = "online";
      showToast(result.message, "error");
    }
  });
});
socket.on("disconnect", () => {
  connectionState.value = "offline";
  hideRole();
});
socket.on("room:snapshot", (nextSnapshot) => {
  snapshot.value = nextSnapshot;
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
  document.addEventListener("visibilitychange", hideRole);
  window.addEventListener("blur", hideRole);
  window.addEventListener("pageshow", hideRole);
  window.addEventListener("maskword:pwa-update", handlePwaUpdate);
  if (getSession()) ensureSocketConnected();
  void nextTick();
});

onBeforeUnmount(() => {
  clearInterval(ticker);
  document.removeEventListener("visibilitychange", hideRole);
  window.removeEventListener("blur", hideRole);
  window.removeEventListener("pageshow", hideRole);
  window.removeEventListener("maskword:pwa-update", handlePwaUpdate);
  if (roleTimer.value) clearTimeout(roleTimer.value);
  if (toastTimer.value) clearTimeout(toastTimer.value);
  socket.close();
});
</script>

<template>
  <main class="app-shell">
    <Suspense v-if="screen === 'offline' && !snapshot">
      <OfflineGame @exit="screen = 'modes'" />
      <template #fallback>
        <section class="phone-page offline-loading" aria-busy="true">
          <SpinnerGap class="spin" :size="32" />
          <strong>正在准备线下玩法…</strong>
          <small>首次打开会加载离线游戏资源</small>
        </section>
      </template>
    </Suspense>
    <section v-else-if="!snapshot" class="phone-page landing-page">
      <header v-if="screen !== 'modes'" class="topbar">
        <button class="icon-button" aria-label="返回" @click="goBack"><ArrowLeft :size="22" /></button>
        <h1>{{ screen === 'create' ? '创建房间' : screen === 'join' ? '加入房间' : '线上联机' }}</h1>
        <span class="topbar-spacer" />
      </header>

      <template v-if="screen === 'modes'">
        <div class="brand-lockup">
          <div class="brand-mark"><MaskHappy :size="34" weight="fill" /></div>
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
          <span class="mode-copy">
            <strong>线下同屏</strong>
            <small>一台手机轮流查看身份</small>
            <em>本机开始 <ArrowRight :size="17" weight="bold" /></em>
          </span>
          <UsersThree :size="34" weight="fill" />
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
          <button class="text-button" @click="screen = 'online'">修改</button>
        </div>
        <div class="config-summary">
          <span>本局参赛人数</span>
          <strong>{{ totalConfigured }}</strong>
          <small>支持 3–12 人</small>
        </div>
        <div class="config-card">
          <div v-for="item in [
            { key: 'civilianCount', label: '平民数量', hint: '至少 1 人' },
            { key: 'undercoverCount', label: '卧底数量', hint: '至少 1 人' },
            { key: 'blankCount', label: '白板数量', hint: '可选 0–2 人' },
          ]" :key="item.key" class="config-row">
            <div><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></div>
            <div class="stepper">
              <button :aria-label="`${item.label}减一`" @click="adjustConfig(item.key as 'civilianCount' | 'undercoverCount' | 'blankCount', -1)">−</button>
              <span>{{ roomConfig[item.key as keyof RoomConfig] }}</span>
              <button :aria-label="`${item.label}加一`" @click="adjustConfig(item.key as 'civilianCount' | 'undercoverCount' | 'blankCount', 1)">＋</button>
            </div>
          </div>
          <div class="host-toggle">
            <div><strong>房主参与游戏</strong><small>关闭后只负责主持</small></div>
            <button class="switch" :class="{ active: roomConfig.hostParticipates }" role="switch" :aria-checked="roomConfig.hostParticipates" @click="roomConfig.hostParticipates = !roomConfig.hostParticipates"><span /></button>
          </div>
        </div>
        <p v-if="!configValid" class="validation-message"><WarningCircle :size="18" /> 卧底人数必须少于其他参赛者，且总人数为 3–12 人。</p>
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
        <div class="nickname-summary">
          <span class="avatar-small"><User :size="18" weight="fill" /></span>
          <span><small>使用昵称</small><strong>{{ nickname }}</strong></span>
          <button class="text-button" @click="screen = 'online'">修改</button>
        </div>
        <label class="field-label" for="room-code">6 位房间号</label>
        <div class="input-shell code-input">
          <input ref="roomCodeInput" id="room-code" v-model="roomCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="例如 277360" @keyup.enter="joinRoom" />
        </div>
        <button class="primary-button bottom-action" :disabled="busy || !roomCodeValid" @click="joinRoom">
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
          <WifiSlash v-else :size="16" />
          {{ connectionState === 'online' ? '已连接' : connectionState === 'connecting' ? '连接中' : '重连中' }}
        </div>
        <h1>{{ phaseTitle }}</h1>
        <button class="icon-button" aria-label="房间操作" @click="roomManagementOpen = true"><GearSix :size="21" /></button>
      </header>

      <template v-if="snapshot.phase === 'WAITING'">
        <div class="room-code-card">
          <span>房间号</span>
          <strong>{{ snapshot.roomCode }}</strong>
          <button @click="copyRoom"><Clipboard :size="17" />复制</button>
        </div>
        <div class="lobby-progress">
          <span>{{ snapshot.participatingPlayerCount === snapshot.requiredPlayerCount ? '人员已到齐，可以开始' : '等待其他玩家加入…' }}</span>
          <strong>{{ snapshot.participatingPlayerCount }} / {{ snapshot.requiredPlayerCount }}</strong>
        </div>
        <div class="player-list card-surface">
          <article v-for="(player, index) in snapshot.players" :key="player.id" class="player-row">
            <span class="player-index">{{ index + 1 }}</span>
            <span class="avatar-small"><User :size="18" weight="fill" /></span>
            <span class="player-details">
              <strong>{{ player.nickname }} <em v-if="player.id === snapshot.selfId">我</em></strong>
              <small>{{ player.isParticipating ? (player.isOnline ? '在线' : '离线') : '仅主持' }}</small>
            </span>
            <Crown v-if="player.isHost" class="crown" :size="21" weight="fill" />
            <button v-else-if="isHost && player.isOnline" class="text-button" @click="transferHost(player.id)">转移房主</button>
          </article>
        </div>
        <div class="room-actions">
          <button v-if="snapshot.permissions.canStart" class="primary-button" :disabled="busy" @click="simpleAction('game:start')"><Play :size="20" weight="fill" /> 开始游戏</button>
          <p v-else-if="isHost" class="action-hint">人数需与身份配置完全一致后才能开始</p>
          <button class="secondary-button danger-soft" @click="confirmAction = isHost ? 'dissolve' : 'leave'"><SignOut :size="19" /> {{ isHost ? '解散房间' : '退出房间' }}</button>
        </div>
      </template>

      <template v-else-if="snapshot.phase === 'SPEAKING'">
        <button v-if="snapshot.privateIdentity" class="identity-card" :class="{ revealed: roleVisible }" @click="toggleRole">
          <template v-if="roleVisible">
            <EyeSlash :size="28" />
            <span>我的身份</span>
            <strong>{{ roleLabels[snapshot.privateIdentity.role] }}</strong>
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
            <span class="avatar-small"><User :size="18" weight="fill" /></span>
            <strong>{{ playerName(playerId) }} <em v-if="playerId === snapshot.selfId">我</em></strong>
            <small>{{ index === 0 ? '首先发言' : '等待中' }}</small>
          </article>
        </div>
        <button v-if="snapshot.permissions.canBeginVote" class="primary-button bottom-action" :disabled="busy" @click="simpleAction('game:beginVote')"><CheckCircle :size="20" /> 结束发言，进入匿名投票</button>
        <p v-else class="action-hint">等待房主结束发言并开启投票</p>
      </template>

      <template v-else-if="snapshot.phase === 'VOTING' || snapshot.phase === 'RUNOFF'">
        <div class="vote-hero">
          <span class="phase-icon"><MaskHappy :size="32" weight="fill" /></span>
          <h2>{{ snapshot.phase === 'RUNOFF' ? '平票玩家再次发言' : '选出你怀疑的玩家' }}</h2>
          <p>{{ snapshot.phase === 'RUNOFF' ? '讨论结束后重新投票，不限制时间' : '投票关系全程保密，不能投给自己' }}</p>
        </div>
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
            :disabled="!snapshot.voting?.canVote || !snapshot.voting?.allowedTargetIds.includes(targetId)"
            @click="selectedVoteTarget = targetId"
          >
            <span class="avatar-vote"><User :size="27" weight="fill" /></span>
            <strong>{{ playerName(targetId) }} <em v-if="targetId === snapshot.selfId">我</em></strong>
            <small v-if="snapshot.phase === 'RUNOFF'">上轮 {{ runoffTallyById.get(targetId) ?? 0 }} 票</small>
            <small v-else-if="targetId === snapshot.selfId">不能投给自己</small>
            <CheckCircle v-if="selectedVoteTarget === targetId" :size="20" weight="fill" />
          </button>
        </div>
        <button v-if="snapshot.voting?.canAbstain" class="abstain-button" :class="{ selected: selectedVoteTarget === null }" @click="selectedVoteTarget = null">本轮弃权</button>
        <div class="vote-status">
          <span>已提交：<strong>{{ snapshot.voting?.submittedCount }} / {{ snapshot.voting?.eligibleCount }}</strong></span>
          <span v-if="voteSeconds !== null">剩余 <strong>{{ voteSeconds }}s</strong></span>
          <span v-else>重投不限时</span>
        </div>
        <button v-if="snapshot.voting?.canVote" class="primary-button" :disabled="!canSubmitVote" @click="submitVote">确认匿名投票</button>
        <p v-else class="action-hint">你的投票已提交，等待其他玩家</p>
        <button v-if="snapshot.permissions.canFinishRunoff" class="secondary-button" @click="confirmAction = 'finish-runoff'">结束重投并结算</button>
      </template>

      <template v-else-if="snapshot.phase === 'ROUND_RESULT' && snapshot.roundResult">
        <div class="result-hero">
          <span class="result-icon"><WarningCircle :size="36" weight="fill" /></span>
          <h2>{{ snapshot.roundResult.eliminatedPlayerId ? `${playerName(snapshot.roundResult.eliminatedPlayerId)} 被淘汰` : '本轮无人淘汰' }}</h2>
          <p>身份暂不公开，5 秒后自动进入下一轮</p>
        </div>
        <div class="tally-card card-surface">
          <article v-for="item in snapshot.roundResult.tallies" :key="item.playerId">
            <span class="avatar-small"><User :size="18" weight="fill" /></span>
            <strong>{{ playerName(item.playerId) }}</strong>
            <span>{{ item.votes }} 票</span>
          </article>
          <article><span class="avatar-small muted"><SignOut :size="18" /></span><strong>弃权</strong><span>{{ snapshot.roundResult.abstainCount }} 票</span></article>
        </div>
      </template>

      <template v-else-if="snapshot.phase === 'ENDED' && snapshot.finalResult">
        <div class="end-hero">
          <Sparkle :size="34" weight="fill" />
          <h2>{{ snapshot.finalResult.winner === 'CIVILIAN' ? '平民阵营胜利！' : '卧底阵营胜利！' }}</h2>
          <p>{{ snapshot.finalResult.winner === 'CIVILIAN' ? '所有卧底已被找出' : '卧底已掌控场上局势' }}</p>
        </div>
        <div class="word-reveal card-surface"><div><span>平民词</span><strong>{{ snapshot.finalResult.civilianWord }}</strong></div><div><span>卧底词</span><strong>{{ snapshot.finalResult.undercoverWord }}</strong></div></div>
        <div class="final-list card-surface">
          <article v-for="player in snapshot.finalResult.players" :key="player.id">
            <span class="avatar-small"><User :size="18" weight="fill" /></span>
            <strong>{{ player.nickname }}</strong>
            <span class="role-badge" :class="player.role.toLowerCase()">{{ roleLabels[player.role] }}</span>
            <small>{{ player.hasLeft ? '已退出' : player.isAlive ? '存活' : '已淘汰' }}</small>
          </article>
        </div>
        <button v-if="snapshot.permissions.canRematch" class="primary-button" :disabled="busy" @click="simpleAction('game:rematch')"><Sparkle :size="20" weight="fill" /> 再来一局</button>
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
            <button v-else-if="isHost && player.isOnline" class="text-button" @click="transferHost(player.id); roomManagementOpen = false">转移</button>
          </article>
        </div>
        <button class="danger-button" @click="confirmAction = isHost ? 'dissolve' : 'leave'; roomManagementOpen = false">{{ isHost ? '解散房间' : '退出房间' }}</button>
        <button class="secondary-button" @click="roomManagementOpen = false">返回游戏</button>
      </section>
    </div>
  </main>
</template>
