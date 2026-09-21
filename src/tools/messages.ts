import { z } from 'zod';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MyAtriumHealthClient } from '../client.js';
import type { PatientContext } from '../patient-context.js';
import { replyToConversation, type ReplyOptions } from '../reply.js';

/**
 * Registered unconditionally, including under MAH_READ_ONLY: the gate refuses
 * at call time instead. A hosted connector publishes the tool list of a child
 * started with no env of its own (see registerAuthTools), so a tool that only
 * registers when writes are allowed would vanish from the connector for
 * everyone, whatever they configured.
 */
export function registerMessageTools(
  server: McpServer,
  client: MyAtriumHealthClient,
  patients: PatientContext,
  opts: ReplyOptions,
): void {
  server.registerTool(
    'mah_reply_message',
    {
      description:
        'Reply to a Message Center conversation as the active patient. The provider sees ' +
        'the reply; sending is IRREVERSIBLE. Without confirm: true this only previews ' +
        '(thread, recipients, body) and sends nothing. Plain-text body, max 500 characters; ' +
        'each line becomes a paragraph. Optional attachments (PDF, image, Word or video, ' +
        'at most 3) need the server to sign in itself; the browser bridge cannot upload. ' +
        'Refused when MAH_READ_ONLY is set.',
      annotations: toolAnnotations({ readOnly: false, destructive: true }),
      inputSchema: z.object({
        conversationId: z
          .string()
          .min(1)
          .describe('The conversationId of the thread, from mah_list_messages.'),
        body: z.string().min(1).describe('Reply text. Line breaks start new paragraphs.'),
        attachments: z
          .array(
            z.object({
              filename: z.string().min(1).describe('File name with extension, e.g. scan.pdf.'),
              contentBase64: z.string().min(1).describe('The file content, base64-encoded.'),
            }),
          )
          .optional()
          .describe('Files to attach. Uploaded only when confirm is true.'),
        confirm: z
          .boolean()
          .default(false)
          .describe('Must be true to send. Otherwise the tool returns a preview and sends nothing.'),
      }),
    },
    async (args) => minifiedResult(await replyToConversation(client, patients, args, opts)),
  );
}
