import '@/shared/styles/overlay.css';
import '@/shared/environment.js';

import { createApp } from 'vue';
import App from './App.vue';
import Popper from 'vue3-popper';

const app = createApp (App);

app.component ('Popper', Popper);

app.mount ('#app');