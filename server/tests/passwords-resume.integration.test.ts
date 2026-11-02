import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema/core";
import { createSignInResumer } from "../src/passwords/resume";
import type { SignInRequestRecord } from "../src/passwords/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An unattended turn that waited on a sign-in is continued once the person answers, and its reply is
 * delivered where the conversation is delivered: a turn that started in Slack or SMS, whose sign-in
 * link reached the person there, has to answer them there too, the way an approved action's
 * continued turn does.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `sign-in-resume-${randomUUID()}`;
const owner = `${prefix}-owner`;
const channelId = `${prefix}-channel`;
const threadId = `${prefix}-thread`;

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(channels).values({
    id: channelId,
    name: "Sign-in resume",
    description: "A conversation delivered to Slack.",
  });
  await database
    .insert(intelligenceChannelMappings)
    .values({ userId: owner, channelId, threadId });
});

afterAll(async () => {
  await database.delete(channels).where(eq(channels.id, channelId));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

function signedIn(): SignInRequestRecord {
  const id = randomUUID();
  return {
    id,
    ownerUserId: owner,
    botId: "bot",
    origin: "https://example.com",
    reason: null,
    status: "signed_in",
    method: "typed",
    outcome: "Signed in to https://example.com.",
    threadId,
    toolCallId: "sign-in-call",
    controlRequestId: null,
    continuation: {
      runId: `${prefix}-run`,
      threadId,
      toolCallId: "sign-in-call",
      toolName: "computer_request_sign_in",
      args: { site: "https://example.com" },
      messages: [],
      state: {},
      context: [],
      forwardedProps: {},
    },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    resolvedAt: new Date(),
    fillingUntil: null,
  };
}

test("a turn continued after a sign-in delivers its reply to the conversation's channels", async () => {
  const recorded: { channelId: string; text: string; messageId: string }[] = [];
  const delivered: {
    scope: Record<string, unknown>;
    input: { id: string; text: string; kind: string };
  }[] = [];
  const request = signedIn();

  await createSignInResumer({
    database,
    resumeResponsibility: async () => {
      throw new Error("no responsibility run is waiting on this sign-in");
    },
    continueTurn: async () => ({
      replyText: "I am in, and here is the report.",
    }),
    recordReply: async (input) => {
      recorded.push(input);
    },
    notify: async (scope, input) => {
      delivered.push({ scope: { ...scope }, input });
    },
  })(request);

  const messageId = `sign-in-result:${request.id}:sign-in-call`;
  expect(recorded).toEqual([
    expect.objectContaining({
      channelId,
      text: "I am in, and here is the report.",
      messageId,
    }),
  ]);
  expect(delivered).toEqual([
    {
      scope: { ownerUserId: owner, channelId, agentId: "bot", threadId },
      input: {
        id: messageId,
        text: "I am in, and here is the report.",
        kind: "reply",
      },
    },
  ]);
});
