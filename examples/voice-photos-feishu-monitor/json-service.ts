import { createVoicePhotoMachineIdempotencyKey } from './json-analysis.js';
import type { VoicePhotoJsonMonitorConfig } from './json-config.js';
import {
  readQualifiedVoicePhotoJson,
  scanVoicePhotoJson,
  type JsonSnapshot,
  type QualifiedJsonFile,
} from './json-scanner.js';
import { VoicePhotoJsonState } from './json-state.js';

export interface VoicePhotoJsonEnvelope {
  schemaVersion: 'voice-photo-json-bitable-ingest.v1';
  kind: 'feishu.bitable.record.create.machine';
  resource: string;
  source: { relativePath: string; digest: string };
  fields: Record<string, unknown>;
  idempotencyKey: string;
  workflow: {
    operation: 'feishu.bitable.record.create';
    confirmation: 'forbidden';
    verifyByRecordId: true;
  };
}

export interface VoicePhotoJsonServiceDependencies {
  state: VoicePhotoJsonState;
  submit(envelope: VoicePhotoJsonEnvelope): Promise<void>;
  now?: () => number;
  scan?: typeof scanVoicePhotoJson;
  read?: typeof readQualifiedVoicePhotoJson;
  log?: (event: Record<string, unknown>) => void;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 128);
  }
  return error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN_JSON_ERROR';
}

export class VoicePhotoJsonService {
  private readonly now: () => number;
  private readonly scan: typeof scanVoicePhotoJson;
  private readonly read: typeof readQualifiedVoicePhotoJson;

  constructor(
    private readonly config: VoicePhotoJsonMonitorConfig,
    private readonly dependencies: VoicePhotoJsonServiceDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
    this.scan = dependencies.scan ?? scanVoicePhotoJson;
    this.read = dependencies.read ?? readQualifiedVoicePhotoJson;
  }

  private envelope(file: QualifiedJsonFile): VoicePhotoJsonEnvelope {
    return {
      schemaVersion: 'voice-photo-json-bitable-ingest.v1',
      kind: 'feishu.bitable.record.create.machine',
      resource: file.resource,
      source: { relativePath: file.relativePath, digest: file.digest },
      fields: file.fields,
      idempotencyKey: createVoicePhotoMachineIdempotencyKey({
        digest: file.digest,
        resource: file.resource,
        fields: file.fields,
        hmacKey: this.config.machineIngestHmacKey,
      }),
      workflow: {
        operation: 'feishu.bitable.record.create',
        confirmation: 'forbidden',
        verifyByRecordId: true,
      },
    };
  }

  private async process(snapshot: JsonSnapshot): Promise<void> {
    if (!this.dependencies.state.stable(snapshot, this.config.stabilityScans, this.now())) return;
    let file: QualifiedJsonFile;
    try {
      file = await this.read(this.config.rootPath, snapshot, this.config.maxJsonBytes, this.config.routes);
    } catch (error) {
      this.dependencies.state.invalid(snapshot, errorCode(error), this.now());
      this.dependencies.log?.({
        event: 'voice_photo_json_rejected',
        relativePath: snapshot.relativePath.slice(0, 512),
        code: errorCode(error),
      });
      return;
    }
    const envelope = this.envelope(file);
    if (!this.dependencies.state.submitted(file, envelope.idempotencyKey, this.now())) return;
    try {
      await this.dependencies.submit(envelope);
      this.dependencies.log?.({
        event: 'voice_photo_json_submitted',
        digest: file.digest,
        relativePath: file.relativePath.slice(0, 512),
      });
    } catch (error) {
      this.dependencies.state.retry(file.digest, this.now());
      throw error;
    }
  }

  async runOneCycle(): Promise<void> {
    const snapshots = await this.scan(this.config.rootPath, this.config.maxCandidatesPerScan);
    if (!this.dependencies.state.baselineComplete()) {
      this.dependencies.state.commitBaseline(snapshots, this.now());
      this.dependencies.log?.({ event: 'voice_photo_json_baseline_complete', files: snapshots.length });
      return;
    }
    for (const snapshot of snapshots) await this.process(snapshot);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOneCycle();
      } catch (error) {
        this.dependencies.log?.({ event: 'voice_photo_json_cycle_failed', code: errorCode(error) });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.config.pollIntervalMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
