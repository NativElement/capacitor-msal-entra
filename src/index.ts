import { registerPlugin } from '@capacitor/core';
import type { MsalAuthPlugin } from './definitions';

const MsalAuth = registerPlugin<MsalAuthPlugin>('MsalAuth', {
  web: () => import('./web').then((m) => new m.MsalAuthWeb()),
});

export * from './definitions';
export { MsalAuth };
