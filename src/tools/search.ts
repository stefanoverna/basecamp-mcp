/**
 * Search tools for Basecamp MCP server
 *
 * Provides a simplified search interface across Basecamp content
 * using the recordings API with client-side title filtering.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asyncPagedIterator } from "basecamp-client";
import { z } from "zod";
import { CHARACTER_LIMIT, DEFAULT_LIMIT } from "../constants.js";
import { BasecampIdSchema } from "../schemas/common.js";
import { initializeBasecampClient } from "../utils/auth.js";
import { handleBasecampError } from "../utils/errorHandlers.js";

/** Default recording types to search across */
const SEARCH_TYPES = [
  "Todo",
  "Message",
  "Document",
  "Comment",
  "Upload",
  "Todolist",
  "Kanban::Card",
];

/** Map of friendly type aliases to canonical Basecamp API type names */
const TYPE_ALIASES: Record<string, string> = {
  todo: "Todo",
  todos: "Todo",
  message: "Message",
  messages: "Message",
  document: "Document",
  doc: "Document",
  docs: "Document",
  comment: "Comment",
  comments: "Comment",
  upload: "Upload",
  uploads: "Upload",
  file: "Upload",
  files: "Upload",
  todolist: "Todolist",
  card: "Kanban::Card",
  cards: "Kanban::Card",
  kanban: "Kanban::Card",
};

function resolveTypes(types: string[]): string[] {
  const resolved = new Set<string>();
  for (const t of types) {
    const lower = t.trim().toLowerCase();
    resolved.add(TYPE_ALIASES[lower] || t.trim());
  }
  return [...resolved];
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "basecamp_search",
    {
      title: "Search Basecamp",
      description: `Search across Basecamp projects for todos, messages, documents, and other content by title text.

Use this tool to:
- Find items by name or keyword across all projects
- Search within specific projects
- Filter results by content type

Examples:
  - "Find todos about deployment" → query: "deployment", type: ["todo"]
  - "Search for documents mentioning roadmap in project 123" → query: "roadmap", project_ids: [123], type: ["document"]
  - "Find anything related to API" → query: "API"`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Search text (case-insensitive, matches against item titles)",
          ),
        project_ids: z
          .array(BasecampIdSchema)
          .optional()
          .describe(
            "Filter to specific projects (bucket IDs). Omit to search across all projects.",
          ),
        type: z
          .array(z.string())
          .optional()
          .describe(
            'Filter by content type: "todo", "message", "document", "comment", "upload", "todolist", "card". ' +
              "Omit to search all types.",
          ),
        status: z
          .enum(["active", "archived", "trashed"])
          .optional()
          .describe(
            'Filter by status: "active" (default), "archived", or "trashed".',
          ),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe(
            `Maximum number of results to return (default: ${DEFAULT_LIMIT}, max: 100).`,
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const client = await initializeBasecampClient();
        const types = params.type ? resolveTypes(params.type) : SEARCH_TYPES;
        const limit = params.limit || DEFAULT_LIMIT;
        const lowerQuery = params.query.toLowerCase();

        const baseQuery: Record<string, string | undefined> = {};
        if (params.project_ids && params.project_ids.length > 0) {
          baseQuery.bucket = params.project_ids.join(",");
        }
        if (params.status) {
          baseQuery.status = params.status;
        }

        // Search each type in parallel
        const fetchPromises = types.map(async (type) => {
          const items: Awaited<
            ReturnType<typeof client.recordings.list>
          >["body"][number][] = [];

          for await (const item of asyncPagedIterator({
            fetchPage: client.recordings.list,
            request: {
              query: { type, ...baseQuery },
            },
          })) {
            if (item.title.toLowerCase().includes(lowerQuery)) {
              items.push(item);
            }
            // Stop early once we have enough matches across all types
            if (items.length >= limit) {
              break;
            }
          }
          return items;
        });

        const results = await Promise.all(fetchPromises);
        let matched = results.flat();

        // Sort by updated_at desc (most recently updated first)
        matched.sort((a, b) => {
          const dateA = new Date(a.updated_at).getTime();
          const dateB = new Date(b.updated_at).getTime();
          return dateB - dateA;
        });

        const total = matched.length;
        matched = matched.slice(0, limit);

        const serialized = matched.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          status: r.status,
          created_at: r.created_at,
          updated_at: r.updated_at,
          url: r.app_url,
          creator: r.creator
            ? {
                id: r.creator.id,
                name: r.creator.name,
                email: r.creator.email_address,
              }
            : null,
          project: r.bucket
            ? {
                id: r.bucket.id,
                name: r.bucket.name,
              }
            : null,
          ...(r.parent
            ? {
                parent: {
                  id: r.parent.id,
                  title: r.parent.title,
                  type: r.parent.type,
                },
              }
            : {}),
        }));

        const result: Record<string, unknown> = {
          query: params.query,
          results: serialized,
          total_matched: total,
          returned: serialized.length,
        };

        if (total > limit) {
          result.truncated = true;
          result.truncation_message = `Showing ${limit} of ${total} results. Increase limit or narrow filters to see more.`;
        }

        let jsonStr = JSON.stringify(result, null, 2);

        if (jsonStr.length > CHARACTER_LIMIT) {
          const reducedLimit = Math.floor(serialized.length / 2);
          const reduced = serialized.slice(0, reducedLimit);
          jsonStr = JSON.stringify(
            {
              query: params.query,
              results: reduced,
              total_matched: total,
              returned: reduced.length,
              truncated: true,
              truncation_message: `Response truncated to ${reduced.length} results due to size limits. Use more specific filters or a smaller limit.`,
            },
            null,
            2,
          );
        }

        return {
          content: [{ type: "text", text: jsonStr }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleBasecampError(error) }],
        };
      }
    },
  );
}
