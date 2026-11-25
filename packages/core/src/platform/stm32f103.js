import { stm32BareMetalPlatformAdapter } from './stm32.js';

/** C8 upload support is deliberately separate from unverified STM32 programmer presets.
 * @type {import('./registry.js').PlatformAdapter}
 */
export const stm32F103SwdPlatformAdapter = Object.freeze({
  ...stm32BareMetalPlatformAdapter,
  id: 'st-stm32f103-swd',
  frameworks: Object.freeze(['bare-metal']),
  programmerId: 'stm32f103-stlink',
  matchesBoard: (board) => board.metadata.platform === 'st-stm32f103-swd'
});
