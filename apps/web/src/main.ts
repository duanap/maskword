import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { registerMaskwordPwa } from "./pwa";

createApp(App).mount("#app");
registerMaskwordPwa();
