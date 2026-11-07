import { installDailyReader } from './daily-host.mjs';

export const name = 'crysound-feishu-settings';
export const inject = ['sessions', 'sessionPersistence', 'sessionController'];
export function apply(ctx) { installDailyReader(ctx); }
