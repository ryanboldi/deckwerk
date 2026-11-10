import { z } from 'zod';

export const T3ChatSchema = z.object({
  environmentId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  threadId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  context: z.string().min(1).max(8_000),
});
export type T3Chat = z.infer<typeof T3ChatSchema>;

export function t3ChatLink(chat: T3Chat): string {
  const target = T3ChatSchema.parse(chat);
  const url = new URL(`t3code://threads/${target.environmentId}/${target.threadId}`);
  url.searchParams.set('prompt', target.context);
  return url.href;
}
