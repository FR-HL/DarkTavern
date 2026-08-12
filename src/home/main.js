import '@/shared/styles/home.css';
import '@/shared/environment.js';

import { createApp } from 'vue';
import App from './App.vue';

const app = createApp (App);
// Vue 组件错误捕获：setup/渲染/事件错误全部留痕（定位页面空白）
app.config.errorHandler = (err, instance, info) => {
  const comp = instance ? (instance.type?.__name || instance.type?.name || instance.type?.__file || 'unknown') : 'root';
  window.logger?.error ('Vue error', {
    error: err?.message || String (err),
    stack: err?.stack?.slice (0, 800) || '',
    info,
    component: comp,
  });
};
app.mount ('#app');
