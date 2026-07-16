/**
 * Schedule tools — list, read, create and update schedule entries (calendar
 * events) in a project's Schedule. Fills the gap left by the upstream server,
 * which has no schedule support at all.
 *
 * Scoped to the CURRENTLY ACTIVE account (switch with basecamp_switch_account
 * first to target another account, e.g. Dami 4282357).
 *
 * API endpoints used (bc3-api):
 *   GET  /buckets/{project}/schedules/{schedule}/entries.json
 *   GET  /buckets/{project}/schedule_entries/{id}.json
 *   POST /buckets/{project}/schedules/{schedule}/entries.json
 *   PUT  /buckets/{project}/schedule_entries/{id}.json
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBearerToken } from "../utils/auth.js";
import { readCredentials } from "../utils/credentials.js";
import { handleBasecampError } from "../utils/errorHandlers.js";

type FetchFn = (...a: any[]) => Promise<any>;

function getFetch(): FetchFn {
  const fetchFn = (globalThis as { fetch?: FetchFn }).fetch;
  if (!fetchFn) {
    throw new Error("global fetch not available — needs Node >= 18.");
  }
  return fetchFn;
}

async function bcRequest(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; statusText: string; text: string }> {
  const creds = await readCredentials();
  if (!creds) {
    throw new Error("Not logged in. Use basecamp_login to authenticate.");
  }
  const token = await getBearerToken();
  const fetchFn = getFetch();
  const url = `https://3.basecampapi.com/${creds.accountId}/${path}`;
  const res = await fetchFn(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "basecamp-mcp (schedules)",
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, statusText: res.statusText, text };
}

/** Resolve the schedule id of a project via its dock. */
async function resolveScheduleId(projectId: string): Promise<string> {
  const res = await bcRequest("GET", `projects/${projectId}.json`);
  if (res.status !== 200) {
    throw new Error(
      `Could not load project ${projectId}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const project = JSON.parse(res.text) as {
    dock?: Array<{ id: number; name: string; enabled: boolean }>;
  };
  const schedule = project.dock?.find((d) => d.name === "schedule");
  if (!schedule) {
    throw new Error(`Project ${projectId} has no schedule in its dock.`);
  }
  if (!schedule.enabled) {
    throw new Error(
      `The schedule of project ${projectId} exists but is disabled.`,
    );
  }
  return String(schedule.id);
}

function summarizeEntry(e: any): object {
  return {
    id: e.id,
    summary: e.summary,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    all_day: e.all_day,
    description: e.description || undefined,
    participants: Array.isArray(e.participants)
      ? e.participants.map((p: any) => ({ id: p.id, name: p.name }))
      : undefined,
    creator: e.creator ? { id: e.creator.id, name: e.creator.name } : undefined,
    app_url: e.app_url,
    status: e.status,
  };
}

const MAX = 60000;
function clip(text: string): string {
  return text.length > MAX
    ? text.slice(0, MAX) + `\n…[truncated ${text.length - MAX} chars]`
    : text;
}

export function registerScheduleTools(server: McpServer): void {
  // basecamp_list_schedule_entries
  server.registerTool(
    "basecamp_list_schedule_entries",
    {
      title: "List schedule entries (calendar events) of a project",
      description: `List the schedule entries (calendar events) of a project's Schedule in the ACTIVE account. Returns entries with id, summary, dates, all_day flag, participants and app_url.

If schedule_id is omitted it is resolved automatically from the project dock. Results are paginated by the API (15 per page) — use the page parameter for more.`,
      inputSchema: {
        project_id: z.string().describe("Project (bucket) id"),
        schedule_id: z
          .string()
          .optional()
          .describe("Schedule id; auto-resolved from the project if omitted"),
        page: z.number().optional().describe("Page number (default 1)"),
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
        const scheduleId =
          params.schedule_id ?? (await resolveScheduleId(params.project_id));
        const page = params.page && params.page > 1 ? `?page=${params.page}` : "";
        const res = await bcRequest(
          "GET",
          `buckets/${params.project_id}/schedules/${scheduleId}/entries.json${page}`,
        );
        if (res.status !== 200) {
          return {
            content: [
              {
                type: "text",
                text: `HTTP ${res.status} ${res.statusText}\n${clip(res.text)}`,
              },
            ],
          };
        }
        const entries = (JSON.parse(res.text) as any[]).map(summarizeEntry);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { schedule_id: scheduleId, count: entries.length, entries },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleBasecampError(error) }],
        };
      }
    },
  );

  // basecamp_get_schedule_entry
  server.registerTool(
    "basecamp_get_schedule_entry",
    {
      title: "Get a single schedule entry",
      description:
        "Get one schedule entry (calendar event) by id from a project in the ACTIVE account.",
      inputSchema: {
        project_id: z.string().describe("Project (bucket) id"),
        entry_id: z.string().describe("Schedule entry id"),
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
        const res = await bcRequest(
          "GET",
          `buckets/${params.project_id}/schedule_entries/${params.entry_id}.json`,
        );
        if (res.status !== 200) {
          return {
            content: [
              {
                type: "text",
                text: `HTTP ${res.status} ${res.statusText}\n${clip(res.text)}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summarizeEntry(JSON.parse(res.text)), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleBasecampError(error) }],
        };
      }
    },
  );

  // basecamp_create_schedule_entry
  server.registerTool(
    "basecamp_create_schedule_entry",
    {
      title: "Create a schedule entry (calendar event)",
      description: `Create a schedule entry (calendar event) in a project's Schedule in the ACTIVE account.

For ALL-DAY events (e.g. vacations): set all_day=true and pass plain dates, e.g. starts_at "2026-09-14", ends_at "2026-09-27" (ends_at is INCLUSIVE — the last day of the vacation).
For timed events: pass full ISO timestamps, e.g. "2026-09-14T09:00:00+02:00".

If schedule_id is omitted it is resolved automatically from the project dock. notify defaults to false (participants are not pinged).`,
      inputSchema: {
        project_id: z.string().describe("Project (bucket) id"),
        schedule_id: z
          .string()
          .optional()
          .describe("Schedule id; auto-resolved from the project if omitted"),
        summary: z.string().describe('Event title, e.g. "Urlaub Marc"'),
        starts_at: z
          .string()
          .describe(
            'Start — plain date "YYYY-MM-DD" for all-day, else ISO timestamp',
          ),
        ends_at: z
          .string()
          .describe(
            'End (inclusive) — plain date "YYYY-MM-DD" for all-day, else ISO timestamp',
          ),
        all_day: z.boolean().optional().describe("All-day event (default false)"),
        description: z
          .string()
          .optional()
          .describe("Optional description (rich text/HTML allowed)"),
        participant_ids: z
          .array(z.number())
          .optional()
          .describe("Optional people ids to put on the event"),
        notify: z
          .boolean()
          .optional()
          .describe("Notify participants (default false)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const scheduleId =
          params.schedule_id ?? (await resolveScheduleId(params.project_id));
        const payload: Record<string, unknown> = {
          summary: params.summary,
          starts_at: params.starts_at,
          ends_at: params.ends_at,
        };
        if (params.all_day !== undefined) payload.all_day = params.all_day;
        if (params.description) payload.description = params.description;
        if (params.participant_ids?.length)
          payload.participant_ids = params.participant_ids;
        payload.notify = params.notify ?? false;

        const res = await bcRequest(
          "POST",
          `buckets/${params.project_id}/schedules/${scheduleId}/entries.json`,
          payload,
        );
        if (res.status !== 201) {
          return {
            content: [
              {
                type: "text",
                text: `Create failed: HTTP ${res.status} ${res.statusText}\n${clip(res.text)}`,
              },
            ],
          };
        }
        const entry = summarizeEntry(JSON.parse(res.text));
        return {
          content: [
            {
              type: "text",
              text: `Created schedule entry.\n${JSON.stringify(entry, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleBasecampError(error) }],
        };
      }
    },
  );

  // basecamp_update_schedule_entry
  server.registerTool(
    "basecamp_update_schedule_entry",
    {
      title: "Update a schedule entry (calendar event)",
      description: `Update an existing schedule entry in the ACTIVE account. Only the fields you pass are changed — omitted fields keep their current value (the tool re-reads the entry first, because the API requires the full payload).

Dates: plain "YYYY-MM-DD" for all-day events (ends_at inclusive), full ISO timestamps otherwise.`,
      inputSchema: {
        project_id: z.string().describe("Project (bucket) id"),
        entry_id: z.string().describe("Schedule entry id"),
        summary: z.string().optional().describe("New title"),
        starts_at: z.string().optional().describe("New start"),
        ends_at: z.string().optional().describe("New end (inclusive)"),
        all_day: z.boolean().optional().describe("All-day flag"),
        description: z.string().optional().describe("New description"),
        participant_ids: z
          .array(z.number())
          .optional()
          .describe("Replace participants with these people ids"),
        notify: z
          .boolean()
          .optional()
          .describe("Notify participants (default false)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const getRes = await bcRequest(
          "GET",
          `buckets/${params.project_id}/schedule_entries/${params.entry_id}.json`,
        );
        if (getRes.status !== 200) {
          return {
            content: [
              {
                type: "text",
                text: `Could not read entry: HTTP ${getRes.status} ${getRes.statusText}\n${clip(getRes.text)}`,
              },
            ],
          };
        }
        const current = JSON.parse(getRes.text) as any;
        const payload: Record<string, unknown> = {
          summary: params.summary ?? current.summary,
          starts_at: params.starts_at ?? current.starts_at,
          ends_at: params.ends_at ?? current.ends_at,
          all_day: params.all_day ?? current.all_day,
          description: params.description ?? current.description ?? "",
          notify: params.notify ?? false,
        };
        if (params.participant_ids) {
          payload.participant_ids = params.participant_ids;
        } else if (Array.isArray(current.participants)) {
          payload.participant_ids = current.participants.map((p: any) => p.id);
        }

        const res = await bcRequest(
          "PUT",
          `buckets/${params.project_id}/schedule_entries/${params.entry_id}.json`,
          payload,
        );
        if (res.status !== 200) {
          return {
            content: [
              {
                type: "text",
                text: `Update failed: HTTP ${res.status} ${res.statusText}\n${clip(res.text)}`,
              },
            ],
          };
        }
        const entry = summarizeEntry(JSON.parse(res.text));
        return {
          content: [
            {
              type: "text",
              text: `Updated schedule entry.\n${JSON.stringify(entry, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleBasecampError(error) }],
        };
      }
    },
  );
}
