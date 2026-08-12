import { ref } from "vue";

export type ThemeChoice = "AUTO" | "DAY" | "NIGHT";
const KEY = "maskword-theme-v2";

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function createThemeController() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as { choice: ThemeChoice; date: string } | null; } catch { return null; }
  })();
  const overrideDate = ref(saved?.date === localDateKey() ? saved.date : null);
  const choice = ref<ThemeChoice>(overrideDate.value ? saved?.choice ?? "AUTO" : "AUTO");
  const effective = ref<"DAY" | "NIGHT">("DAY");

  function apply() {
    if (choice.value !== "AUTO" && overrideDate.value !== localDateKey()) {
      choice.value = "AUTO";
      overrideDate.value = null;
      localStorage.removeItem(KEY);
    }
    const hour = new Date().getHours();
    effective.value = choice.value === "AUTO" ? (hour >= 20 || hour < 8 ? "NIGHT" : "DAY") : choice.value;
    document.documentElement.dataset.theme = effective.value.toLowerCase();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", effective.value === "NIGHT" ? "#171b2e" : "#f7f7ff");
  }

  function toggle() {
    choice.value = effective.value === "NIGHT" ? "DAY" : "NIGHT";
    overrideDate.value = localDateKey();
    localStorage.setItem(KEY, JSON.stringify({ choice: choice.value, date: overrideDate.value }));
    apply();
  }

  apply();
  const timer = window.setInterval(apply, 60_000);
  return { choice, effective, toggle, stop: () => window.clearInterval(timer) };
}
