<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  AVATAR_IDS,
  DEFAULT_ROLE_CONFIGS,
  type AvatarId,
  type Role,
  type RoomConfig,
} from "@maskword/shared";
import {
  PhArrowLeft as ArrowLeft,
  PhArrowRight as ArrowRight,
  PhCheckCircle as CheckCircle,
  PhCrown as Crown,
  PhEye as Eye,
  PhEyeSlash as EyeSlash,
  PhGearSix as GearSix,
  PhMaskHappy as MaskHappy,
  PhPlay as Play,
  PhSignOut as SignOut,
  PhSparkle as Sparkle,
  PhUser as User,
  PhUsersThree as UsersThree,
  PhWarningCircle as WarningCircle,
} from "@phosphor-icons/vue";
import VictoryHero from "../components/VictoryHero.vue";
import AvatarBadge from "../components/AvatarBadge.vue";
import undercoverMarkUrl from "../assets/undercover-mark.webp";
import { createOfflineGame } from "./useOfflineGame";

const emit = defineEmits<{ exit: []; toggleTheme: [] }>();
const game = createOfflineGame();
const participantCount = ref(5);
const hostParticipates = ref(true);
const names = ref<string[]>([]);
const avatars = ref<AvatarId[]>([]);
const advancedOpen = ref(false);
const setupError = ref<string | null>(game.storageWarning.value);
const selectedTarget = ref<string | null | undefined>(undefined);
const selfDestructGuess = ref("");
const customCivilianWord = ref("");
const customUndercoverWord = ref("");
const managementOpen = ref(false);
const recheckOpen = ref(false);
const pendingLeaveId = ref<string | null>(null);
const revealTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const resultTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const config = reactive<RoomConfig>({ ...DEFAULT_ROLE_CONFIGS[5]!, hostParticipates: true, resultAdvance: "MANUAL" });

const roleLabels: Record<Role, string> = { CIVILIAN: "平民", UNDERCOVER: "卧底", BLANK: "白板", DOUBLE_AGENT: "双面间谍" };
const state = game.state;
const host = computed(() => state.value?.members.find((member) => member.id === state.value?.hostId) ?? null);
const currentPrivate = game.currentPrivatePlayer;
const currentVoter = game.currentVoter;
const currentSpeaker = game.currentSpeaker;
const canAbstain = computed(() => game.aliveMembers.value.length >= 4);
const phaseTitle = computed(() => {
  if (!state.value) return "线下同屏";
  if (state.value.phase === "SPEAKING") return `第${state.value.round}轮 · 发言`;
  if (state.value.phase === "VOTING") return `第${state.value.round}轮 · 匿名投票`;
  if (state.value.phase === "RUNOFF") return `第${state.value.round}轮 · 平票重投`;
  if (state.value.phase === "ROUND_RESULT") return `第${state.value.round}轮 · 投票结果`;
  if (state.value.phase === "ENDED") return "游戏结束";
  return "私密发牌";
});
const totalPeople = computed(() => participantCount.value + (hostParticipates.value ? 0 : 1));
const setupConfigValid = computed(() => config.civilianCount + config.undercoverCount + config.blankCount + config.doubleAgentCount === participantCount.value);

function resetNames() {
  const desired = totalPeople.value;
  names.value = Array.from({ length: desired }, (_, index) => names.value[index] ?? (index === 0 ? "主持人" : `玩家${index + 1}`));
  avatars.value = Array.from({ length: desired }, (_, index) => avatars.value[index] ?? AVATAR_IDS[index] ?? "robot");
}

function cycleAvatar(index: number) {
  const occupied = new Set(avatars.value.filter((_, avatarIndex) => avatarIndex !== index));
  const currentIndex = AVATAR_IDS.indexOf(avatars.value[index] ?? "robot");
  for (let offset = 1; offset <= AVATAR_IDS.length; offset += 1) {
    const candidate = AVATAR_IDS[(currentIndex + offset) % AVATAR_IDS.length];
    if (candidate && !occupied.has(candidate)) { avatars.value[index] = candidate; return; }
  }
}

function applyPreset() {
  const preset = DEFAULT_ROLE_CONFIGS[participantCount.value];
  if (!preset) return;
  config.civilianCount = preset.civilianCount;
  config.undercoverCount = preset.undercoverCount;
  config.blankCount = preset.blankCount;
  config.doubleAgentCount = preset.doubleAgentCount;
}

