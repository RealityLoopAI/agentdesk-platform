export type PipelineStage = 'configuration' | 'input' | 'multimodal';

export class AudioPipelineError extends Error {
  readonly stage: PipelineStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly transcriptAvailable: boolean;
  readonly requestId?: string;

  constructor(
    stage: PipelineStage,
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      transcriptAvailable?: boolean;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AudioPipelineError';
    this.stage = stage;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.transcriptAvailable = options.transcriptAvailable ?? false;
    this.requestId = options.requestId;
  }

  toSafeJSON(): Record<string, unknown> {
    return {
      name: this.name,
      stage: this.stage,
      code: this.code,
      retryable: this.retryable,
      transcriptAvailable: this.transcriptAvailable,
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
