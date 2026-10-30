import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import * as z from 'zod';
import { AppError } from './errors.js';
import type { NotesService } from './notes.js';
import type { TokenOwner } from './auth/oauth.js';
import { ATOM_STATUSES, ATOM_TYPES, UNSORTED, type Atom } from '../shared/types.js';

/*
 * The saving rules live here, in the tool descriptions, because that is what
 * the model reads when deciding whether to call Save note. Tuning this wording
 * is the main way to tune what gets saved.
 */

export const SERVER_INSTRUCTIONS = `Trellis stores the user's project notes as small "atoms": one self-contained statement of one to three sentences each.
Save only what the user decided or stated: decisions, stated facts about a project, constraints, tasks and commitments, and open questions.
Never save small talk, options that were rejected or never picked, your own suggestions the user did not adopt, or temporary state such as a bug happening right now.
Before saving, call search_notes to check for an existing note. Pick the project from list_projects; if unsure, leave the project out so the note goes to Unsorted.
If a new note contradicts an older one, pass the older note's id in "replaces". If you are not sure the user meant it, set "uncertain": true so the user reviews it first.`;

const SAVE_DESCRIPTION = `Save one note ("atom") to the user's Trellis project notes. Call this whenever the user decides or states something about one of their projects that is worth remembering. Save it as it happens; do not wait to be asked.

SAVE: decisions the user made or confirmed; facts the user stated about the project; constraints and requirements; tasks and commitments; open questions the project still has to answer.
DO NOT SAVE: small talk; options that were rejected or never picked; your own suggestions the user did not adopt; temporary state such as a bug that is happening right now; things already saved.

Rules:
1. Call search_notes first with the gist of the note. If a near-identical note already exists, Trellis raises that note's weight instead of adding a duplicate, so you never need to save the same thing twice.
2. If the new note contradicts an older one (a changed decision, a corrected date or number), put the older note's id in "replaces". The old note is kept but dims.
3. Choose "project" exactly as named by list_projects. If you are not sure which project the note belongs to, leave "project" out and it goes to Unsorted. Never invent a project name.
4. Write one self-contained statement of one to three sentences that still makes sense months later on its own: name the thing instead of writing "it" or "this". Put separate points in separate notes.
5. Set "uncertain": true when you are not sure the user really decided or meant it. The note then waits on the user's Review page instead of saving straight away.
6. "status" is "decided" when the user said or confirmed it, and "proposed" when you suggested it and the user went along without clearly confirming.`;

const SEARCH_DESCRIPTION = `Search the user's Trellis notes by meaning. Use it before save_note to check whether the note already exists or contradicts an older note, and whenever earlier project decisions, facts, tasks or questions would help answer the user. Results include notes still waiting on the Review page. A note with "replaced_by" is outdated: the notes listed there are the current version.`;

const LIST_PROJECTS_DESCRIPTION = `List the user's Trellis projects. Use the exact names when saving a note. Notes that fit no project, or when you are unsure, go to "${UNSORTED}" by leaving the project out.`;

const UPDATE_DESCRIPTION = `Edit a saved Trellis note or change its status. Use it when the user confirms a proposed note (set status to "decided"), corrects a note's wording, moves it to another project, or pins it as important. To record a decision that changed, prefer save_note with "replaces" so the old version stays visible.`;

function owner(authInfo: AuthInfo | undefined): TokenOwner {
  const extra = authInfo?.extra as Partial<TokenOwner> | undefined;
  if (!extra?.userId) throw new AppError(401, 'Not signed in');
  return { userId: extra.userId, sourceName: extra.sourceName ?? 'AI app' };
}

function atomSummary(a: Atom) {
  return {
    id: a.id,
    text: a.text,
    type: a.type,
    status: a.status,
    project: a.projectName,
    waiting_for_review: a.reviewState === 'pending',
    replaced_by: a.replacedBy.length ? a.replacedBy : undefined,
    pinned: a.pinned,
    weight: Math.round(a.weight * 100) / 100,
    updated_at: a.updatedAt,
  };
}

