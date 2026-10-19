import fs from "node:fs/promises";
import path from "node:path";
import { openDatabase, setDatabase } from "../server/db.js";
import { config } from "../server/config.js";
import { upsertLinkedInUser } from "../server/users.js";

export async function freshDb() {
  await setDatabase(openDatabase(":memory:"));
}

export function makeUser(sub = "u1") {
  return upsertLinkedInUser({ sub, name: "Test User", email: null, picture: null }, null);
}

/** Puts a file into local storage the way a browser upload would. */
export async function storeFile(key: string, data: Buffer | string): Promise<void> {
  const file = path.join(config.uploadDir, ...key.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
