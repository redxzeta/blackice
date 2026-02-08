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

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type ActionName = z.infer<typeof ActionNameSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
