import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionHandlers,
  downloadAgentSessionAtif,
  downloadAgentSessionFile,
  readAgentMessageHistory,
  readAgentSessionSummary,
} from "./agent-sessions";
import type { AgentSessionFileAccess } from "./session-file-access";
import type { HerdrCall } from "./session-types";

const tempDirectories: string[] = [];
const remotePiSessionPath = "/srv/herdr-gui-test/sessions/pi-session.jsonl";

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function createPiSession() {
  const directory = await mkdtemp(join(tmpdir(), "herdr-gui-pi-session-"));
  tempDirectories.push(directory);
  const path = join(directory, "2026-07-24_pi-session.jsonl");
  const records = [
    {
      type: "session",
      version: 3,
      id: "pi-session",
      timestamp: "2026-07-24T00:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-07-24T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "first message" }],
      },
    },
    {
      type: "message",
      id: "assistant-1",
      timestamp: "2026-07-24T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "response" }],
        usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
      },
    },
    {
      type: "message",
      id: "user-2",
      timestamp: "2026-07-24T00:00:03.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "second message" }],
      },
    },
    {
      type: "message",
      id: "assistant-2",
      timestamp: "2026-07-24T00:00:04.000Z",
      message: {
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "second response" }],
      },
    },
  ];
  await writeFile(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return path;
}

function remotePiFiles(text: string): AgentSessionFileAccess {
  const path = remotePiSessionPath;
  const bytes = Buffer.from(text);
  return {
    remote: true,
    async statFile() {
      return {
        path,
        mtimeMs: new Date("2026-07-24T00:00:03.000Z").getTime(),
        size: bytes.length,
      };
    },
    async readText() {
      return text;
    },
    async readPrefix(_path, byteLimit) {
      return bytes.subarray(0, byteLimit);
    },
    async readDownloadBody() {
      return bytes;
    },
    async findPiSessionById() {
      return null;
    },
  };
}

function piAgentCall(path: string): HerdrCall {
  return async (method) => {
    expect(method).toBe("agent.get");
    return {
      agent: {
        agent: "pi",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: "/tmp/project",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "path",
          value: path,
        },
      },
    };
  };
}

describe("Pi agent sessions", () => {
  test("reads user and assistant history from an integration-reported session", async () => {
    const path = await createPiSession();
    const history = await readAgentMessageHistory(
      { pane_id: "p1", agent: "pi" },
      piAgentCall(path),
    );

    expect(history.status).toBe("ok");
    expect(history.path).toBe(path);
    expect(history.messages).toMatchObject([
      {
        role: "user",
        text: "first message",
        sent_at: "2026-07-24T00:00:01.000Z",
      },
      {
        role: "assistant",
        text: "response",
        sent_at: "2026-07-24T00:00:02.000Z",
      },
      {
        role: "user",
        text: "second message",
        sent_at: "2026-07-24T00:00:03.000Z",
      },
      {
        role: "assistant",
        text: "second response",
        sent_at: "2026-07-24T00:00:04.000Z",
      },
    ]);
  });

  test("includes Pi statistics and ATIF in Session Inspect", async () => {
    const path = await createPiSession();
    const summary = await readAgentSessionSummary(
      {
        pane_id: "p1",
        agent: "pi",
        include_trajectory: true,
      },
      piAgentCall(path),
    );

    expect(summary.stats).toMatchObject({
      turns: 2,
      records: 5,
      token_usage: {
        input_tokens: 4,
        cached_input_tokens: 1,
        output_tokens: 2,
      },
    });
    expect(summary.trajectory).toMatchObject({
      session_id: "pi-session",
      agent: { name: "pi", model_name: "test-model" },
    });
  });

  test("shows the official integration command when Pi has no session", async () => {
    const result = await readAgentMessageHistory(
      { pane_id: "p1", agent: "pi" },
      async () => ({ agent: { agent: "pi" } }),
    );

    expect(result.status).toBe("missing_session");
    expect(result.command).toBe("herdr integration install pi");
  });

  test("binds Herdr and file access inside each runtime handler bundle", async () => {
    const record = (id: string, text: string) =>
      [
        {
          type: "session",
          version: 3,
          id,
          timestamp: "2026-07-24T00:00:00.000Z",
        },
        {
          type: "message",
          id: `${id}-user`,
          timestamp: "2026-07-24T00:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    const first = createAgentSessionHandlers({
      herdrCall: piAgentCall(remotePiSessionPath),
      files: remotePiFiles(`${record("first-session", "first runtime")}\n`),
    });
    const second = createAgentSessionHandlers({
      herdrCall: piAgentCall(remotePiSessionPath),
      files: remotePiFiles(`${record("second-session", "second runtime")}\n`),
    });

    const [firstHistory, secondHistory] = await Promise.all([
      first.readHistory({ pane_id: "p1", agent: "pi" }),
      second.readHistory({ pane_id: "p1", agent: "pi" }),
    ]);

    expect(firstHistory.messages[0]?.text).toBe("first runtime");
    expect(secondHistory.messages[0]?.text).toBe("second runtime");
  });

  test("reads and exports an SSH-reported Pi session", async () => {
    const text = [
      {
        type: "session",
        version: 3,
        id: "remote-pi-session",
        timestamp: "2026-07-24T00:00:00.000Z",
      },
      {
        type: "message",
        id: "user-remote",
        timestamp: "2026-07-24T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "remote message" }],
        },
      },
      {
        type: "message",
        id: "assistant-remote",
        timestamp: "2026-07-24T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "remote-model",
          content: [{ type: "text", text: "remote response" }],
          usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0 },
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const path = remotePiSessionPath;
    const files = remotePiFiles(`${text}\n`);
    const call = piAgentCall(path);

    const summary = await readAgentSessionSummary(
      {
        pane_id: "p1",
        agent: "pi",
        include_text: true,
        include_trajectory: true,
      },
      call,
      files,
    );
    expect(summary).toMatchObject({
      status: "ok",
      path,
      stats: { turns: 1, records: 3 },
      truncated: false,
      trajectory: {
        session_id: "remote-pi-session",
        agent: { name: "pi", model_name: "remote-model" },
      },
    });
    expect(summary.text).toContain("remote message");

    const raw = await downloadAgentSessionFile(
      { pane_id: "p1", agent: "pi" },
      call,
      files,
    );
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain("remote response");

    const atif = await downloadAgentSessionAtif(
      { pane_id: "p1", agent: "pi" },
      call,
      files,
    );
    expect(atif.status).toBe(200);
    expect(await atif.json()).toMatchObject({
      schema_version: "ATIF-v1.7",
      session_id: "remote-pi-session",
    });
  });
});
