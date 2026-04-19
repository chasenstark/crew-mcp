/**
 * message_user — write a user-visible assistant message without ending the turn.
 *
 * Contrast with `finish`: `finish` terminates the session loop; `message_user`
 * appends a SessionAssistantMessage and returns, letting the captain continue
 * its turn (another tool call, or another message, or a finish).
 *
 * Used for status updates, narration, partial reports — anything the user
 * should see but where the captain is not yet done.
 */

import { z } from 'zod';
import type { ActionCatalogEntry } from '../action-server.js';
import type { CaptainSession } from '../session.js';

export const messageUserInputSchema = z.object({
  text: z.string().min(1),
});

export type MessageUserInput = z.infer<typeof messageUserInputSchema>;

export const MESSAGE_USER_DESCRIPTION =
  'Write a message visible to the user without ending the turn.';

export interface MessageUserResult {
  readonly status: 'sent';
  readonly timestamp: string;
}

export function buildMessageUserActionEntry(): ActionCatalogEntry {
  return {
    name: 'message_user',
    description: MESSAGE_USER_DESCRIPTION,
    inputSchema: messageUserInputSchema,
  };
}

export function dispatchMessageUser(
  session: CaptainSession,
  input: MessageUserInput,
): MessageUserResult {
  const message = session.appendAssistantMessage(input.text);
  return { status: 'sent', timestamp: message.timestamp };
}
