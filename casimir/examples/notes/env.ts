import { defineEnv, string } from 'void/env';
export default defineEnv({
  SERVER_ONLY: string(),
  VITE_APP_TITLE: string().default('Casimir notes'),
});
