import { createApp, h } from 'vue';
import TerminalDemos from './TerminalDemos.vue';
import './studio.css';

createApp({ render: () => h(TerminalDemos, { studio: true }) }).mount('#app');
