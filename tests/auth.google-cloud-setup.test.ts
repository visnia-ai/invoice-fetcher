import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GOOGLE_MAIL_SCOPE,
  GoogleCloudOAuthSetup,
  GoogleCloudSetupError,
  GoogleCloudSetupStateStore,
  type GcloudCommandOptions,
  type GcloudCommandResult,
} from "../src/auth/index.js";

const EMAIL = "me@gmail.com";
const PROJECT_ID = "invoice-fetcher-260826";
const PROJECT_NUMBER = "123456789";
const CLIENT_ID = `${PROJECT_NUMBER}-desktop.apps.googleusercontent.com`;

test("automatic Google setup creates and remembers a dedicated project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-setup-"));
  const statePath = path.join(directory, "nested", "state.json");
  const stateStore = new GoogleCloudSetupStateStore(statePath);
  const calls: Array<{ args: readonly string[]; options?: GcloudCommandOptions }> = [];
  let projectExists = false;
  const runner = async (
    args: readonly string[],
    options?: GcloudCommandOptions,
  ): Promise<GcloudCommandResult> => {
    calls.push({ args, ...(options === undefined ? {} : { options }) });
    if (args[0] === "version") return success("{}");
    if (args[0] === "auth" && args[1] === "list") return success(`${EMAIL}\n`);
    if (args[0] === "projects" && args[1] === "describe") {
      return projectExists ? success(`${PROJECT_NUMBER}\n`) : failure("NOT_FOUND");
    }
    if (args[0] === "projects" && args[1] === "create") {
      projectExists = true;
      return success();
    }
    if (args[0] === "services") return success();
    if (args[0] === "auth" && args[1] === "print-access-token") {
      return success("short-lived-cloud-token\n");
    }
    return failure("unexpected command");
  };
  const opened: string[] = [];
  const statuses: string[] = [];
  let clientIdAttempts = 0;
  const setup = new GoogleCloudOAuthSetup(
    {
      async input(label) {
        if (label !== "OAuth client ID") return "";
        clientIdAttempts += 1;
        return clientIdAttempts === 1
          ? "999-wrong.apps.googleusercontent.com"
          : CLIENT_ID;
      },
      async secret() {
        return "GOCSPX-client-secret";
      },
    },
    {
      commandRunner: runner,
      stateStore,
      browserOpener: async (url) => {
        opened.push(url);
      },
      fetch: async () =>
        new Response(JSON.stringify({ brands: [{ name: "brand" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      isInteractive: () => true,
      writeStatus: (message) => statuses.push(message),
    },
  );

  const client = await setup.provision("ME@GMAIL.COM");

  assert.equal(client.clientId, CLIENT_ID);
  assert.equal(client.clientSecret, "GOCSPX-client-secret");
  assert.equal(await stateStore.get(EMAIL), PROJECT_ID);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.ok(calls.some(({ args }) => args[0] === "projects" && args[1] === "create"));
  assert.ok(calls.some(({ args }) => args.includes("gmail.googleapis.com")));
  assert.equal(calls.some(({ args }) => args.includes("config")), false);
  assert.equal(clientIdAttempts, 2);
  assert.deepEqual(opened.map((url) => new URL(url).pathname), [
    "/auth/audience",
    "/auth/scopes",
    "/auth/clients",
  ]);
  assert.ok(opened.every((url) => new URL(url).searchParams.get("authuser") === EMAIL));
  assert.ok(
    opened.every(
      (url) => new URL(url).searchParams.get("project") === PROJECT_ID,
    ),
  );
  assert.doesNotMatch(statuses.join("\n"), /short-lived-cloud-token|GOCSPX/u);
  assert.match(statuses.join("\n"), /does not belong/u);
});

test("setup resumes a saved project and signs in without activating the account", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-resume-"));
  const stateStore = new GoogleCloudSetupStateStore(path.join(directory, "state.json"));
  await stateStore.put(EMAIL, PROJECT_ID);
  let authenticated = false;
  const calls: string[][] = [];
  const runner = async (args: readonly string[]): Promise<GcloudCommandResult> => {
    calls.push([...args]);
    if (args[0] === "version") return success();
    if (args[0] === "auth" && args[1] === "list") {
      return success(authenticated ? `${EMAIL}\n` : "");
    }
    if (args[0] === "auth" && args[1] === "login") {
      authenticated = true;
      return success();
    }
    if (args[0] === "projects" && args[1] === "describe") {
      return success(`${PROJECT_NUMBER}\n`);
    }
    if (args[0] === "services") return success();
    if (args[0] === "auth" && args[1] === "print-access-token") return failure();
    return failure("unexpected command");
  };
  const opened: string[] = [];
  const setup = new GoogleCloudOAuthSetup(
    {
      async input(label) {
        return label === "OAuth client ID" ? CLIENT_ID : "";
      },
      async secret() {
        return "client-secret";
      },
    },
    {
      commandRunner: runner,
      stateStore,
      browserOpener: async (url) => {
        opened.push(url);
      },
      isInteractive: () => true,
      writeStatus: () => undefined,
    },
  );

  await setup.provision(EMAIL);

  assert.ok(
    calls.some(
      (args) =>
        args[0] === "auth" &&
        args[1] === "login" &&
        args.includes("--force") &&
        args.includes("--no-activate"),
    ),
  );
  assert.equal(calls.some((args) => args[0] === "projects" && args[1] === "create"), false);
  assert.equal(opened.some((url) => url.includes("/auth/overview")), true);
});

test("setup force-reauthenticates once when saved gcloud credentials are stale", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-reauth-"));
  const stateStore = new GoogleCloudSetupStateStore(path.join(directory, "state.json"));
  await stateStore.put(EMAIL, PROJECT_ID);
  let authenticated = false;
  const calls: string[][] = [];
  const statuses: string[] = [];
  const runner = async (args: readonly string[]): Promise<GcloudCommandResult> => {
    calls.push([...args]);
    if (args[0] === "version") return success();
    if (args[0] === "auth" && args[1] === "list") return success(`${EMAIL}\n`);
    if (args[0] === "auth" && args[1] === "login") {
      authenticated = true;
      return success();
    }
    if (args[0] === "projects" && args[1] === "describe") {
      return authenticated
        ? success(`${PROJECT_NUMBER}\n`)
        : failure(
            "There was a problem refreshing your current auth tokens: invalid_grant: Bad Request",
          );
    }
    if (args[0] === "services") return success();
    if (args[0] === "auth" && args[1] === "print-access-token") return failure();
    return failure("unexpected command");
  };
  const setup = new GoogleCloudOAuthSetup(
    {
      async input(label) {
        return label === "OAuth client ID" ? CLIENT_ID : "";
      },
      async secret() {
        return "client-secret";
      },
    },
    {
      commandRunner: runner,
      stateStore,
      browserOpener: async () => undefined,
      isInteractive: () => true,
      writeStatus: (message) => statuses.push(message),
    },
  );

  await setup.provision(EMAIL);

  const login = calls.find((args) => args[0] === "auth" && args[1] === "login");
  assert.ok(login?.includes("--force"));
  assert.ok(login?.includes("--no-activate"));
  assert.equal(calls.filter((args) => args[0] === "auth" && args[1] === "login").length, 1);
  assert.equal(calls.some((args) => args[0] === "projects" && args[1] === "create"), false);
  assert.deepEqual(statuses.slice(0, 3), [
    "The saved Google Cloud login has expired. Reauthenticating...",
    `Signing in to gcloud as ${EMAIL}...`,
    "Please sign in to your Google account in the browser window that just opened.",
  ]);
});

test("setup creates a saved project when Google conceals whether it exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-concealed-"));
  const stateStore = new GoogleCloudSetupStateStore(path.join(directory, "state.json"));
  await stateStore.put(EMAIL, "invoice-fetcher-legacy00");
  let created = false;
  const calls: string[][] = [];
  const opened: string[] = [];
  const statuses: string[] = [];
  const prompts: string[] = [];
  const runner = async (args: readonly string[]): Promise<GcloudCommandResult> => {
    calls.push([...args]);
    if (args[0] === "version") return success();
    if (args[0] === "auth" && args[1] === "list") return success(`${EMAIL}\n`);
    if (args[0] === "projects" && args[1] === "describe") {
      if (args.includes("--format=value(parent.type)")) return success("organization\n");
      return created
        ? success(`${PROJECT_NUMBER}\n`)
        : failure(
            `[${EMAIL}] does not have permission to access projects instance [${PROJECT_ID}] (or it may not exist): The caller does not have permission.`,
          );
    }
    if (args[0] === "projects" && args[1] === "create") {
      created = true;
      return success();
    }
    if (args[0] === "services") return success();
    if (args[0] === "auth" && args[1] === "print-access-token") return failure();
    return failure("unexpected command");
  };
  const setup = new GoogleCloudOAuthSetup(
    {
      async input(label) {
        prompts.push(label);
        return label === "OAuth client ID" ? CLIENT_ID : "";
      },
      async secret() {
        return "client-secret";
      },
    },
    {
      commandRunner: runner,
      stateStore,
      browserOpener: async (url) => {
        opened.push(url);
      },
      isInteractive: () => true,
      writeStatus: (message) => statuses.push(message),
    },
  );

  await setup.provision(EMAIL);

  assert.equal(created, true);
  assert.equal(await stateStore.get(EMAIL), PROJECT_ID);
  assert.ok(
    calls.some(
      (args) => args[0] === "projects" && args[1] === "create" && args[2] === PROJECT_ID,
    ),
  );
  assert.deepEqual(opened.map((url) => new URL(url).pathname), [
    "/auth/overview",
    "/auth/scopes",
    "/auth/clients",
  ]);
  assert.ok(opened.every((url) => new URL(url).searchParams.get("authuser") === EMAIL));
  const guidance = statuses.join("\n");
  assert.match(guidance, /ACTION REQUIRED/u);
  assert.match(guidance, /confirm the account in the top-right corner is me@gmail\.com/u);
  assert.match(guidance, /Click “Get Started”\./u);
  assert.match(guidance, /1\. App information/u);
  assert.match(guidance, /App name: Invoice Fetcher/u);
  assert.match(guidance, /User support email: me@gmail\.com/u);
  assert.match(guidance, /2\. Audience\n   Select “Internal”\./u);
  assert.match(guidance, /3\. Contact information/u);
  assert.match(guidance, /4\. User data policy/u);
  assert.match(guidance, /Click “Continue”\.\n   Click “Create”\./u);
  assert.match(guidance, /Do not continue until all four browser steps are complete\./u);
  assert.match(guidance, /Click “Add or Remove Scopes”\./u);
  assert.ok(
    guidance.includes(
      `Click “Enter property name or value” and enter “${GOOGLE_MAIL_SCOPE}”`,
    ),
  );
  assert.match(guidance, /Select the Gmail API item\./u);
  assert.match(guidance, /Click “Update” at the bottom of the side panel\./u);
  assert.match(guidance, /Click “Save” at the bottom of the main page\./u);
  assert.match(guidance, /Under Application type, select “Desktop app”\./u);
  assert.match(guidance, /Keep the resulting client ID and client secret available/u);
  assert.doesNotMatch(guidance, /^Google Auth Platform setup$/mu);
  assert.ok(prompts.includes("When finished, return to this terminal and press Enter"));
  assert.ok(prompts.includes("When the Gmail scope is saved, return here and press Enter"));
  assert.ok(prompts.includes("When the Desktop client is created, return here and press Enter"));
});

