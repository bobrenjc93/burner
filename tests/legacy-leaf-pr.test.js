import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLegacyLeafPrProof, validateLegacyLeafPrProofInput } from "../dist/lib/legacy-leaf-pr.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const entries = [["started.json", "startedSha256"], ["result.json", "resultSha256"], ["after-state.json", "stateSha256"]];
const inputShape = () => ({ protocol: "executed-leaf-writer-v1", directory: join(tmpdir(), "legacy-proof-input"),
  startedSha256: "a".repeat(64), resultSha256: "b".repeat(64), stateSha256: "c".repeat(64) });

// These intentionally incomplete documents test the reader's outer boundary,
// never impersonate a completed writer, and are not positive adoption evidence.
// The actual accepted-writer path is verified with retained on-host artifacts.
async function withArchive(t, action) {
  const prefix = join(tmpdir(), "burner-legacy-leaf-pr-");
  const root = await mkdtemp(prefix);
  try {
    const directory = join(root, "archive");
    await mkdir(directory);
    const input = { ...inputShape(), directory };
    for (const [name, field] of entries) {
      await writeFile(join(directory, name), "{}", { flag: "wx" });
      input[field] = hash("{}");
    }
    const read = () => readLegacyLeafPrProof(input, {}, {});
    await action({ root, directory, input, read });
    assert.ok(root.startsWith(prefix));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    t.diagnostic(`Retained failed isolated legacy-reader fixture: ${root}`);
    throw error;
  }
}

test("legacy proof input validator accepts the exact shape without mutating it", () => {
  const input = Object.freeze(inputShape());
  assert.doesNotThrow(() => validateLegacyLeafPrProofInput(input));
  assert.deepEqual(input, inputShape());
});

test("legacy proof input validator rejects malformed, extra or noncanonical caller fields", () => {
  const cases = [undefined, null, [], {}, "proof", { ...inputShape(), protocol: "unknown" },
    { ...inputShape(), extra: true }, ...["relative", "/tmp/legacy/../proof", "/tmp//proof", "/tmp/proof/", 1]
      .map((directory) => ({ ...inputShape(), directory }))];
  for (const field of ["protocol", "directory", "startedSha256", "resultSha256", "stateSha256"]) {
    const value = inputShape(); delete value[field]; cases.push(value);
  }
  for (const field of ["startedSha256", "resultSha256", "stateSha256"]) {
    for (const value of [null, 1, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64)]) {
      cases.push({ ...inputShape(), [field]: value });
    }
  }
  for (const value of cases) {
    assert.throws(() => validateLegacyLeafPrProofInput(value), /Legacy PR writer proof refused: expected an exact absolute archive directory/);
  }
});

test("legacy proof reader refuses a symlinked archive directory", async (t) => withArchive(t, async ({ root, directory, input, read }) => {
  const link = join(root, "linked-archive");
  await symlink(directory, link, "dir");
  input.directory = link;
  await assert.rejects(read, /Legacy PR writer proof refused: archive directory identity changed/);
}));

for (const [name, field] of entries) {
  for (const kind of ["symlink", "directory", "oversized"]) {
    test(`legacy proof reader refuses ${kind} ${name} before decoding`, async (t) => withArchive(t, async ({ directory, read }) => {
      const file = join(directory, name), saved = join(directory, name + ".saved");
      await rename(file, saved);
      if (kind === "symlink") await symlink(saved, file);
      else if (kind === "directory") await mkdir(file);
      else {
        const handle = await open(file, "wx");
        try { await handle.truncate(64 * 1024 * 1024 + 1); }
        finally { await handle.close(); }
      }
      await assert.rejects(read, new RegExp(`Legacy PR writer proof refused: unknown retained file ${name.replaceAll(".", "\\.")}`));
    }));
  }

  test(`legacy proof reader refuses a mismatched ${name} hash`, async (t) => withArchive(t, async ({ input, read }) => {
    input[field] = "0".repeat(64);
    await assert.rejects(read, new RegExp(`Legacy PR writer proof refused: changed retained file ${name.replaceAll(".", "\\.")}`));
  }));

  test(`legacy proof reader does not continue after malformed pinned ${name}`, async (t) => withArchive(t, async ({ directory, input, read }) => {
    await writeFile(join(directory, name), "{");
    input[field] = hash("{");
    await assert.rejects(read, SyntaxError);
  }));

  test(`legacy proof reader does not substitute for missing ${name}`, async (t) => withArchive(t, async ({ directory, read }) => {
    await rename(join(directory, name), join(directory, name + ".saved"));
    await assert.rejects(read, { code: "ENOENT" });
  }));
}

test("caller-pinned outer documents do not authorize an unrecognized historical writer", async (t) => withArchive(t, async ({ directory, read }) => {
  await writeFile(join(directory, "runtime.input"), '{"callerClaimsKnownWriter":true}', { flag: "wx" });
  await assert.rejects(read, /Legacy PR writer proof refused: changed retained file runtime\.input/);
}));
