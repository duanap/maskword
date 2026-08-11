<script setup lang="ts">
import { PhSparkle as Sparkle } from "@phosphor-icons/vue";

defineProps<{
  title: string;
  subtitle: string;
}>();
</script>

<template>
  <div class="end-hero victory-hero">
    <div class="victory-emblem" aria-hidden="true">
      <span class="victory-glow" />
      <Sparkle :size="36" weight="fill" />
      <span class="victory-sparkles">
        <i v-for="index in 8" :key="index" />
      </span>
    </div>
    <h2>{{ title }}</h2>
    <p>{{ subtitle }}</p>
  </div>
</template>
