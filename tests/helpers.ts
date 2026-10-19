import { openDatabase, setDatabase } from "../server/db.js";
import { upsertLinkedInUser } from "../server/users.js";

export function freshDb() {
  const database = openDatabase(":memory:");
  setDatabase(database);
  return database;
}

export function makeUser(sub = "u1") {
  return upsertLinkedInUser({ sub, name: "Test User", email: null, picture: null }, null);
}
