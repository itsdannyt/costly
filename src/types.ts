export interface CostlyConfig {
  projectId?: string;
  apiKey: string;
  endpoint?: string;
  flushInterval?: number;
  flushBatchSize?: number;
  debug?: boolean;
}

export interface CostlyCallMetadata {
  tag?: string;
  userId?: string;
}

export interface RequestLog {
  projectId: string;
  timestamp: string;
  model: string;
  tag: string | null;
  userId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  maxTokens: number | null;
  status: "success" | "error";
  errorType: string | null;
  promptHash: string;
  systemPromptHash: string | null;
  callSite: string | null;
  durationMs: number;
}
