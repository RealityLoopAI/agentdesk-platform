/**
 * Fork-free registration entry for the operator-bound Xiaohuan Bitable bridge.
 *
 * Importing this module only registers a factory. The factory returns null
 * while the bridge is disabled, so the default deployment never opens UDP or
 * uploads audio.
 */
import { registerChannelAdapter } from '../../src/channels/channel-registry.js';
import { createXiaohuanBitableAdapter } from './adapter.js';
import { loadBridgeConfig } from './config.js';

export { createXiaohuanBitableAdapter } from './adapter.js';
export { createBridgeEnvelope } from './envelope.js';

registerChannelAdapter('xiaohuan-bitable', {
  factory: () => {
    const config = loadBridgeConfig();
    return config.enabled ? createXiaohuanBitableAdapter(config) : null;
  },
});