test("setup reports when the fixed project ID is already owned", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-owned-"));
  const stateStore = new GoogleCloudSetupStateStore(path.join(directory, "state.json"));
  await stateStore.put(EMAIL, "invoice-fetcher-legacy00");
  const runner = async (args: readonly string[]): Promise<GcloudCommandResult> => {
    if (args[0] === "version") return success();
    if (args[0] === "auth" && args[1] === "list") return success(`${EMAIL}\n`);
    if (args[0] === "projects" && args[1] === "describe") {
      return failure("NOT_FOUND");
    }
    if (args[0] === "projects" && args[1] === "create") {
      return failure("Project ID is already in use");
    }
    return failure("unexpected command");
  };
  const setup = new GoogleCloudOAuthSetup(
    { async input() { return ""; }, async secret() { return ""; } },
    {
      commandRunner: runner,
      stateStore,
      isInteractive: () => true,
      writeStatus: () => undefined,
    },
  );

  await assert.rejects(
    setup.provision(EMAIL),
    (error: unknown) =>
      error instanceof GoogleCloudSetupError &&
      error.message.includes(`${PROJECT_ID} is already in use`),
  );
  assert.equal(await stateStore.get(EMAIL), PROJECT_ID);
});

test("automatic setup requires an interactive terminal and reports runner preparation failures", async () => {
  const prompt = { async input() { return ""; }, async secret() { return ""; } };
  const nonInteractive = new GoogleCloudOAuthSetup(prompt, {
    isInteractive: () => false,
  });
  await assert.rejects(
    nonInteractive.provision(EMAIL),
    (error: unknown) =>
      error instanceof GoogleCloudSetupError && error.message.includes("--oauth-client"),
  );

  const missing = new GoogleCloudOAuthSetup(prompt, {
    isInteractive: () => true,
    commandRunner: async () => {
      throw Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" });
    },
  });
  await assert.rejects(
    missing.provision(EMAIL),
    (error: unknown) =>
      error instanceof GoogleCloudSetupError &&
      error.message.includes("could not be prepared") &&
      !error.message.includes("gcloud CLI is required"),
  );
});

