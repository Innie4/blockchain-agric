import { describe, expect, it } from "vitest";
import {
  databaseUnreachableMessage,
  mongoHost,
  pointsAtLoopback,
} from "../../src/config/database.js";

/**
 * What the operator is told when the database cannot be reached.
 *
 * The claim under test is that the reader is told what to actually do. The
 * previous wording told them to check a `.env` file and to start MongoDB, neither
 * of which is possible on a deployed service: the container has no `.env`, and no
 * database runs beside the process. Following that advice on a platform cannot
 * work, and it never names the thing that has to change.
 *
 * These are pure functions of the mode and the address, so they are asserted
 * directly rather than by provoking a real connection.
 */

describe("reading a connection string", () => {
  it("shows the host without the credentials or the database name", () => {
    expect(mongoHost("mongodb://user:secret@db.example.com:27017/agri_trace")).toBe(
      "db.example.com:27017"
    );
    expect(mongoHost("mongodb+srv://user:secret@cluster0.ab1cd.mongodb.net/agri")).toBe(
      "cluster0.ab1cd.mongodb.net"
    );
    expect(mongoHost("mongodb://127.0.0.1:27017")).toBe("127.0.0.1:27017");
  });

  it("recognises an address that points at the machine the process runs on", () => {
    for (const uri of [
      "mongodb://127.0.0.1:27017",
      "mongodb://localhost:27017",
      "mongodb://LOCALHOST:27017/agri",
      "mongodb://[::1]:27017",
    ]) {
      expect(pointsAtLoopback(uri), uri).toBe(true);
    }
  });

  it("recognises a hosted address, including one behind a proxy on the same host", () => {
    for (const uri of [
      "mongodb+srv://user:secret@cluster0.ab1cd.mongodb.net",
      "mongodb://db.example.com:27017/agri",
      "mongodb://10.0.0.5:27017",
    ]) {
      expect(pointsAtLoopback(uri), uri).toBe(false);
    }
  });
});

describe("the database failure message", () => {
  const DEAD_HOST = "mongodb://127.0.0.1:27099";

  it("tells a deployed operator to set an environment variable", () => {
    const message = databaseUnreachableMessage("production", DEAD_HOST);
    expect(message).toContain("MONGODB_URI");
    expect(message).toContain("environment variable");
    expect(message).toContain("hosted database");
  });

  it("does not tell a deployed operator to edit a file or start a local database", () => {
    const message = databaseUnreachableMessage("production", DEAD_HOST);
    // Neither is possible in a container, and following the advice cannot work.
    expect(message).not.toMatch(/\.env file/i);
    expect(message).not.toMatch(/that MongoDB is running/i);
    expect(message).not.toMatch(/localhost/i);
  });

  it("names the address it tried, so a wrong one is obvious", () => {
    expect(databaseUnreachableMessage("production", "mongodb://127.0.0.1:27098")).toContain(
      "27098"
    );
  });

  it("says the process will stop, so a crash loop is not a mystery", () => {
    expect(databaseUnreachableMessage("production", DEAD_HOST)).toMatch(/will stop/);
  });

  it("keeps a credential out of the message", () => {
    const message = databaseUnreachableMessage(
      "production",
      "mongodb://admin:hunter2@db.example.com:27017/agri"
    );
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("admin");
    // The host is still there, because that is what identifies the mistake.
    expect(message).toContain("db.example.com:27017");
  });

  it("gives a developer different advice, because a local database is correct there", () => {
    const message = databaseUnreachableMessage("development", DEAD_HOST);
    expect(message).toContain("Check MONGODB_URI");
    expect(message).not.toMatch(/hosted database/);
  });
});
