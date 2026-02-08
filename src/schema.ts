import { z } from 'zod';

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1),
  name: z.string().optional()
});

export const ActionNameSchema = z.enum([
  'summarize',
  'extract',
  'transform',
  'healthcheck',
  'list_services',
  'tail_log'
]);

export const ActionEnvelopeSchema = z.object({
  action: ActionNameSchema,
  input: z.string().default(''),
  options: z.record(z.string(), z.unknown()).optional().default({})
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(8192).optional(),
  user: z.string().optional()
});

export const OpenAIErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().default('invalid_request_error'),
    code: z.string().optional()
  })
});

export const DebateRequestSchema = z.object({
  topic: z.string().min(3).max(500),
  moderatorInstruction: z.string().min(1).max(1000).optional(),
  moderator_decision_mode: z.literal('openclaw_decides').optional().default('openclaw_decides'),
  modelA: z.string().min(1).max(120),
  modelB: z.string().min(1).max(120),
  rounds: z.number().int().min(1).max(3).optional().default(3),
  turnsPerRound: z.number().int().min(4).max(10).optional().default(4),
  maxTurnChars: z.number().int().min(200).max(2000).optional().default(1200),
  includeModeratorSummary: z.boolean().optional().default(false),
  temperatureA: z.number().min(0).max(2).optional(),
  temperatureB: z.number().min(0).max(2).optional()
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type ActionName = z.infer<typeof ActionNameSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type DebateRequest = z.infer<typeof DebateRequestSchema>;