test("setup reports Cloud Terms failures without discarding resumable state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-terms-"));
  const stateStore = new GoogleCloudSetupStateStore(path.join(directory, "state.json"));
  const runner = async (args: readonly string[]): Promise<GcloudCommandResult> => {
    if (args[0] === "version") return success();
    if (args[0] === "auth" && args[1] === "list") return success(`${EMAIL}\n`);
    if (args[0] === "projects" && args[1] === "describe") return failure("NOT_FOUND");
    if (args[0] === "projects" && args[1] === "create") {
      return failure("FAILED_PRECONDITION: Terms of Service have not been accepted");
    }
    return failure();
  };
  const setup = new GoogleCloudOAuthSetup(
    { async input() { return ""; }, async secret() { return ""; } },
    {
      commandRunner: runner,
      stateStore,
      isInteractive: () => true,
      writeStatus: () => undefined,
    },
  );

  await assert.rejects(
    setup.provision(EMAIL),
    (error: unknown) =>
      error instanceof GoogleCloudSetupError && error.message.includes("console.cloud.google.com/terms"),
  );
  assert.equal(await stateStore.get(EMAIL), PROJECT_ID);
});

test("setup reports project quota and API policy failures clearly", async () => {
  const cases = [
    {
      name: "quota",
      describe: failure("NOT_FOUND"),
      create: failure("Project creation quota limit reached"),
      services: success(),
      expected: /quota or limit/u,
    },
    {
      name: "policy",
      describe: success(`${PROJECT_NUMBER}\n`),
      create: success(),
      services: failure("PERMISSION_DENIED by organization policy"),
      expected: /permissions or organization policy/u,
    },
    {
      name: "create-policy",
      describe: failure(
        `[${EMAIL}] does not have permission to access the project (or it may not exist)`,
      ),
      create: failure("PERMISSION_DENIED by organization policy"),
      services: success(),
      expected: /permissions or organization policy/u,
    },
  ] as const;

  for (const fixture of cases) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `invoice-fetcher-google-${fixture.name}-`),
    );
    const runner = async (args: readonly string[]): Promise<GcloudCommandResult> => {
      if (args[0] === "version") return success();
      if (args[0] === "auth" && args[1] === "list") return success(`${EMAIL}\n`);
      if (args[0] === "projects" && args[1] === "describe") return fixture.describe;
      if (args[0] === "projects" && args[1] === "create") return fixture.create;
      if (args[0] === "services") return fixture.services;
      return failure();
    };
    const setup = new GoogleCloudOAuthSetup(
      { async input() { return ""; }, async secret() { return ""; } },
      {
        commandRunner: runner,
        stateStore: new GoogleCloudSetupStateStore(path.join(directory, "state.json")),
        isInteractive: () => true,
        writeStatus: () => undefined,
      },
    );
    await assert.rejects(
      setup.provision(EMAIL),
      (error: unknown) =>
        error instanceof GoogleCloudSetupError && fixture.expected.test(error.message),
    );
  }
});

test("setup-state store keeps separate normalized account mappings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-google-state-"));
  const store = new GoogleCloudSetupStateStore(path.join(directory, "state.json"));
  await store.put("ONE@GMAIL.COM", "invoice-fetcher-1111111111");
  await store.put("two@gmail.com", "invoice-fetcher-2222222222");
  assert.equal(await store.get("one@gmail.com"), "invoice-fetcher-1111111111");
  assert.equal(await store.get("TWO@GMAIL.COM"), "invoice-fetcher-2222222222");
});

function success(stdout = ""): GcloudCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr = "failed"): GcloudCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}
