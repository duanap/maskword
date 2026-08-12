<script setup lang="ts">
import type { AvatarId } from "@maskword/shared";

withDefaults(defineProps<{ avatarId: AvatarId; size?: "small" | "medium" | "large" }>(), { size: "medium" });

const avatars: Record<AvatarId, { glyph: string; color: string }> = {
  fox: { glyph: "🦊", color: "#f97316" }, panda: { glyph: "🐼", color: "#475569" }, frog: { glyph: "🐸", color: "#22c55e" },
  robot: { glyph: "🤖", color: "#6366f1" }, whale: { glyph: "🐳", color: "#0ea5e9" }, owl: { glyph: "🦉", color: "#a16207" },
  cat: { glyph: "🐱", color: "#ec4899" }, dog: { glyph: "🐶", color: "#ca8a04" }, rabbit: { glyph: "🐰", color: "#a855f7" },
  lion: { glyph: "🦁", color: "#d97706" }, koala: { glyph: "🐨", color: "#64748b" }, penguin: { glyph: "🐧", color: "#2563eb" },
  bear: { glyph: "🐻", color: "#92400e" }, deer: { glyph: "🦌", color: "#b45309" }, octopus: { glyph: "🐙", color: "#db2777" },
  raccoon: { glyph: "🦝", color: "#475569" },
};
</script>

<template>
  <span class="avatar-badge" :class="`avatar-${size}`" :style="{ '--avatar-color': avatars[avatarId].color }" aria-hidden="true">
    {{ avatars[avatarId].glyph }}
  </span>
</template>
