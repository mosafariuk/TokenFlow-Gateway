export interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
}

export interface CompletionRequest {
  model: string;
  messages?: ChatMessage[];
  prompt?: string | string[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  tpmLimit: number;
  rpmLimit: number;
  priority: number;
}

export type CacheHit = "none" | "exact" | "semantic";
