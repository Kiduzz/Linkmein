import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../server/config.js";

/** Empties local storage between tests. */
export async function freshStorage(): Promise<void> {
  await fs.rm(config.storageDir, { recursive: true, force: true });
}

/** Puts a file into local storage the way a browser upload would. */
export async function storeFile(key: string, data: Buffer | string): Promise<void> {
  const file = path.join(config.storageDir, ...key.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