function ok(summary: string, data: unknown) {
  return { content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function fail(err: unknown) {
  const message = err instanceof AppError ? err.message : 'Something went wrong in Trellis. Please try again.';
  if (!(err instanceof AppError)) console.error('[mcp] tool error:', err);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

export function createMcpServer(notes: NotesService): McpServer {
  const server = new McpServer({ name: 'trellis', title: 'Trellis', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'save_note',
    {
      title: 'Save note',
      description: SAVE_DESCRIPTION,
      inputSchema: {
        text: z.string().min(1).max(1000).describe('The note: one self-contained statement of one to three sentences.'),
        type: z.enum(ATOM_TYPES).describe('decision, fact, task, idea, or question.'),
        status: z.enum(ATOM_STATUSES).describe('"decided" if the user said or confirmed it; "proposed" if you suggested it.'),
        project: z.string().max(80).optional().describe('Exact project name from list_projects. Leave out when unsure (goes to Unsorted).'),
        uncertain: z.boolean().optional().describe('True sends the note to the Review page for the user to approve first.'),
        importance: z.number().min(0).max(1).optional().describe('How central this is to the project, 0 to 1. 0.5 is typical; 0.8 or more for core decisions.'),
        replaces: z.array(z.string().uuid()).max(10).optional().describe('Ids of older notes this one contradicts and replaces.'),
        chat: z.string().max(200).optional().describe('A short title for this conversation, so the user can see where the note came from.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      try {
        const who = owner(extra.authInfo);
        const result = await notes.saveNote(who.userId, {
          text: args.text,
          type: args.type,
          status: args.status,
          project: args.project,
          uncertain: args.uncertain,
          importance: args.importance,
          replaces: args.replaces,
          sourceAi: who.sourceName,
          sourceChat: args.chat,
        });
        if (result.outcome === 'duplicate') {
          return ok(
            `Already saved: this matches an existing note (similarity ${result.similarity}), so its weight was raised instead of adding a duplicate.`,
            atomSummary(result.atom),
          );
        }
        const a = result.atom;
        const parts = [
          a.reviewState === 'pending'
            ? `Sent to the Review page; it saves once the user approves it.`
            : `Saved to ${a.projectName}.`,
        ];
        if (!result.projectMatched) parts.push(`There is no project named "${args.project}", so the note went to ${UNSORTED}.`);
        if (a.replaces.length) parts.push(`It replaces ${a.replaces.length} older note(s), which now dim.`);
        return ok(parts.join(' '), atomSummary(a));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().min(1).max(1000).describe('What to look for, in plain words.'),
        project: z.string().max(80).optional().describe('Only search this project ("Unsorted" for notes without one).'),
        limit: z.number().int().min(1).max(25).optional().describe('How many results to return (default 8).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      try {
        const who = owner(extra.authInfo);
        const results = await notes.search(who.userId, args.query, { project: args.project, limit: args.limit ?? 8 });
        const data = results.map((r) => ({ ...atomSummary(r.atom), similarity: r.similarity }));
        return ok(results.length ? `Found ${results.length} note(s), most similar first.` : 'No notes found.', data);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: LIST_PROJECTS_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      try {
        const who = owner(extra.authInfo);
        const [projects, unsorted] = await Promise.all([notes.listProjects(who.userId), notes.unsortedCount(who.userId)]);
        const data = [
          ...projects.map((p) => ({ name: p.name, notes: p.atomCount })),
          { name: UNSORTED, notes: unsorted },
        ];
        return ok(
          projects.length
            ? `${projects.length} project(s). Use these exact names.`
            : `The user has no projects yet, so save notes without a project (they go to ${UNSORTED}).`,
          data,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update note',
      description: UPDATE_DESCRIPTION,
      inputSchema: {
        id: z.string().uuid().describe('The note id, from search_notes or save_note.'),
        text: z.string().min(1).max(1000).optional().describe('New wording for the note.'),
        type: z.enum(ATOM_TYPES).optional(),
        status: z.enum(ATOM_STATUSES).optional().describe('Set to "decided" when the user confirms a proposed note.'),
        project: z.string().max(80).optional().describe('Exact project name from list_projects, or "Unsorted".'),
        pinned: z.boolean().optional().describe('Pinned notes show at full size.'),
        importance: z.number().min(0).max(1).optional(),
        replaces: z.array(z.string().uuid()).max(10).optional().describe('Ids of older notes this one replaces.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      try {
        const who = owner(extra.authInfo);
        const { id, ...patch } = args;
        const atom = await notes.updateNote(who.userId, id, patch);
        return ok('Note updated.', atomSummary(atom));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

/**
 * Stateless Streamable HTTP: every POST gets a fresh server and transport, so
 * any app instance can answer any request and nothing is kept in memory.
 */
export function mcpHandler(notes: NotesService) {
  return async (req: Request, res: Response) => {
    const server = createMcpServer(notes);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
}