watch([participantCount, hostParticipates], () => {
  config.hostParticipates = hostParticipates.value;
  resetNames();
  applyPreset();
}, { immediate: true });

watch(
  () => state.value?.privacy.mode,
  (mode) => {
    if (revealTimer.value) clearTimeout(revealTimer.value);
    if (mode === "REVEAL") revealTimer.value = setTimeout(() => game.hideIdentity(), 5_000);
    if (mode !== "CAST") selectedTarget.value = undefined;
  },
);

watch(
  () => state.value?.phase,
  (phase) => {
    if (resultTimer.value) clearTimeout(resultTimer.value);
    if (phase === "ROUND_RESULT" && state.value?.config.resultAdvance === "AUTO") resultTimer.value = setTimeout(() => game.nextRound(), 5_000);
  },
);

function adjustCount(delta: number) {
  participantCount.value = Math.min(12, Math.max(3, participantCount.value + delta));
}

function adjustRole(key: "civilianCount" | "undercoverCount" | "blankCount" | "doubleAgentCount", delta: number) {
  const min = key === "blankCount" || key === "doubleAgentCount" ? 0 : 1;
  const max = key === "blankCount" || key === "doubleAgentCount" ? 2 : 11;
  config[key] = Math.min(max, Math.max(min, config[key] + delta));
}

function startGame() {
  setupError.value = game.start({
    participantCount: participantCount.value,
    hostParticipates: hostParticipates.value,
    names: names.value,
    config: { ...config, hostParticipates: hostParticipates.value },
    avatars: [...avatars.value],
    ...(!hostParticipates.value && customCivilianWord.value.trim() && customUndercoverWord.value.trim()
      ? { customWords: { civilian: customCivilianWord.value.trim(), undercover: customUndercoverWord.value.trim() } }
      : {}),
  });
}

function submitVote() {
  if (selectedTarget.value === undefined) return;
  const error = game.submitVote(selectedTarget.value, selfDestructGuess.value);
  if (error) setupError.value = error;
  else { selectedTarget.value = undefined; selfDestructGuess.value = ""; }
}

function hideSensitive() {
  if (document.visibilityState === "hidden") game.forceHideSecret();
}

function confirmLeave() {
  if (!pendingLeaveId.value) return;
  const error = game.markLeft(pendingLeaveId.value);
  pendingLeaveId.value = null;
  if (error) setupError.value = error;
}

function exitOffline() {
  game.abandon();
  emit("exit");
}

onMounted(() => {
  document.addEventListener("visibilitychange", hideSensitive);
  window.addEventListener("blur", game.forceHideSecret);
  window.addEventListener("pageshow", game.forceHideSecret);
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", hideSensitive);
  window.removeEventListener("blur", game.forceHideSecret);
  window.removeEventListener("pageshow", game.forceHideSecret);
  if (revealTimer.value) clearTimeout(revealTimer.value);
  if (resultTimer.value) clearTimeout(resultTimer.value);
});
</script>

