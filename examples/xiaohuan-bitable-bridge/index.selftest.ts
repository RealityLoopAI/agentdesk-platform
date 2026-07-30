import { assertChannelAdapterContract } from '../../src/channels/channel-contract.js';
import type { EnabledBridgeConfig } from './config.js';
import { createXiaohuanBitableAdapter } from './adapter.js';

// Contract admission is structural and must not bind UDP, upload audio or
// require operator credentials. The adapter lifecycle remains unstarted.
const adapter = createXiaohuanBitableAdapter({ enabled: true } as EnabledBridgeConfig);
assertChannelAdapterContract(adapter);

if (adapter.channelType !== 'xiaohuan-bitable') {
  throw new Error('channelType drifted from manifest');
}
if (adapter.supportsThreads) {
  throw new Error('the fixed Feishu P2P bridge must not model threads');
}

// eslint-disable-next-line no-console
console.log('xiaohuan-bitable-bridge: assertChannelAdapterContract passed ✓');
