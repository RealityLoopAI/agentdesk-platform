export const MODEL_OPTIONS = [
  { id: 'auto', label: '自动选择', description: '根据任务自动匹配' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: '旗舰能力' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: '速度与能力均衡' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', description: '复杂推理与代理任务' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: '快速且全面' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', description: '快速多模态' },
] as const;

export type ModelOption = (typeof MODEL_OPTIONS)[number];
export type ModelOptionId = ModelOption['id'];

export const DEFAULT_MODEL_OPTION_ID: ModelOptionId = 'auto';
