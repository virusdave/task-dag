/**
 * LLM Client for Google Ads Optimization
 * Handles calls to LLM endpoints for L1 spot-checks, L2 predictions, and L3 analysis
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model?: string;
  timeout?: number;
}

export interface LLMRequest {
  use_case: string;
  system_prompt: string;
  user_prompt: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: 'json' | 'text';
}

export interface LLMResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
  finish_reason?: string;
}

/**
 * LLM Client
 */
export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Call LLM with structured request
   */
  async call(request: LLMRequest): Promise<LLMResponse> {
    const url = `${this.config.endpoint}/chat/completions`;
    
    const payload = {
      model: this.config.model || 'gpt-4o',
      use_case: request.use_case, // For Mantle routing/logging/costing
      messages: [
        { role: 'system', content: request.system_prompt },
        { role: 'user', content: request.user_prompt },
      ],
      temperature: request.temperature ?? 0.1,
      max_tokens: request.max_tokens ?? 4000,
      ...(request.response_format === 'json' && {
        response_format: { type: 'json_object' },
      }),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.timeout || 300000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    
    return {
      content: data.choices[0].message.content,
      usage: data.usage,
      model: data.model,
      finish_reason: data.choices[0].finish_reason,
    };
  }

  /**
   * Call with automatic retry on failure
   */
  async callWithRetry(
    request: LLMRequest,
    maxRetries: number = 3,
    retryDelay: number = 2000
  ): Promise<LLMResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.call(request);
      } catch (error) {
        lastError = error as Error;
        console.error(`LLM call attempt ${attempt + 1}/${maxRetries} failed:`, error);
        
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
        }
      }
    }
    
    throw new Error(`LLM call failed after ${maxRetries} attempts: ${lastError?.message}`);
  }
}

/**
 * Load Bedrock Mantle credentials from production secret store
 */
function loadBedrockMantleCredentials(): { endpoint: string; apiKey: string } {
  // Try /home/amp-local/.secret/bedrock first, then ~/.secret/bedrock
  const secretPaths = [
    '/home/amp-local/.secret/bedrock/mantle-bearer-token',
    path.join(os.homedir(), '.secret/bedrock/mantle-bearer-token'),
  ];
  
  let token: string | null = null;
  for (const secretPath of secretPaths) {
    try {
      token = fsSync.readFileSync(secretPath, 'utf-8').trim();
      break;
    } catch {
      // Try next path
    }
  }
  
  if (!token) {
    throw new Error(
      'Bedrock Mantle token not found in /home/amp-local/.secret or ~/.secret/bedrock/mantle-bearer-token'
    );
  }
  
  return {
    endpoint: 'https://bedrock-mantle.us-east-2.api.aws/v1',
    apiKey: token,
  };
}

/**
 * Create LLM client from production Bedrock Mantle credentials
 */
export function createLLMClientFromEnv(): LLMClient {
  // Try environment variables first (for local dev/testing)
  const endpoint = process.env.LLM_ENDPOINT_BASE || process.env.OPENAI_BASE_URL;
  const apiKey = process.env.LLM_API_KEY || process.env.BEDROCK_MANTLE_BEARER_TOKEN;

  if (endpoint && apiKey) {
    return new LLMClient({
      endpoint,
      apiKey,
      model: process.env.LLM_MODEL || 'google.gemma-3-27b-it',
      timeout: parseInt(process.env.LLM_TIMEOUT || '300000'),
    });
  }
  
  // Fall back to production Bedrock Mantle secrets
  try {
    const credentials = loadBedrockMantleCredentials();
    return new LLMClient({
      endpoint: credentials.endpoint,
      apiKey: credentials.apiKey,
      model: 'google.gemma-3-27b-it',
      timeout: 300000,
    });
  } catch (error) {
    throw new Error(`Failed to load LLM credentials: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Load prompt templates from YAML config
 */
/**
 * Read the L3 addenda file if it exists. The addenda are short
 * natural-language guidance derived from L3 meta-analysis of recent
 * L2 outputs and ad attempt outcomes; they are appended to the L2
 * system prompt to feed self-improvement back into the daily loop.
 *
 * The file lives next to l2-prompts.yaml so L3 only needs to write
 * one path. Absent file → empty string (no-op).
 *
 * Env override: GADS_L3_ADDENDA_PATH lets local dev / tests point
 * at a fixture.
 */
export async function readL3Addenda(promptConfigPath: string): Promise<string> {
  const override = process.env.GADS_L3_ADDENDA_PATH?.trim()
  const addendaPath = override
    ? override
    : `${promptConfigPath.replace(/\/[^/]+\.ya?ml$/, '')}/l3-addenda.md`
  try {
    const txt = await fs.readFile(addendaPath, 'utf-8')
    return txt.trim()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

export async function loadPromptConfig(configPath: string): Promise<any> {
  const yaml = await import('js-yaml');
  const content = await fs.readFile(configPath, 'utf-8');
  return yaml.load(content);
}

/**
 * Format prompt template with variables
 */
export function formatPromptTemplate(template: string, variables: Record<string, any>): string {
  let result = template;
  
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{${key}}`;
    const replacement = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    result = result.replace(new RegExp(placeholder, 'g'), replacement);
  }
  
  return result;
}
