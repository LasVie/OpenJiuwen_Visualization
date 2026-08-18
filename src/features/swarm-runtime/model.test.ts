import { describe, expect, it } from "vitest";
import type {
  RuntimeTraceEvent,
  RuntimeTraceEventInput,
  RuntimeTraceSession,
} from "../../kernel";
import { projectSwarmRuntimeTrace, swarmSubjectStatusAt } from "./model";

const trace: RuntimeTraceSession = {
  id: "tr_swarm",
  owner: "jiuwenswarm",
  label: "Swarm test",
  status: "open",
  createdAt: "2026-08-18T00:00:00Z",
  updatedAt: "2026-08-18T00:00:01Z",
  eventCount: 0,
  lastSequence: 0,
  maxTokens: 32000,
  byteCount: 0,
};

function event(
  sequence: number,
  input: RuntimeTraceEventInput,
): RuntimeTraceEvent {
  return {
    ...input,
    traceId: trace.id,
    sequence,
    receivedAt: `2026-08-18T00:00:${String(sequence).padStart(2, "0")}Z`,
  };
}

describe("Swarm runtime projection", () => {
  it("builds the real team, workflow, phase and agent hierarchy", () => {
    const events = [
      event(1, {
        eventId: "team-start",
        kind: "swarm.team",
        phase: "start",
        timestampMs: 1,
        spanId: "team",
        subject: { id: "team:alpha", kind: "team", label: "Alpha" },
      }),
      event(2, {
        eventId: "workflow-start",
        kind: "swarm.workflow",
        phase: "start",
        timestampMs: 2,
        spanId: "workflow",
        parentSpanId: "team",
        subject: {
          id: "workflow:review",
          kind: "workflow",
          label: "Review workflow",
          parentId: "team:alpha",
        },
      }),
      event(3, {
        eventId: "phase-start",
        kind: "swarm.phase",
        phase: "start",
        timestampMs: 3,
        spanId: "phase",
        parentSpanId: "workflow",
        subject: {
          id: "phase:inspect",
          kind: "phase",
          label: "Inspect",
          parentId: "workflow:review",
        },
      }),
      event(4, {
        eventId: "agent-start",
        kind: "swarm.agent",
        phase: "start",
        timestampMs: 4,
        spanId: "agent",
        parentSpanId: "phase",
        subject: {
          id: "agent:reviewer",
          kind: "agent",
          label: "Reviewer",
          parentId: "phase:inspect",
          contextOwnerId: "context:reviewer",
        },
      }),
      event(5, {
        eventId: "agent-end",
        kind: "swarm.agent",
        phase: "end",
        timestampMs: 5,
        spanId: "agent",
        subject: {
          id: "agent:reviewer",
          kind: "agent",
          label: "Reviewer",
          parentId: "phase:inspect",
          contextOwnerId: "context:reviewer",
        },
      }),
    ];

    const projection = projectSwarmRuntimeTrace(trace, events);

    expect(projection.subjects.map((subject) => subject.id)).toEqual([
      "team:alpha",
      "workflow:review",
      "phase:inspect",
      "agent:reviewer",
    ]);
    expect(projection.relations.map((relation) => relation.id)).toEqual([
      "hierarchy:team:alpha:workflow:review",
      "hierarchy:workflow:review:phase:inspect",
      "hierarchy:phase:inspect:agent:reviewer",
    ]);
    const agent = projection.subjects.at(-1)!;
    expect(agent.eventCount).toBe(2);
    expect(swarmSubjectStatusAt(agent, 3)).toBe("running");
    expect(swarmSubjectStatusAt(agent, 4)).toBe("completed");
    expect(projection.scenario.steps[3].activeNodeIds).toEqual(["agent:reviewer"]);
  });

  it("keeps member and subagent context windows completely separate", () => {
    const events = [
      event(1, {
        eventId: "member",
        kind: "swarm.member",
        phase: "start",
        timestampMs: 1,
        spanId: "member",
        subject: {
          id: "member:leader",
          kind: "member",
          label: "Leader",
          contextOwnerId: "ctx:leader",
        },
      }),
      event(2, {
        eventId: "leader-context",
        kind: "context.delta",
        phase: "instant",
        timestampMs: 2,
        spanId: "leader-context",
        subject: {
          id: "member:leader",
          kind: "member",
          label: "Leader",
          contextOwnerId: "ctx:leader",
        },
        context: {
          operation: "append",
          ownerId: "ctx:leader",
          messages: [{
            id: "leader-user",
            role: "user",
            label: "Leader input",
            raw: "leader-only secret",
            preview: "leader input",
            tokens: 12,
            source: "team.message",
          }],
        },
        token: { used: 12, delta: 12, budget: 1000 },
      }),
      event(3, {
        eventId: "subagent",
        kind: "swarm.subagent",
        phase: "start",
        timestampMs: 3,
        spanId: "subagent",
        parentSpanId: "member",
        subject: {
          id: "subagent:explore",
          kind: "subagent",
          label: "Explore",
          parentId: "member:leader",
          contextOwnerId: "ctx:explore",
        },
      }),
      event(4, {
        eventId: "subagent-context",
        kind: "context.snapshot",
        phase: "instant",
        timestampMs: 4,
        spanId: "subagent-context",
        subject: {
          id: "subagent:explore",
          kind: "subagent",
          label: "Explore",
          parentId: "member:leader",
          contextOwnerId: "ctx:explore",
        },
        context: {
          operation: "replace",
          ownerId: "ctx:explore",
          messages: [{
            id: "sub-system",
            role: "system",
            label: "Subagent system",
            raw: "subagent-only instructions",
            preview: "subagent instructions",
            tokens: 21,
            source: "subagent.session",
          }],
        },
        token: { used: 21, delta: 21, budget: 2000 },
      }),
    ];

    const leader = projectSwarmRuntimeTrace(trace, events, "ctx:leader");
    const subagent = projectSwarmRuntimeTrace(trace, events, "ctx:explore");

    expect(leader.contextScopes.map((scope) => scope.id)).toEqual([
      "ctx:leader",
      "ctx:explore",
    ]);
    expect(leader.scenario.messages.map((message) => message.raw)).toEqual([
      "leader-only secret",
    ]);
    expect(subagent.scenario.messages.map((message) => message.raw)).toEqual([
      "subagent-only instructions",
    ]);
    expect(leader.scenario.steps.at(-1)?.tokenUsed).toBe(12);
    expect(subagent.scenario.steps.at(-1)?.tokenUsed).toBe(21);
  });

  it("projects message and assignment relations without inventing tool activity", () => {
    const events = [
      event(1, {
        eventId: "leader",
        kind: "swarm.member",
        phase: "instant",
        timestampMs: 1,
        spanId: "leader",
        subject: { id: "member:leader", kind: "member", label: "Leader" },
      }),
      event(2, {
        eventId: "worker",
        kind: "swarm.member",
        phase: "instant",
        timestampMs: 2,
        spanId: "worker",
        subject: { id: "member:worker", kind: "member", label: "Worker" },
      }),
      event(3, {
        eventId: "message",
        kind: "swarm.message",
        phase: "instant",
        timestampMs: 3,
        spanId: "message",
        subject: { id: "member:leader", kind: "member", label: "Leader" },
        payload: {
          fromSubjectId: "member:leader",
          toSubjectId: "member:worker",
          protocol: "plain",
        },
      }),
      event(4, {
        eventId: "task",
        kind: "swarm.task",
        phase: "start",
        timestampMs: 4,
        spanId: "task",
        subject: {
          id: "task:inspect",
          kind: "task",
          label: "Inspect repository",
          parentId: "member:leader",
        },
        payload: { assigneeId: "member:worker", status: "in_progress" },
      }),
    ];

    const projection = projectSwarmRuntimeTrace(trace, events);

    expect(projection.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "message:member:leader:member:worker",
        kind: "message",
      }),
      expect.objectContaining({
        id: "assignment:member:worker:task:inspect",
        kind: "assignment",
      }),
    ]));
    expect(projection.subjects.every((subject) =>
      subject.revisions.every((revision) => revision.eventKind !== "tool.call"),
    )).toBe(true);
  });
});