<template>
  <section v-if="game.resumeCandidate.value && !state" class="phone-page offline-page resume-page">
    <div class="resume-icon"><MaskHappy :size="42" weight="fill" /></div>
    <h1>继续上一局？</h1>
    <p>检测到第 {{ game.resumeCandidate.value.round }} 轮线下对局。继续前不会展示任何身份信息。</p>
    <button class="primary-button" @click="game.resume()"><Play :size="20" weight="fill" />继续游戏</button>
    <button class="secondary-button" @click="game.abandon()">放弃并重新设置</button>
    <button class="text-button offline-home-link" @click="emit('exit')"><ArrowLeft :size="16" />返回模式选择</button>
  </section>

  <section v-else-if="!state" class="phone-page offline-page setup-page">
    <header class="topbar">
      <button class="icon-button" aria-label="返回模式选择" @click="emit('exit')"><ArrowLeft :size="22" /></button>
      <h1>线下同屏</h1><span class="topbar-spacer" />
    </header>

    <div class="offline-intro">
      <span><UsersThree :size="32" weight="fill" /></span>
      <div><h2>一台手机，全员开局</h2><p>身份和投票会逐人私密展示</p></div>
    </div>

    <div class="config-summary compact">
      <span>参赛人数</span><strong>{{ participantCount }}</strong><small>现场共 {{ totalPeople }} 人</small>
      <div class="setup-stepper"><button aria-label="参赛人数减一" @click="adjustCount(-1)">−</button><button aria-label="参赛人数加一" @click="adjustCount(1)">＋</button></div>
    </div>

    <div class="config-card">
      <div class="host-toggle">
        <div><strong>主持人参与游戏</strong><small>关闭后首位玩家只负责主持</small></div>
        <button class="switch" :class="{ active: hostParticipates }" role="switch" :aria-checked="hostParticipates" @click="hostParticipates = !hostParticipates"><span /></button>
      </div>
    </div>
    <div class="config-card v2-config-grid">
      <label><strong>对局模式</strong><select v-model="config.mode"><option value="CLASSIC_REVEALED">经典明牌</option><option value="CLASSIC_HIDDEN">经典暗牌</option><option value="EXPLOSIVE_REVEALED">明牌自爆</option><option value="EXPLOSIVE_HIDDEN">暗牌自爆</option></select></label>
      <p class="play-tip">{{ config.mode.includes('HIDDEN') ? '开局只知道词语，需要推测自己的身份。' : '开局可查看身份与词语。' }} {{ config.mode.includes('EXPLOSIVE') ? '自爆只在满足轮次的普通投票页出现。' : '' }}</p>
      <label><strong>词组分类</strong><select v-model="config.wordCategory"><option value="GENERAL">全民精选</option><option value="FUNNY">欢乐搞笑</option><option value="IDIOM">成语文化</option><option value="FOOD">食物饮品</option><option value="ANIMAL_NATURE">动物自然</option><option value="DAILY">日常生活</option><option value="SCHOOL_WORK">校园职场</option><option value="TRAVEL">旅行出行</option><option value="ENTERTAINMENT">影视综艺</option><option value="TECH">数码互联网</option><option value="MEDICAL">医学健康</option><option value="GAME">游戏通用</option><option value="HONOR_OF_KINGS">王者荣耀英雄</option><option value="CAR">汽车</option><option value="SCIENCE">轻科普</option></select></label>
      <label><strong>难度</strong><select v-model="config.wordDifficulty"><option value="EASY">轻松</option><option value="STANDARD">标准</option><option value="HARD">烧脑</option></select></label>
    </div>

    <div class="section-heading"><div><span>现场成员</span><small>第一位默认为主持人</small></div><em>{{ names.length }} 人</em></div>
    <div class="offline-name-list card-surface">
      <label v-for="(_, index) in names" :key="index">
        <span>{{ index + 1 }}</span><button class="offline-avatar-button" type="button" :aria-label="`更换${names[index]}的头像`" @click="cycleAvatar(index)"><AvatarBadge :avatar-id="avatars[index] ?? 'robot'" size="small" /></button>
        <input v-model="names[index]" :aria-label="index === 0 ? '主持人姓名' : `玩家${index + 1}姓名`" maxlength="12" />
        <small v-if="index === 0 && !hostParticipates">仅主持</small><Crown v-else-if="index === 0" :size="17" weight="fill" />
      </label>
    </div>

    <button class="offline-disclosure" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
      <span><strong>高级设置</strong><small>平民 {{ config.civilianCount }} · 卧底 {{ config.undercoverCount }} · 白板 {{ config.blankCount }} · 间谍 {{ config.doubleAgentCount }}</small></span>
      <ArrowRight :size="18" :class="{ rotated: advancedOpen }" />
    </button>
    <div v-if="advancedOpen" class="config-card">
      <div v-for="item in [
        { key: 'civilianCount', label: '平民数量' },
        { key: 'undercoverCount', label: '卧底数量' },
        { key: 'blankCount', label: '白板数量' },
        { key: 'doubleAgentCount', label: '双面间谍' },
      ]" :key="item.key" class="config-row compact-row">
        <strong>{{ item.label }}</strong>
        <div class="stepper"><button :aria-label="`${item.label}减一`" @click="adjustRole(item.key as 'civilianCount' | 'undercoverCount' | 'blankCount' | 'doubleAgentCount', -1)">−</button><span>{{ config[item.key as keyof RoomConfig] }}</span><button :aria-label="`${item.label}加一`" @click="adjustRole(item.key as 'civilianCount' | 'undercoverCount' | 'blankCount' | 'doubleAgentCount', 1)">＋</button></div>
      </div>
      <label class="config-select-row"><strong>自爆提示轮</strong><select v-model.number="config.selfDestructRound"><option :value="2">第 2 轮</option><option :value="3">第 3 轮</option><option :value="4">第 4 轮</option></select></label>
      <label class="config-select-row"><strong>发言计时</strong><select v-model.number="config.speakingSeconds"><option :value="0">关闭</option><option :value="30">30 秒</option><option :value="45">45 秒</option><option :value="60">60 秒</option></select></label>
      <label class="config-select-row"><strong>结果推进</strong><select v-model="config.resultAdvance"><option value="MANUAL">主持人手动</option><option value="AUTO">自动 5 秒</option></select></label>
    </div>
    <div v-if="!hostParticipates" class="config-card custom-words-card"><strong>主持人自定义词语（可选）</strong><input v-model="customCivilianWord" maxlength="12" placeholder="平民词" /><input v-model="customUndercoverWord" maxlength="12" placeholder="卧底词" /></div>
    <p v-if="setupError || !setupConfigValid" class="validation-message"><WarningCircle :size="18" />{{ setupError ?? '身份总数需要等于参赛人数' }}</p>
    <button class="primary-button bottom-action" @click="startGame"><Sparkle :size="20" weight="fill" />开始发牌</button>
  </section>

  <section v-else-if="state.privacy.mode !== 'PUBLIC'" class="phone-page offline-page private-page" :class="{ revealed: state.privacy.mode === 'REVEAL' }">
    <template v-if="state.privacy.mode === 'HANDOFF'">
      <div class="private-progress"><span>{{ state.privacy.purpose === 'DEALING' ? '私密发牌' : state.privacy.purpose === 'RECHECK' ? '身份复查' : '匿名投票' }}</span><strong v-if="state.privacy.purpose === 'DEALING'">{{ state.dealingIndex + 1 }} / {{ state.participantCount }}</strong><strong v-else-if="state.privacy.purpose === 'VOTING' || state.privacy.purpose === 'RUNOFF'">{{ state.voterIndex + 1 }} / {{ state.voterOrder.length }}</strong></div>
      <div class="handoff-lock"><User :size="42" weight="fill" /></div>
      <p>请把手机交给</p><h1>{{ currentPrivate?.nickname }}</h1>
      <small>确认周围的人看不到屏幕后再继续</small>
      <button class="private-primary" @click="game.beginPrivateTurn()">我是 {{ currentPrivate?.nickname }}，继续</button>
      <button v-if="state.phase === 'RUNOFF'" class="private-secondary" @click="game.finishRunoff()">主持人结束重投</button>
    </template>

    <template v-else-if="state.privacy.mode === 'REVEAL'">
      <button class="secret-card" aria-label="隐藏身份" @click="game.hideIdentity()">
        <EyeSlash :size="30" /><span>你的身份</span><strong>{{ currentPrivate?.roleRevealed && currentPrivate.role ? roleLabels[currentPrivate.role] : '尚未揭示' }}</strong>
        <b>{{ currentPrivate?.role === 'BLANK' ? '你没有词语' : currentPrivate?.word }}</b><small>5 秒后自动隐藏 · 点击立即隐藏</small>
      </button>
    </template>

    <template v-else>
      <div class="private-progress"><span>{{ state.phase === 'RUNOFF' ? '平票重投' : '匿名投票' }}</span><strong>{{ state.voterIndex + 1 }} / {{ state.voterOrder.length }}</strong></div>
      <div class="private-voter"><small>当前投票人</small><h1>{{ currentVoter?.nickname }}</h1><p>投票关系不会在公共结果中公开</p></div>
      <div class="private-vote-grid">
        <button v-for="candidateId in state.candidateIds" :key="candidateId" :disabled="candidateId === currentVoter?.id" :class="{ selected: selectedTarget === candidateId }" @click="selectedTarget = candidateId">
          <AvatarBadge :avatar-id="game.membersById.value.get(candidateId)?.avatarId ?? 'robot'" size="medium" /><strong>{{ game.membersById.value.get(candidateId)?.nickname }}</strong><small v-if="candidateId === currentVoter?.id">不能选自己</small><small v-else-if="state.phase === 'RUNOFF'">上轮 {{ state.runoffTallies?.find(item => item.playerId === candidateId)?.votes ?? 0 }} 票</small>
        </button>
      </div>
      <button v-if="canAbstain" class="private-abstain" :class="{ selected: selectedTarget === null }" @click="selectedTarget = null">本轮弃权</button>
      <label v-if="game.canGuess(currentVoter)" class="self-destruct-box"><strong>自爆猜词（可选，仅一次）</strong><small>猜词与选票一起密封，结算后才揭晓；平票重投不能新增。</small><input v-model="selfDestructGuess" maxlength="12" placeholder="输入猜测的平民词" /></label>
      <button class="private-primary" :disabled="selectedTarget === undefined" @click="submitVote">确认匿名投票</button>
      <button v-if="state.phase === 'RUNOFF'" class="private-secondary" @click="game.finishRunoff()">主持人结束重投</button>
    </template>
  </section>

  <section v-else class="phone-page offline-page room-page">
    <header class="topbar room-topbar">
      <span class="offline-pill">本机进行</span><h1>{{ phaseTitle }}</h1>
      <button v-if="state.phase !== 'ENDED'" class="icon-button" aria-label="现场管理" @click="managementOpen = true"><GearSix :size="21" /></button><span v-else />
    </header>
    <p v-if="state.notice" class="offline-notice"><WarningCircle :size="18" />{{ state.notice }}</p>

    <template v-if="state.phase === 'SPEAKING'">
      <div class="speaker-hero"><span>当前发言</span><strong>{{ currentSpeaker?.nickname }}</strong><small>{{ state.speakerIndex + 1 }} / {{ state.speakingOrder.length }}</small></div>
      <div class="speaking-list card-surface">
        <article v-for="(playerId, index) in state.speakingOrder" :key="playerId" class="speaker-row" :class="{ active: index === state.speakerIndex, done: index < state.speakerIndex }"><span>{{ index + 1 }}</span><AvatarBadge :avatar-id="game.membersById.value.get(playerId)?.avatarId ?? 'robot'" size="small" /><strong>{{ game.membersById.value.get(playerId)?.nickname }}</strong><small>{{ index < state.speakerIndex ? '已发言' : index === state.speakerIndex ? (state.speakingStartedAt ? '发言中' : '待开始') : '等待中' }}</small></article>
      </div>
      <p class="play-tip">描述词语时不要太直白，给队友线索的同时，别让卧底轻易猜中。</p>
      <button class="secondary-button" @click="recheckOpen = true"><Eye :size="19" />重新查看身份</button>
      <button v-if="!state.speakingStartedAt" class="secondary-button" @click="game.startSpeaking()"><Play :size="19" />开始当前发言</button>
      <button class="primary-button" @click="game.nextSpeaker()"><CheckCircle :size="20" />{{ state.speakerIndex === state.speakingOrder.length - 1 ? '结束发言，开始投票' : '下一位发言' }}</button>
    </template>

    <template v-else-if="state.phase === 'ROUND_RESULT' && state.roundResult">
      <div class="result-hero"><span class="result-icon"><WarningCircle :size="36" weight="fill" /></span><h2>{{ state.roundResult.eliminatedPlayerIds.length ? `${state.roundResult.eliminatedPlayerIds.map(id => game.membersById.value.get(id)?.nickname).join('、')} 已被淘汰` : '本轮无人淘汰' }}</h2><p>身份暂不公开，由主持人继续下一轮</p></div>
      <div v-for="result in state.roundResult.selfDestructResults" :key="result.playerId" class="self-destruct-result" :class="{ correct: result.correct }"><strong>{{ result.correct ? `${game.membersById.value.get(result.playerId)?.nickname} 猜中平民词` : `${result.role === 'DOUBLE_AGENT' ? '间谍' : '卧底'}玩家猜词失败，${game.membersById.value.get(result.playerId)?.nickname} 已被淘汰` }}</strong><small>猜测：{{ result.guess }}</small></div>
      <div class="tally-card card-surface"><article v-for="item in state.roundResult.tallies" :key="item.playerId"><span class="avatar-small"><User :size="18" weight="fill" /></span><strong>{{ game.membersById.value.get(item.playerId)?.nickname ?? '已退出玩家' }}</strong><span>{{ item.votes }} 票</span></article><article><span class="avatar-small muted"><SignOut :size="18" /></span><strong>弃权</strong><span>{{ state.roundResult.abstainCount }} 票</span></article></div>
      <button v-if="state.config.resultAdvance === 'MANUAL'" class="primary-button bottom-action" @click="game.nextRound()"><ArrowRight :size="20" />进入下一轮</button>
      <p v-else class="action-hint">5 秒后自动进入下一轮</p>
    </template>

    <template v-else-if="state.phase === 'ENDED' && state.winner">
      <VictoryHero :title="state.winner === 'CIVILIAN' ? '平民阵营胜利！' : '卧底阵营胜利！'" subtitle="本局身份现已全部公开" />
      <div class="word-reveal card-surface"><div><span>平民词</span><strong>{{ state.wordPair.civilian }}</strong></div><div><span>卧底词</span><strong>{{ state.wordPair.undercover }}</strong></div></div>
      <div class="final-list card-surface"><article v-for="member in state.members.filter(item => item.participates)" :key="member.id"><AvatarBadge :avatar-id="member.avatarId" size="small" /><strong>{{ member.nickname }}</strong><span v-if="member.role" class="role-badge" :class="member.role.toLowerCase()">{{ roleLabels[member.role] }}</span><small>{{ member.left ? '已退出' : member.alive ? '存活' : '已淘汰' }}</small></article></div>
      <div class="recap-card card-surface"><strong>对局复盘</strong><article v-for="round in state.rounds" :key="round.round"><span>第 {{ round.round }} 轮</span><small>{{ round.eliminatedPlayerIds.length ? `淘汰 ${round.eliminatedPlayerIds.length} 人` : '无人淘汰' }} · 自爆 {{ round.selfDestructResults.length }} 次</small></article></div>
      <button class="primary-button" @click="game.rematch()"><Sparkle :size="20" weight="fill" />再来一局</button>
      <button class="secondary-button" @click="exitOffline">结束并返回首页</button>
    </template>

    <div v-if="recheckOpen" class="modal-backdrop" @click.self="recheckOpen = false"><section class="modal-card management-card" role="dialog" aria-modal="true"><h2>谁要查看身份？</h2><p>请先把手机交给本人，身份会在 5 秒后隐藏。</p><div class="management-list"><article v-for="member in game.aliveMembers.value" :key="member.id"><span class="avatar-small"><User :size="18" weight="fill" /></span><strong>{{ member.nickname }}</strong><button class="text-button" @click="game.recheckIdentity(member.id); recheckOpen = false">交给本人</button></article></div><button class="secondary-button" @click="recheckOpen = false">取消</button></section></div>

    <div v-if="managementOpen" class="modal-backdrop" @click.self="managementOpen = false"><section class="modal-card management-card" role="dialog" aria-modal="true" aria-label="现场管理"><h2>现场管理</h2><p>主持人可转移权限或标记成员退出，管理页不会显示任何身份。</p><div class="management-list"><article v-for="member in state.members.filter(item => !item.left)" :key="member.id"><AvatarBadge :avatar-id="member.avatarId" size="small" /><span><strong>{{ member.nickname }}</strong><small>{{ member.id === state.hostId ? '主持人' : member.participates ? member.alive ? '存活' : '已淘汰' : '仅主持' }}</small></span><Crown v-if="member.id === state.hostId" class="crown" :size="20" weight="fill" /><template v-else><button class="text-button" @click="game.transferHost(member.id)">转移主持</button><button class="text-button danger-soft" @click="pendingLeaveId = member.id">退出</button></template></article></div><button class="secondary-button" @click="emit('toggleTheme')">切换日间 / 夜间模式</button><button class="secondary-button" @click="managementOpen = false">返回游戏</button></section></div>
  </section>

  <div v-if="pendingLeaveId && state" class="modal-backdrop"><section class="modal-card" role="dialog" aria-modal="true"><span class="modal-icon warning"><WarningCircle :size="32" weight="fill" /></span><h2>确认标记退出？</h2><p>若正在投票，已提交的匿名选票可能全部作废并重新开始。</p><div class="modal-actions"><button class="secondary-button" @click="pendingLeaveId = null">取消</button><button class="danger-button" @click="confirmLeave">确认退出</button></div></section></div>

  <div v-if="setupError && state" class="toast error" role="status">{{ setupError }}<button aria-label="关闭提示" @click="setupError = null">×</button></div>
</template>
